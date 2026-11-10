import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Asset, type Bar, type BrokerAdapter, BrokerHttpError, type CalendarDay } from "../broker/port.js";
import { marketDate } from "../time.js";
import type { SimMarket } from "./sim-broker.js";

/**
 * The replay's market data (#57 T3): full adjusted daily bars, the market
 * calendar and asset facts, fetched once from Alpaca (market data only, with
 * the paper key) and cached on disk, so later replays run offline. A cached
 * range is refetched only when it doesn't cover what's asked; a file is
 * written only after its fetch succeeds, so a failure never caches a partial
 * result. Symbols without bars or an asset are reported, not dropped silently.
 */

export type MarketSource = Pick<BrokerAdapter, "getDailyBars" | "getCalendar" | "getAsset">;

/** How far before the replay's first session bars and sessions are loaded: strategy lookbacks (up to 252 sessions) and eligibility's history. */
export const LOOKBACK_DAYS = 400;
const BATCH = 20;

export interface MarketCacheOptions {
  dir: string;
  source: MarketSource;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface LoadedMarket {
  market: SimMarket;
  /** Symbols Alpaca had no bars for in the range, or no asset record (delisted, renamed, never listed). */
  missing: { bars: string[]; assets: string[] };
}

type CachedBars = { from: string; to: string; bars: [string, string, string, string, string, string][] };
type CachedCalendar = { from: string; to: string; days: [string, string, string][] };

const DAY_MS = 86_400_000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}

/** Write via a temp file and rename, so a crash mid-write never leaves a half file. */
function writeJson(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
}

export async function loadMarket(symbols: string[], from: string, to: string, opts: MarketCacheOptions): Promise<LoadedMarket> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => {});
  const start = shift(from, -LOOKBACK_DAYS);
  const unique = [...new Set(symbols)].sort();
  mkdirSync(join(opts.dir, "bars"), { recursive: true });

  // Calendar: one file, refetched when it doesn't cover the range.
  const calendarFile = join(opts.dir, "calendar.json");
  let calendar = readJson<CachedCalendar>(calendarFile);
  if (!calendar || calendar.from > start || calendar.to < to) {
    const days = await opts.source.getCalendar(start, to);
    calendar = { from: start, to, days: days.map((d) => [d.date, d.open.toISOString(), d.close.toISOString()]) };
    writeJson(calendarFile, calendar);
  }

  // Bars: one file per symbol, fetched in batches for the symbols whose cache doesn't cover the range.
  const barsFile = (s: string) => join(opts.dir, "bars", `${s.replace(/[^A-Z0-9.]/g, "_")}.json`);
  const stale = unique.filter((s) => {
    const cached = readJson<CachedBars>(barsFile(s));
    return !cached || cached.from > start || cached.to < to;
  });
  const fetchBatch = async (batch: string[]): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try {
        const got = await opts.source.getDailyBars(batch, new Date(`${start}T00:00:00Z`), new Date(`${to}T23:59:59Z`));
        for (const s of batch) {
          writeJson(barsFile(s), { from: start, to, bars: (got[s] ?? []).map((b) => [marketDate(b.t), b.o, b.h, b.l, b.c, b.v]) } satisfies CachedBars);
        }
        return;
      } catch (e) {
        if (e instanceof BrokerHttpError && e.status === 429) {
          log("rate limited; waiting 60s");
          await sleep(60_000);
        } else if (e instanceof BrokerHttpError && e.status === 400 && batch.length > 1) {
          for (const s of batch) await fetchBatch([s]); // one bad symbol fails the batch
          return;
        } else if (e instanceof BrokerHttpError && e.status === 400) {
          writeJson(barsFile(batch[0]!), { from: start, to, bars: [] } satisfies CachedBars); // Alpaca has nothing for it
          return;
        } else if (e instanceof Error && e.name === "TimeoutError" && attempt < 3) {
          log(`timed out on ${batch.length} symbols; retrying`);
          await sleep(5_000);
        } else throw e;
      }
    }
  };
  for (let i = 0; i < stale.length; i += BATCH) {
    await fetchBatch(stale.slice(i, i + BATCH));
    log(`bars: ${Math.min(i + BATCH, stale.length)}/${stale.length} fetched`);
  }

  // Asset facts: one file; a symbol Alpaca doesn't know is cached as null so it isn't asked again.
  const assetsFile = join(opts.dir, "assets.json");
  const assets = readJson<Record<string, Asset | null>>(assetsFile) ?? {};
  const unknown = unique.filter((s) => !(s in assets));
  for (const [i, s] of unknown.entries()) {
    for (;;) {
      try {
        assets[s] = await opts.source.getAsset(s);
        break;
      } catch (e) {
        if (!(e instanceof BrokerHttpError && e.status === 429)) throw e;
        writeJson(assetsFile, assets); // keep what's fetched so far
        log("rate limited; waiting 60s");
        await sleep(60_000);
      }
    }
    if ((i + 1) % 100 === 0) {
      writeJson(assetsFile, assets);
      log(`assets: ${i + 1}/${unknown.length} fetched`);
    }
  }
  if (unknown.length) writeJson(assetsFile, assets);

  const bars: Record<string, Bar[]> = {};
  const noBars: string[] = [];
  for (const s of unique) {
    const rows = readJson<CachedBars>(barsFile(s))!.bars.filter(([d]) => d >= start && d <= to);
    if (rows.length === 0) noBars.push(s);
    bars[s] = rows.map(([d, o, h, l, c, v]) => ({ t: new Date(`${d}T05:00:00Z`), o, h, l, c, v }));
  }
  const days: CalendarDay[] = calendar.days.filter(([d]) => d >= start && d <= to).map(([date, open, close]) => ({ date, open: new Date(open), close: new Date(close) }));
  return {
    market: { bars, calendar: days, assets: Object.fromEntries(unique.flatMap((s) => (assets[s] ? [[s, assets[s]!]] : []))) },
    missing: { bars: noBars, assets: unique.filter((s) => !assets[s]) },
  };
}
