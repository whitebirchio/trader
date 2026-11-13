import {
  STRATEGY_JSON_SCHEMA,
  type ToolDeps,
  checkEligibility,
  getActivity,
  getExposure,
  getHoldings,
  getOverview,
  getPrices,
  getRules,
  getStrategy,
  getTrackRecord,
  getWatchlist,
  previewStrategy,
  recordLessonTool,
  submitStrategyTool,
  updateWatchlistTool,
} from "@trader/core";
import { RpcCode, RpcException } from "./protocol.js";

/**
 * The tool registry (SPEC-agent). Each tool is a thin call into
 * @trader/core's agent tools. The writes are submit_strategy,
 * update_watchlist (research notes, #32) and record_lesson (post-mortems on
 * closed theses, #28), the last two with no trading effect. There is no
 * order, cancel or kill-switch tool (ADR-011), and a test pins this list.
 */

type Args = Record<string, unknown>;

export type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  handler: (deps: ToolDeps, args: Args) => Promise<unknown> | unknown;
};

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const symbolsProp = {
  type: "array",
  items: { type: "string" },
  minItems: 1,
  maxItems: 25,
  description: "Tickers, like AAPL or BRK.B (at most 25).",
};

const strategyProp = {
  ...STRATEGY_JSON_SCHEMA,
  description: "The complete strategy document. get_rules has every bound.",
};

function intArg(args: Args, name: string): number | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new RpcException(RpcCode.InvalidParams, `${name} must be a whole number`);
  return v;
}

function symbolsArg(args: Args): string[] {
  const v = args.symbols;
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) throw new RpcException(RpcCode.InvalidParams, "symbols must be a list of tickers");
  return v;
}

const watchChange = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["watch", "drop"], description: "watch: add the name, or replace its note; drop: take it off the list." },
    symbol: { type: "string", description: "A ticker, like AAPL or BRK.B." },
    why: { type: "string", description: "Why it's worth watching, or why it's dropped (10–600 characters)." },
    trigger: { type: "string", description: "watch only: what would make it a thesis, e.g. a dated catalyst or a filing (10–400 characters)." },
    revisitBy: { type: "string", description: "watch only: YYYY-MM-DD, after today and at most 120 days out." },
    forecast: {
      type: "object",
      description:
        "watch only, required for a name new to the list: your forecast for the stock you're passing on, scored against VTI like a thesis's (the forecast ledger). The first one for each stay on the list is scored; restating it later is optional.",
      properties: {
        beatVtiPct: { type: "integer", minimum: 5, maximum: 95, description: "The chance, in whole percent, that the stock beats VTI from now to the horizon." },
        expectedExcessPct: { type: "string", description: "The expected return against VTI over the window, in percentage points, as a decimal string (−50 to 200)." },
        horizon: { type: "string", description: "Optional YYYY-MM-DD, after today and at most 120 days out; defaults to revisitBy." },
      },
      required: ["beatVtiPct", "expectedExcessPct"],
      additionalProperties: false,
    },
  },
  required: ["action", "symbol", "why"],
  additionalProperties: false,
};

const lessonEntry = {
  type: "object",
  properties: {
    thesisId: { type: "string", description: "A closed thesis's id, from get_track_record's lessonsDue (or any closed row, to revise its lesson)." },
    expected: { type: "string", description: "What the thesis expected: its reason, and why the market was wrong (20–600 characters)." },
    happened: { type: "string", description: "What happened, and what drove the result (20–600 characters)." },
    lesson: { type: "string", description: "What to do differently next time, or why the result was luck rather than judgement (20–600 characters)." },
  },
  required: ["thesisId", "expected", "happened", "lesson"],
  additionalProperties: false,
};

function strategyArg(args: Args): unknown {
  if (!("strategy" in args)) throw new RpcException(RpcCode.InvalidParams, "strategy is required");
  return args.strategy;
}

export const TOOLS: Tool[] = [
  {
    name: "get_overview",
    title: "Portfolio overview",
    description:
      "Start here. Equity, cash, today's change and drawdown, performance vs VTI (time-weighted, plus money-weighted over the same close-to-close window: start value, net transfers, value at the latest close, and the same money held in VTI; and all-time net deposits), transfers since your last strategy and any open withdrawal request with the time to plan its funding by, guardrail state (kill switch, halt, buys paused, broker verdict), whether the market is open today and the rebalance window, the active strategy version, and holdings with their sleeve and thesis state.",
    inputSchema: schema({}),
    readOnly: true,
    handler: (deps) => getOverview(deps),
  },
  {
    name: "get_strategy",
    title: "Active strategy",
    description:
      "The active strategy document in full, with each thesis's live state (active, stopped or stale, with the reason) and the days since it was last reaffirmed. Theses go stale 30 days after the last submission.",
    inputSchema: schema({ version: { type: "integer", minimum: 0, description: "Omit for the active version (the only one served)." } }),
    readOnly: true,
    handler: (deps, args) => getStrategy(deps, intArg(args, "version")),
  },
  {
    name: "get_holdings",
    title: "Holdings, lots and wash-sale windows",
    description:
      "Positions, FIFO tax lots, open wash-sale windows (recent sales at a loss, with when each window ends), stopped thesis ids (never reusable), and each held thesis's sell-side signals: return since its first lot vs VTI, how far it is off its high since and above its stop, any earnings reaction since entry, check_eligibility's screens, its next earnings report (nextEarnings), its SEC filings since its first buy (filings, checked about hourly; filingsCheck says when), analysts' EPS estimates for the next quarter and fiscal year and how they moved (estimates, refreshed weekly), and flags (earnings_crash_since_entry, recent_big_loser, near_stop, lagging_vti, insider_selling and executive_departure from filings, estimates_falling, and earnings_soon for a report within 7 days). Re-judge every thesis with these each run; code doesn't sell on them.",
    inputSchema: schema({}),
    readOnly: true,
    handler: (deps) => getHoldings(deps),
  },
  {
    name: "get_activity",
    title: "Recent activity",
    description:
      "What happened recently: rebalance steps that traded, one line per trade with its reason and risk's verdict; orders and fills; risk clips and rejections; halts; and strategy submissions by version and headline (get_strategy has the full document). Steps that planned nothing are counted, with their notes.",
    inputSchema: schema({ days: { type: "integer", minimum: 1, maximum: 90, default: 14, description: "How far back to look." } }),
    readOnly: true,
    handler: (deps, args) => getActivity(deps, intArg(args, "days")),
  },
  {
    name: "get_track_record",
    title: "Track record",
    description:
      "Every thesis ever held, scored: its return on the dollars bought (realized, unrealized and dividends) vs the same dollars held in VTI over the same days (each buy buys VTI at that day's close, each sell sells the same fraction), with how it ended (open, removed, stopped, stale) and days held. Rolled up overall and by lead signal (each thesis's declared leadSignal; older rows without one are inferred from the most frequent kind in its evidence, marked kindSource: inferred). Use it to see which kinds of signal have beaten VTI. A handful of theses held for days is noise, not a verdict. Each closed thesis carries its post-mortem (lesson); lessonsDue lists the closed ones still waiting for one (write it with record_lesson). `forecasts` is the forecast ledger: how your forecasts on theses and watchlist names have resolved against VTI (Brier score, skill against the 45% base rate, reliability by bucket, expected vs realized excess), whether what you bought beat what you passed on after 20 and 60 sessions, which forecasts are still open, and each resolved one (latest first: what you said, whether it beat VTI, by how much); backfilled ones are kept out of the headline, and below 30 resolved it says too few to judge.",
    inputSchema: schema({}),
    readOnly: true,
    handler: (deps) => getTrackRecord(deps),
  },
  {
    name: "get_prices",
    title: "Daily prices",
    description: "Daily adjusted closes and volume for up to 25 symbols over up to 2 years, for your own analysis (momentum, drawdowns, entry points).",
    inputSchema: schema({ symbols: symbolsProp, days: { type: "integer", minimum: 5, maximum: 730, default: 365 } }, ["symbols"]),
    readOnly: true,
    handler: (deps, args) => getPrices(deps, symbolsArg(args), intArg(args, "days")),
  },
  {
    name: "check_eligibility",
    title: "Risk eligibility",
    description:
      "Risk's verdict on buying each symbol, with the reasons for any rejection (leveraged or inverse, price, liquidity, listing age, not fractionable), and whether it's exempt from the 20% per-name cap. Its `signals` are the owner's screens: the 12-1 month return (`momentum12to1Pct`; `recentBigLoser` at −30% or worse) and the last earnings release from SEC filings (`lastEarnings`: reaction vs VTI and sessions since; `freshEarningsCrash` at −10% or worse within 10 sessions), and `nextEarnings`, the next announced report (null until the company announces it, usually two to four weeks ahead). `pastLessons` are your post-mortems on past theses in the symbol (record_lesson). Check candidates before drafting.",
    inputSchema: schema({ symbols: symbolsProp }, ["symbols"]),
    readOnly: true,
    handler: (deps, args) => checkEligibility(deps, symbolsArg(args)),
  },
  {
    name: "get_exposure",
    title: "Concentration",
    description:
      "How concentrated the account is: each holding's weight, SEC industry (SIC) and an approximate sector; the sector weights (VTI counts as the broad market); and the 60-session daily-return correlations among single names, listing pairs at 0.5 or more, with `oneBet` at 0.7 or more (largely one bet), and each name's correlation with VTI. Active theses not bought yet are measured too; pass `symbols` to add candidates and check a draft before you submit it.",
    inputSchema: schema({ symbols: { ...symbolsProp, description: "Candidates to measure alongside the holdings (optional, at most 25)." } }),
    readOnly: true,
    handler: (deps, args) => getExposure(deps, args.symbols === undefined ? [] : symbolsArg(args)),
  },
  {
    name: "get_rules",
    title: "The rules",
    description: "The contract a strategy is written against: every schema bound, how the sleeves are allocated, the thesis lifecycle, risk's limits, and when trades execute.",
    inputSchema: schema({}),
    readOnly: true,
    handler: () => getRules(),
  },
  {
    name: "preview_strategy",
    title: "Preview a strategy",
    description:
      "Validate a draft and run it through the real pipeline on current data: thesis states, ranking, targets, the sells-first plan, and risk. Returns the validation errors, or the trades the next rebalance step would make and risk's verdict on each, with each sell's estimated realized gain (short- and long-term, FIFO) and any wash-sale window it opens. While a withdrawal is open, it plans for the smaller account. Its `warnings` name any thesis without a plainSummary. Records nothing and orders nothing. Always run this before submit_strategy.",
    inputSchema: schema({ strategy: strategyProp }, ["strategy"]),
    readOnly: true,
    handler: (deps, args) => previewStrategy(deps, strategyArg(args)),
  },
  {
    name: "get_watchlist",
    title: "Research watchlist",
    description:
      "Your research memory across runs: names you looked at but didn't buy, why, what would make each a thesis (its trigger), and when to look again. Soonest revisit first; `due` marks names past their revisit date, `nowThesis` names already in the strategy. Each name's SEC filings since it went on the list (filings) and analysts' EPS estimates (estimates, refreshed weekly), and what was dropped in the last 14 days. Read it before hunting for new ideas.",
    inputSchema: schema({}),
    readOnly: true,
    handler: (deps) => getWatchlist(deps),
  },
  {
    name: "update_watchlist",
    title: "Update the research watchlist",
    description:
      "Record names you researched but didn't buy, so the next run starts from them: `watch` adds a name or replaces its note (why, trigger, revisitBy, and a forecast on a new name); `drop` takes it off. All changes apply together, or none if any is invalid. It has no trading effect, and the owner sees each change in the daily digest.",
    inputSchema: schema({ changes: { type: "array", items: watchChange, minItems: 1, maxItems: 25, description: "At most 25 changes." } }, ["changes"]),
    readOnly: false,
    handler: (deps, args) => {
      if (!Array.isArray(args.changes)) throw new RpcException(RpcCode.InvalidParams, "changes must be a list");
      return updateWatchlistTool(deps, args.changes);
    },
  },
  {
    name: "record_lesson",
    title: "Record a lesson from a closed thesis",
    description:
      "Write a post-mortem on a thesis that has closed (left the strategy and sold out): what it expected, what happened, and what you'd do differently. The outcome it's judged against is stored with it, and later runs read it in get_track_record and in check_eligibility's pastLessons for the same symbol. get_track_record's lessonsDue lists the theses waiting for one. A later lesson on the same thesis replaces it. All lessons apply together, or none if any is invalid. It has no trading effect, and the owner sees each lesson in the daily digest.",
    inputSchema: schema({ lessons: { type: "array", items: lessonEntry, minItems: 1, maxItems: 10, description: "At most 10 lessons." } }, ["lessons"]),
    readOnly: false,
    handler: (deps, args) => {
      if (!Array.isArray(args.lessons)) throw new RpcException(RpcCode.InvalidParams, "lessons must be a list");
      return recordLessonTool(deps, args.lessons);
    },
  },
  {
    name: "submit_strategy",
    title: "Submit a strategy",
    description:
      "Validate the draft and store it as the next strategy version. It's active from the next rebalance step, and the owner is emailed. If it's rejected, the previous version stays in force and the errors are returned. Resubmitting unchanged reaffirms every thesis. This is the only way your decisions reach the market: every order still passes risk.",
    inputSchema: schema({ strategy: strategyProp }, ["strategy"]),
    readOnly: false,
    handler: (deps, args) => submitStrategyTool(deps, strategyArg(args)),
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Shape the MCP `tools/list` result expects. */
export const toolDescriptors = () =>
  TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly, openWorldHint: false },
  }));

const isRecord = (v: unknown): v is Args => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Run one tool. Unknown tools and malformed arguments are protocol errors.
 * A tool's own `{ error }` answer is reported as a tool error, so the model
 * adapts instead of reading it as data.
 */
export async function callTool(name: string, rawArgs: unknown, deps: () => Promise<ToolDeps>) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new RpcException(RpcCode.InvalidParams, `Unknown tool: ${name}`);
  if (rawArgs !== undefined && !isRecord(rawArgs)) throw new RpcException(RpcCode.InvalidParams, "arguments must be an object");
  const args = rawArgs ?? {};
  const data = await tool.handler(await deps(), args);
  const isError = isRecord(data) && typeof data.error === "string";
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], ...(isError ? { isError: true } : {}) };
}
