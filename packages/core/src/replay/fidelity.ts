import { add, compare, div, mul, round, sub, toBig } from "../money.js";
import { type IndexFlow, buildIndex } from "../risk/equity-index.js";
import { marketDate } from "../time.js";
import type { AccountHistory } from "./timeline.js";

/**
 * The fidelity check (#57 T6): a replay of an account's own history set
 * against what the account actually did, so the replay's known
 * simplifications are measured rather than assumed. Fills are compared per
 * session, symbol and side, and each difference is put down to a stated
 * assumption where one explains it:
 *   matched      the same trade on the same day; price and size differ by the
 *                fill model (the open ± slippage vs the live trade) and the
 *                account's value at the time
 *   shifted      the same trade a session or two apart: step timing
 *   small        a top-up below the size that matters: live rebalances every
 *                15 minutes against moving prices, the replay sees one price
 *                a session, so drift trades differ
 *   unexplained  anything else, including a matched trade whose price is
 *                further off than the fill model explains: look into it
 */

export type FillGapKind = "matched" | "shifted" | "small" | "unexplained";

export interface FillDay {
  date: string;
  symbol: string;
  side: string;
  qty: string;
  notional: string;
  /** Average price, Σ notional / Σ qty. */
  price: string;
}

export interface FillComparison {
  kind: FillGapKind;
  symbol: string;
  side: string;
  live: FillDay | null;
  replay: FillDay | null;
  /** Replay's average price vs live's, %; matched and shifted only. */
  priceGapPct: string | null;
  /** Replay's notional vs live's, %; matched and shifted only. */
  notionalGapPct: string | null;
  /** Sessions from the live trade to the replay's (negative: the replay was earlier); null for a one-sided trade. */
  sessionsLate: number | null;
  explanation: string;
}

export interface ThesisEventComparison {
  kind: string;
  thesisId: string;
  symbol: string;
  live: string | null;
  replay: string | null;
  explained: boolean;
  explanation: string;
}

export interface Fidelity {
  from: string;
  to: string;
  /** Fills under this notional count as small. */
  smallUsd: string;
  equity: { date: string; live: string; replay: string; gapPct: string }[];
  /** Flow-adjusted return over the window, %; null without two snapshots. */
  returns: { live: string | null; replay: string | null };
  fills: FillComparison[];
  thesisEvents: ThesisEventComparison[];
  /** Gaps no stated assumption explains: fills and thesis events. */
  unexplained: number;
  notes: string[];
}

export interface FidelityInput {
  live: AccountHistory;
  replay: AccountHistory;
  /** The account's transfers, for the flow-adjusted returns. */
  flows: IndexFlow[];
  /** The replay's sessions, YYYY-MM-DD, oldest first. */
  sessions: string[];
}

/** A matched trade's price further off than this is more than the fill model explains. */
export const MAX_PRICE_GAP_PCT = "5";
/** A trade within this many sessions of its counterpart counts as shifted. */
const SHIFT_SESSIONS = 2;
/** Small trades: under this share of the average live equity, and never under $5. */
const SMALL_SHARE = "0.02";
const SMALL_FLOOR = "5";

const pctGap = (replay: string, live: string) => (compare(live, "0") === 0 ? null : round(mul(sub(div(replay, live, 12, "half-even"), "1"), "100"), 2, "half-even"));
const abs = (v: string) => (v.startsWith("-") ? v.slice(1) : v);

function fillDays(history: AccountHistory, inWindow: (date: string) => boolean): FillDay[] {
  const days = new Map<string, FillDay>();
  for (const f of history.fills) {
    const date = marketDate(f.at);
    if (!inWindow(date)) continue;
    const key = `${date}|${f.symbol}|${f.side}`;
    const day = days.get(key) ?? { date, symbol: f.symbol, side: f.side, qty: "0", notional: "0", price: "0" };
    day.qty = add(day.qty, f.qty);
    day.notional = add(day.notional, mul(f.qty, f.price));
    days.set(key, day);
  }
  return [...days.values()].map((d) => ({ ...d, notional: round(d.notional, 2, "half-even"), price: div(d.notional, d.qty, 4, "half-even") }));
}

/** Flow-adjusted return over the window, from the last snapshot before it (the base) through its end. */
function windowReturn(snapshots: AccountHistory["snapshots"], flows: IndexFlow[], from: string, to: string): string | null {
  const upTo = snapshots.filter((s) => s.tradingDate <= to);
  const base = [...upTo].reverse().find((s) => s.tradingDate < from);
  const used = base ? upTo.filter((s) => s.tradingDate >= base.tradingDate) : upTo;
  const points = buildIndex(used, flows).points;
  if (points.length < 2) return null;
  return pctGap(points.at(-1)!.index, points[0]!.index);
}

export function compareFidelity(input: FidelityInput): Fidelity {
  const from = input.sessions[0]!;
  const to = input.sessions.at(-1)!;
  const inWindow = (date: string) => date >= from && date <= to;
  const sessionIndex = new Map(input.sessions.map((d, i) => [d, i]));
  const notes: string[] = [];

  const liveSnaps = input.live.snapshots.filter((s) => inWindow(s.tradingDate));
  const funded = liveSnaps.filter((s) => compare(s.equity, "0") > 0);
  const averageLive = funded.length ? div(funded.reduce((s, x) => add(s, x.equity), "0"), String(funded.length), 2, "half-even") : "0";
  const share = round(mul(averageLive, SMALL_SHARE), 2, "half-even");
  const smallUsd = compare(share, SMALL_FLOOR) > 0 ? share : SMALL_FLOOR;

  const replaySnaps = new Map(input.replay.snapshots.map((s) => [s.tradingDate, s.equity]));
  const equity = liveSnaps.flatMap((s) => {
    const replay = replaySnaps.get(s.tradingDate);
    return replay === undefined ? [] : [{ date: s.tradingDate, live: s.equity, replay, gapPct: pctGap(replay, s.equity) ?? "0" }];
  });

  if (input.live.fills.some((f) => marketDate(f.at) < from)) notes.push(`The account traded before ${from}, so it started the window holding positions the replay didn't.`);

  // Fills: same session first, then the nearest counterpart within a couple of sessions, then by size.
  const live = fillDays(input.live, inWindow);
  const replay = fillDays(input.replay, inWindow);
  const key = (d: FillDay) => `${d.date}|${d.symbol}|${d.side}`;
  const replayByKey = new Map(replay.map((d) => [key(d), d]));
  const fills: FillComparison[] = [];
  const liveLeft: FillDay[] = [];
  for (const l of live) {
    const r = replayByKey.get(key(l));
    if (!r) {
      liveLeft.push(l);
      continue;
    }
    replayByKey.delete(key(l));
    const priceGapPct = pctGap(r.price, l.price);
    const tooFar = priceGapPct !== null && compare(abs(priceGapPct), MAX_PRICE_GAP_PCT) > 0;
    fills.push({
      kind: tooFar ? "unexplained" : "matched",
      symbol: l.symbol,
      side: l.side,
      live: l,
      replay: r,
      priceGapPct,
      notionalGapPct: pctGap(r.notional, l.notional),
      sessionsLate: 0,
      explanation: tooFar ? `price ${priceGapPct}% off: more than the fill model (the open ± slippage) explains` : "same trade, same session",
    });
  }
  const replayLeft = [...replayByKey.values()];
  for (const l of liveLeft) {
    const li = sessionIndex.get(l.date) ?? 0;
    const near = replayLeft
      .filter((r) => r.symbol === l.symbol && r.side === l.side && Math.abs((sessionIndex.get(r.date) ?? 0) - li) <= SHIFT_SESSIONS)
      .sort((a, b) => Math.abs((sessionIndex.get(a.date) ?? 0) - li) - Math.abs((sessionIndex.get(b.date) ?? 0) - li))[0];
    if (near) {
      replayLeft.splice(replayLeft.indexOf(near), 1);
      const late = (sessionIndex.get(near.date) ?? 0) - li;
      fills.push({ kind: "shifted", symbol: l.symbol, side: l.side, live: l, replay: near, priceGapPct: pctGap(near.price, l.price), notionalGapPct: pctGap(near.notional, l.notional), sessionsLate: late, explanation: `${Math.abs(late)} session(s) ${late > 0 ? "later" : "earlier"} in the replay: step timing` });
    } else fills.push(oneSided(l, null, smallUsd));
  }
  for (const r of replayLeft) fills.push(oneSided(null, r, smallUsd));
  fills.sort((a, b) => (a.live ?? a.replay)!.date.localeCompare((b.live ?? b.replay)!.date) || a.symbol.localeCompare(b.symbol));

  // Thesis events, by kind and thesis id.
  const eventDates = (h: AccountHistory) => new Map(h.thesisEvents.filter((e) => inWindow(marketDate(e.at))).map((e) => [`${e.kind}|${e.thesisId}`, { ...e, date: marketDate(e.at) }]));
  const liveEvents = eventDates(input.live);
  const replayEvents = eventDates(input.replay);
  const thesisEvents: ThesisEventComparison[] = [...new Set([...liveEvents.keys(), ...replayEvents.keys()])].map((k) => {
    const l = liveEvents.get(k);
    const r = replayEvents.get(k);
    const e = (l ?? r)!;
    const base = { kind: e.kind, thesisId: e.thesisId, symbol: e.symbol, live: l?.date ?? null, replay: r?.date ?? null };
    if (l && r) return { ...base, explained: true, explanation: l.date === r.date ? "same session" : "different session: step timing" };
    if (e.kind === "stopped") return { ...base, explained: true, explanation: l ? "live saw a price through the stop that the replay's open didn't" : "the replay's open went through the stop; live's prices didn't" };
    return { ...base, explained: false, explanation: `only ${l ? "live" : "the replay"} recorded it` };
  });

  return {
    from,
    to,
    smallUsd,
    equity,
    returns: { live: windowReturn(input.live.snapshots, input.flows, from, to), replay: windowReturn(input.replay.snapshots, input.flows, from, to) },
    fills,
    thesisEvents,
    unexplained: fills.filter((f) => f.kind === "unexplained").length + thesisEvents.filter((e) => !e.explained).length,
    notes,
  };
}

function oneSided(live: FillDay | null, replay: FillDay | null, smallUsd: string): FillComparison {
  const day = (live ?? replay)!;
  const small = compare(day.notional, smallUsd) <= 0;
  return {
    kind: small ? "small" : "unexplained",
    symbol: day.symbol,
    side: day.side,
    live,
    replay,
    priceGapPct: null,
    notionalGapPct: null,
    sessionsLate: null,
    explanation: `only ${live ? "live" : "the replay"} traded it${small ? ": a small drift trade (live rebalances every 15 minutes against moving prices)" : ""}`,
  };
}

const usd = (v: string) => `$${toBig(v).toFixed(2)}`;
const signed = (v: string | null) => (v === null ? "-" : v.startsWith("-") ? `${v}%` : `+${v}%`);

/** The fidelity write-up as plain text. It holds live figures: keep it in .cache/replay/. */
export function formatFidelity(f: Fidelity): string {
  const lines: string[] = [];
  const section = (title: string) => lines.push("", title);
  const counts = (kind: FillGapKind) => f.fills.filter((x) => x.kind === kind).length;
  lines.push(`Fidelity: the replay vs the account, ${f.from} → ${f.to}`);
  lines.push(`  ${f.fills.length} trade-days compared: ${counts("matched")} matched, ${counts("shifted")} shifted, ${counts("small")} small, ${counts("unexplained")} unexplained; ${f.unexplained} gap(s) to look into`);
  for (const n of f.notes) lines.push(`  ! ${n}`);

  section("Return over the window (flow-adjusted)");
  lines.push(`  Live ${signed(f.returns.live)}   Replay ${signed(f.returns.replay)}`);

  section("Equity after each close");
  for (const e of f.equity) lines.push(`  ${e.date}  live ${usd(e.live).padStart(11)}  replay ${usd(e.replay).padStart(11)}  ${signed(e.gapPct)}`);

  const describe = (d: FillDay | null) => (d ? `${d.date} ${d.side.padEnd(4)} ${usd(d.notional).padStart(10)} @ ${d.price}` : "-");
  for (const kind of ["unexplained", "shifted", "small", "matched"] as FillGapKind[]) {
    const rows = f.fills.filter((x) => x.kind === kind);
    if (rows.length === 0) continue;
    section(`Trades: ${kind} (${rows.length})${kind === "small" ? `, under ${usd(f.smallUsd)}` : ""}`);
    for (const x of rows) {
      const gaps = x.priceGapPct !== null ? `  price ${signed(x.priceGapPct)}, size ${signed(x.notionalGapPct)}` : "";
      lines.push(`  ${x.symbol.padEnd(6)} live ${describe(x.live)}  |  replay ${describe(x.replay)}${gaps}`);
      if (kind !== "matched") lines.push(`         ${x.explanation}`);
    }
  }

  section("Thesis events");
  if (f.thesisEvents.length === 0) lines.push("  none on either side");
  for (const e of f.thesisEvents) lines.push(`  ${e.kind.padEnd(8)} ${e.symbol.padEnd(6)} live ${e.live ?? "-"}  replay ${e.replay ?? "-"}  ${e.explained ? "" : "! "}${e.explanation}`);

  section("How gaps are explained");
  lines.push("  matched: the same trade on the same day; the replay fills at the open ± slippage and sizes off its own equity.");
  lines.push(`  shifted: the same trade within ${SHIFT_SESSIONS} sessions; live steps every 15 minutes, the replay at 09:45, 10:00, 12:30 and 12:45.`);
  lines.push("  small: a one-sided drift top-up; live sees prices move through the day, the replay sees the open only.");
  lines.push(`  unexplained: anything else, or a matched price more than ${MAX_PRICE_GAP_PCT}% off. Each needs a reason or a bug.`);
  return `${lines.join("\n")}\n`;
}
