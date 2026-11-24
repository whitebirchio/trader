/**
 * Shared plumbing for the research scripts (research:insiders,
 * research:earnings): the git-ignored cache, logging, Alpaca daily bars
 * (paper keys, market data only) cached per symbol, and the report's tables
 * and writer. Read-only: no database, no orders.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { AlpacaBroker } from "../src/broker/alpaca.js";
import { BrokerHttpError } from "../src/broker/port.js";
import { type DailyBar, HORIZONS, type Horizon, type Tradability, bucketStats } from "../src/research/backtest.js";
import { LIMITS } from "../src/risk/limits.js";
import { readRepoEnv } from "./repo-env.js";

export const CACHE = join(dirname(fileURLToPath(import.meta.url)), "..", ".cache");
let secUserAgentValue: string | undefined;
/**
 * SEC asks automated clients to identify themselves as "name email"
 * (data.sec.gov refuses others); requests stay well under its 10/second. The
 * contact is the owner's to choose, so it's read from SEC_USER_AGENT (the
 * environment, else the repo's .env), never written in the code.
 */
export function secUserAgent(): string {
  if (secUserAgentValue) return secUserAgentValue;
  let value = process.env.SEC_USER_AGENT;
  if (!value) {
    try {
      value = readRepoEnv().get("SEC_USER_AGENT");
    } catch {
      // no .env: fall through to the error below
    }
  }
  if (!value?.trim()) throw new Error('SEC_USER_AGENT is not set. Add SEC_USER_AGENT="Your Name contact@example.com" to .env: SEC requires a real contact.');
  secUserAgentValue = value.trim();
  return secUserAgentValue;
}
const BARS_FROM = new Date("2017-06-01T00:00:00Z");
const BATCH = 20;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SEC refused a request (403 or 429): stop, keep what's cached, and resume later (#135). */
export class SecRefused extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`SEC refused ${url} (${status}). Everything fetched so far is cached: run the same command again later to resume.`);
  }
}

let nextSecSlot = 0;
let secRefused: SecRefused | null = null;
/**
 * At most 5 requests a second to SEC, under its 10/second limit, however many
 * callers run at once: each takes the next 200 ms slot before it waits. After
 * a refusal every later call fails with it, so parallel workers stop too.
 */
async function secFetch(url: string): Promise<Response> {
  if (secRefused) throw secRefused;
  const slot = Math.max(Date.now(), nextSecSlot);
  nextSecSlot = slot + 200;
  if (slot > Date.now()) await sleep(slot - Date.now());
  if (secRefused) throw secRefused;
  const res = await fetch(url, { headers: { "user-agent": secUserAgent() } });
  if (res.status === 403 || res.status === 429) throw (secRefused = new SecRefused(res.status, url));
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

/** Run `fn` over `items` with at most `workers` at a time (SEC requests still keep secFetch's pace). */
export async function inParallel<T>(items: T[], workers: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, run));
}

/** An SEC document as text, not cached: for a file read once and reduced (a daily index). */
export async function secGet(url: string): Promise<string> {
  return (await secFetch(url)).text();
}

/** A small SEC document as text, cached at `file` (refetched when older than `maxAgeDays`). */
export async function secText(url: string, file: string, maxAgeDays = Number.POSITIVE_INFINITY): Promise<string> {
  if (existsSync(file) && (Date.now() - statSync(file).mtimeMs) / 86_400_000 < maxAgeDays) return readFileSync(file, "utf8");
  const text = await (await secFetch(url)).text();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return text;
}

/** Download a large SEC file straight to disk (streamed, never held in memory); a no-op if it's there. */
export async function secDownload(url: string, file: string): Promise<void> {
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  const res = await secFetch(url);
  if (!res.body) throw new Error(`${url}: empty body`);
  const part = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body as ReadableStream), createWriteStream(part));
  renameSync(part, file);
}
export const log = (msg: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

/** Risk's buy filters, as numbers for research. */
export const TRADABILITY: Tradability = { minPrice: Number(LIMITS.minPrice), minAvgDollarVolume: Number(LIMITS.minAvgDollarVolume), avgDollarVolumeDays: LIMITS.avgDollarVolumeDays };

let broker: AlpacaBroker | null = null;
function alpaca(): AlpacaBroker {
  const env = readRepoEnv();
  // Years of bars per request: a longer timeout than the engine's.
  return (broker ??= new AlpacaBroker({ env: "staging", keyId: env.require("STAGING_ALPACA_KEY_ID"), secretKey: env.require("STAGING_ALPACA_SECRET_KEY"), timeoutMs: 60_000 }));
}

/** Bars for each symbol from the cache, fetching the missing ones in batches. Symbols Alpaca has no bars for cache as []. */
export async function barsFor(symbols: string[]): Promise<Map<string, DailyBar[]>> {
  const dir = join(CACHE, "bars");
  mkdirSync(dir, { recursive: true });
  const file = (s: string) => join(dir, `${s}.json`);
  const missing = symbols.filter((s) => !existsSync(file(s)));
  const end = new Date();
  const fetchBatch = async (batch: string[]): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try {
        const got = await alpaca().getDailyBars(batch, BARS_FROM, end);
        for (const s of batch) writeFileSync(file(s), JSON.stringify((got[s] ?? []).map((b) => [b.t.toISOString().slice(0, 10), Number(b.c), Number(b.v)])));
        return;
      } catch (e) {
        if (e instanceof BrokerHttpError && e.status === 429) {
          log("rate limited; waiting 60s");
          await sleep(60_000);
        } else if (e instanceof BrokerHttpError && e.status === 400 && batch.length > 1) {
          for (const s of batch) await fetchBatch([s]); // one bad symbol fails the batch
          return;
        } else if (e instanceof BrokerHttpError && e.status === 400) {
          writeFileSync(file(batch[0]!), "[]");
          return;
        } else if (e instanceof Error && e.name === "TimeoutError" && attempt < 3) {
          log(`timed out on ${batch.length} symbols; retrying`);
          await sleep(5_000);
        } else throw e;
      }
    }
  };
  for (let i = 0; i < missing.length; i += BATCH) {
    await fetchBatch(missing.slice(i, i + BATCH));
    if (i % (BATCH * 10) === 0) log(`bars: ${Math.min(i + BATCH, missing.length)}/${missing.length} fetched`);
    await sleep(350);
  }
  return new Map(symbols.map((s) => [s, (JSON.parse(readFileSync(file(s), "utf8")) as [string, number, number][]).map(([date, close, volume]) => ({ date, close, volume }))]));
}

export const pct = (x: number | null, dp = 1) => (x === null ? "–" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(dp)}%`);

/** A report table: one row per bucket, excess return vs VTI at each horizon. */
export function table(groups: Map<string, { excess: Record<Horizon, number | null> }[]>): string {
  const lines = ["| Bucket | Events (60d) | 20d mean | 60d mean ± SE | 60d median | 60d beat VTI | 120d mean |", "|---|---:|---:|---:|---:|---:|---:|"];
  for (const [label, rows] of groups) {
    const [s20, s60, s120] = HORIZONS.map((h) => bucketStats(rows, h));
    lines.push(`| ${label} | ${s60!.n} | ${pct(s20!.mean)} | ${pct(s60!.mean)} ± ${pct(s60!.stdError).replace(/^[+−]/, "")} | ${pct(s60!.median)} | ${s60!.beatShare === null ? "–" : `${Math.round(s60!.beatShare * 100)}%`} | ${pct(s120!.mean)} |`);
  }
  return lines.join("\n");
}

/**
 * Write the report, keeping a hand-written summary above the marker line;
 * everything below it is regenerated. Without a path, print the tables.
 */
export function writeReport(path: string | undefined, command: string, body: string): void {
  if (!path) {
    console.log(body);
    return;
  }
  const marker = `<!-- generated by npm run ${command}: everything below is regenerated -->`;
  mkdirSync(dirname(path), { recursive: true });
  const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
  const head = previous.includes(marker) ? previous.slice(0, previous.indexOf(marker)) : "";
  writeFileSync(path, `${head}${marker}\n\n${body}\n`);
  log(`wrote ${path}`);
}
