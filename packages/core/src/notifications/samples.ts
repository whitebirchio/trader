import { activationPayload } from "../portfolio/store.js";
import type { Strategy } from "../portfolio/strategy.js";
import type { NotifiableEvent } from "./compose.js";

/**
 * Sample emails for `notify:preview --sample` and `notify:test --sample`, and
 * the compose tests: the v21 activation as it was recorded on 2026-11-13, the
 * same version written in today's summary format, a made-up version that
 * changes things, and a messy tick. No database. Not imported by the Lambda.
 */

type Thesis = Strategy["conviction"][number];

const thesis = (t: Pick<Thesis, "id" | "symbol" | "targetWeightPct" | "stopLossPct" | "reviewBy" | "plainSummary"> & { beatVtiPct: number }): Thesis => ({
  id: t.id,
  symbol: t.symbol,
  targetWeightPct: t.targetWeightPct,
  thesis: `${t.symbol}: the full reasoning lives in the strategy document.`,
  evidence: [{ kind: "insider", summary: "Open-market purchases by company insiders." }],
  stopLossPct: t.stopLossPct,
  reviewBy: t.reviewBy,
  plainSummary: t.plainSummary,
  leadSignal: "insider",
  forecast: { beatVtiPct: t.beatVtiPct, expectedExcessPct: "0", horizon: t.reviewBy },
});

const systematic: Strategy["systematic"] = { universe: ["VTI"], lookbackDays: 126, skipRecentDays: 21, topN: 1, trendFilterDays: null, weighting: "equal", volatilityDays: 63, defensive: null };
const drift: Strategy["drift"] = { relativePct: "20", minTradeUsd: "10" };

/** v21's summary as Claude wrote it (three paragraphs). */
export const V21_SUMMARY = `Version 21: Keep (12:00 ET retry, Fri Nov 13). Reaffirmed: no material change since v20 was submitted at 11:50 ET. Same five theses, weights, stops and review dates; LKQ stays exited (its remaining shares sell on the next rebalance steps; today's small LKQ buy can't be sold today).

Re-judged each as if buying today: TTMI 8% (estimates_falling narrow, full year rising; held), BA 7% (insider_selling and estimates_falling already weighed in the cut to 7%; weakest link, next exit candidate), LSTR 8% (no flags; held), INTC 5% (the freshEarningsCrash is the Oct 30 drop we bought after; +9.9 pts vs VTI; held), AN 5% (estimates_falling is the per-unit squeeze the bear case names; starter size; held). No new filings since this morning, no thesis near its stop, no earnings within a week.

Book: conviction 33%, all insider-led, which can only be fixed by adding theses led by something else; the Q3 13Fs (Nov 16) are the next source. Shared failure: an AI-hardware growth scare (TTMI, INTC, one 13% bet) and cyclicals (BA, LSTR, AN). Room: ~67% in VTI because no non-insider idea met the bar. Watchlist unchanged.`;

/** The same run in the summary format the routine prompt asks for from 2026-11-15. */
export const V21_SUMMARY_LINES = `Reaffirmed: no material change since v20 (11:50 ET). LKQ stays exited; its last shares sell on the next rebalance steps.
TTMI: held. The estimate cut is narrow, and the full-year forecast is still rising.
BA: held at 7%. The insider sale and falling estimates were already weighed in the cut to 7%; it's the weakest link and the next exit candidate.
LSTR: held. No flags.
INTC: held. The earnings-crash flag is the Oct 30 drop we bought after; it's 9.9 points ahead of VTI since.
AN: held at starter size. Falling estimates are the per-unit squeeze the bear case already names.
Book: 33% in theses, all led by insider buying. Only theses led by something else fix that; the Q3 13F filings (Nov 16) are the next source. About 67% stays in VTI because no other idea met the bar.
Shared failure: an AI-hardware growth scare (TTMI and INTC, one 13% bet) and cyclicals (BA, LSTR, AN).
No new filings since this morning, no thesis near its stop, no earnings within a week. Watchlist unchanged.`;

/** v21's theses, with plain summaries as written (`withStops`) or as the prompt asks from 2026-11-15 (no stop or review sentence: the card shows both). */
function v21Theses(withStops: boolean): Thesis[] {
  const plain = (text: string, stop: string) => (withStops ? `${text} ${stop}` : text);
  return [
    thesis({
      id: "ttmi-insider-2026q4", symbol: "TTMI", targetWeightPct: "8", stopLossPct: "25", reviewBy: "2026-12-14", beatVtiPct: 50,
      plainSummary: plain("TTM makes circuit boards for AI data centers and defense. Sales are up 60% and next year's earnings forecast puts the stock under 8 times earnings, but it fell by more than half on debt worries and a broad AI-hardware selloff. Three company leaders bought shares with their own money, two of them adding more after the drop. We're wrong if the company cuts its 2027 forecast or has trouble with its debt.", "We sell if it closes 25% below what we paid. We re-check it by Dec 14."),
    }),
    thesis({
      id: "ba-director-buys-2026q4", symbol: "BA", targetWeightPct: "7", stopLossPct: "15", reviewBy: "2026-12-16", beatVtiPct: 46,
      plainSummary: plain("Boeing is generating cash again and has a record order backlog, but the stock fell when a production increase slipped to 2027. Two respected outside directors then bought shares with their own money. Since then analysts cut their profit forecasts and a senior executive sold some shares, so we made the position smaller. We're wrong if cash flow turns negative or regulators cap production again.", "We sell if it closes 15% below what we paid, and re-check it by Dec 16."),
    }),
    thesis({
      id: "lstr-ceo-buy-2026q4", symbol: "LSTR", targetWeightPct: "8", stopLossPct: "15", reviewBy: "2026-12-16", beatVtiPct: 52,
      plainSummary: plain("Landstar arranges truck freight using independent owner-drivers. Revenue is up 25% as the trucking slump ends, but the stock fell 18% because of a jump in insurance and accident-claim costs, much of it a one-time catch-up. The new CEO bought about $715,000 of stock with his own money. We're wrong if claim costs keep climbing next quarter or freight volumes fall again.", "We sell if it closes 15% below what we paid. We re-check it by Dec 16."),
    }),
    thesis({
      id: "intc-ceo-buy-2026q4", symbol: "INTC", targetWeightPct: "5", stopLossPct: "22", reviewBy: "2026-12-17", beatVtiPct: 48,
      plainSummary: plain("Intel's data-center and chip-manufacturing businesses are growing fast, but the stock fell about 37% after a weak forecast for the next quarter, blamed on slowing PC sales and chip shortages. The CEO then bought about $9.7 million of stock with his own money, and we paid less than he did. It's a small position because the outlook is uncertain. We're wrong if the next forecast is cut again or data-center growth stalls.", "We sell if it closes 22% below what we paid. We re-check it by Dec 17."),
    }),
    thesis({
      id: "an-officer-buys-2026q4", symbol: "AN", targetWeightPct: "5", stopLossPct: "15", reviewBy: "2026-12-18", beatVtiPct: 46,
      plainSummary: plain("AutoNation is a large car-dealer chain that earns steady profits from repairs and parts and keeps buying back its own shares, so each share's earnings keep growing. The stock fell about 21% after a September warning, but results came in better than feared, and the CEO, CFO, general counsel and a director all bought shares with their own money. We're wrong if earnings per share start falling, losses on its car loans jump, or buybacks slow.", "We sell if it closes 15% below what we paid. We re-check it by Dec 18."),
    }),
  ];
}

const doc = (summary: string, conviction: Thesis[]): Strategy => ({ summary, conviction, systematic, drift });
const at = (iso: string) => new Date(iso);

/** v21 as recorded on 2026-11-13, before cards and changes: the email that prompted the redesign. */
export function v21AsRecorded(): NotifiableEvent {
  const theses = v21Theses(true);
  return {
    kind: "strategy.activated",
    subject: "v21",
    at: at("2026-11-13T17:31:37Z"),
    payload: {
      version: 21,
      authoredBy: "claude",
      summary: V21_SUMMARY,
      theses: 5,
      convictionPct: "33",
      plain: theses.map((t) => ({ symbol: t.symbol, targetWeightPct: t.targetWeightPct, text: t.plainSummary })),
      topN: 1,
      universeSize: 1,
    },
  };
}

/** v21 with today's payload. `lines`: Claude wrote the summary in the new format. */
export function v21Reaffirmed(lines = true): NotifiableEvent {
  const prev = doc("v20", v21Theses(!lines));
  const next = doc(lines ? V21_SUMMARY_LINES : V21_SUMMARY, v21Theses(!lines));
  return { kind: "strategy.activated", subject: "v21", at: at("2026-11-13T17:31:37Z"), payload: activationPayload(next, 21, "claude", { version: 20, strategy: prev }) };
}

/** A made-up v22 that changes things: BA exited, TTMI raised, a new thesis, LSTR's review moved. A sample, not a forecast. */
export function v22Changed(): NotifiableEvent {
  const prev = doc("v21", v21Theses(false));
  const theses = v21Theses(false)
    .filter((t) => t.symbol !== "BA")
    .map((t) => (t.symbol === "TTMI" ? { ...t, targetWeightPct: "10" } : t.symbol === "LSTR" ? { ...t, reviewBy: "2027-01-08" } : t));
  theses.push(
    thesis({
      id: "sample-new-2026q4", symbol: "SMPL", targetWeightPct: "6", stopLossPct: "18", reviewBy: "2027-01-22", beatVtiPct: 58,
      plainSummary: "SAMPLE: a made-up thesis that shows how a new position looks. It would say what the company does, why we think it beats the market from here, and what would tell us we're wrong.",
    }),
  );
  const summary = `SAMPLE (not a real run): exited BA on the second insider sale, added SMPL, raised TTMI to 10% on the raised guide.
TTMI: raised to 10%. The company raised its 2027 guide, and the stock is still under 8 times next year's earnings.
LSTR: held; review moved to Jan 8 on the December claims update.
SMPL: new at 6%, a starter until the next filing confirms it.
INTC: held. No new flags.
AN: held. No new flags.
Book: 34% in theses across four names, two of them now not insider-led.
BA: exited. A second officer sold outside a trading plan, the sell signal its thesis named.`;
  return { kind: "strategy.activated", subject: "v22", at: at("2026-11-16T13:12:00Z"), payload: activationPayload(doc(summary, theses), 22, "claude", { version: 21, strategy: prev }) };
}

/** A messy tick: a halt, a stop-loss sale and a broker check in one email. */
export function messyTick(): NotifiableEvent[] {
  const t = at("2026-11-16T15:30:00Z");
  return [
    { kind: "thesis.stopped_out", subject: "INTC", at: t, payload: { thesisId: "intc-ceo-buy-2026q4", trigger: "stopped_out", reason: "INTC closed at $45.10, at or below its 22% stop ($45.40 vs $58.20 average cost)" } },
    { kind: "broker.config_unsafe", subject: null, at: t, payload: { reasons: ["margin multiplier 2 (must be 1)", "shorting enabled (must be off)"] } },
    { kind: "risk.halted", subject: null, at: t, payload: { reason: "the account is down 20.08% from its peak (limit 20%)" } },
  ];
}

/** Every sample, by name: each is one urgent email's events. */
export const SAMPLES: Record<string, () => NotifiableEvent[]> = {
  "strategy-v21-as-recorded": () => [v21AsRecorded()],
  "strategy-v21-reaffirmed": () => [v21Reaffirmed(true)],
  "strategy-v21-old-summary": () => [v21Reaffirmed(false)],
  "strategy-v22-changed": () => [v22Changed()],
  "messy-tick": messyTick,
};
