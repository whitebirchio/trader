import {
  STRATEGY_JSON_SCHEMA,
  type ToolDeps,
  checkEligibility,
  getActivity,
  getHoldings,
  getOverview,
  getPrices,
  getRules,
  getStrategy,
  getTrackRecord,
  previewStrategy,
  submitStrategyTool,
} from "@trader/core";
import { RpcCode, RpcException } from "./protocol.js";

/**
 * The tool registry (SPEC-agent). Each tool is a thin call into
 * @trader/core's agent tools. The only write is submit_strategy. There is no
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
      "Positions, FIFO tax lots, open wash-sale windows (recent sales at a loss, with when each window ends), and stopped thesis ids, which can never be reused.",
    inputSchema: schema({}),
    readOnly: true,
    handler: (deps) => getHoldings(deps),
  },
  {
    name: "get_activity",
    title: "Recent activity",
    description:
      "What happened recently: rebalance steps with the reason for each trade, orders and fills, risk clips and rejections, halts, and strategy submissions.",
    inputSchema: schema({ days: { type: "integer", minimum: 1, maximum: 90, default: 14, description: "How far back to look." } }),
    readOnly: true,
    handler: (deps, args) => getActivity(deps, intArg(args, "days")),
  },
  {
    name: "get_track_record",
    title: "Track record",
    description:
      "Every thesis ever held, scored: its return on the dollars bought (realized, unrealized and dividends) vs the same dollars held in VTI over the same days (each buy buys VTI at that day's close, each sell sells the same fraction), with how it ended (open, removed, stopped, stale) and days held. Rolled up overall and by primary evidence kind (the most frequent kind in its evidence). Use it to see which kinds of signal have beaten VTI. A handful of theses held for days is noise, not a verdict.",
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
      "Risk's verdict on buying each symbol, with the reasons for any rejection (leveraged or inverse, price, liquidity, listing age, not fractionable), and whether it's exempt from the 20% per-name cap. Its `signals` are the owner's screens: the 12-1 month return (`momentum12to1Pct`; `recentBigLoser` at −30% or worse) and the last earnings release from SEC filings (`lastEarnings`: reaction vs VTI and sessions since; `freshEarningsCrash` at −10% or worse within 10 sessions). Check candidates before drafting.",
    inputSchema: schema({ symbols: symbolsProp }, ["symbols"]),
    readOnly: true,
    handler: (deps, args) => checkEligibility(deps, symbolsArg(args)),
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
      "Validate a draft and run it through the real pipeline on current data: thesis states, ranking, targets, the sells-first plan, and risk. Returns the validation errors, or the trades the next rebalance step would make and risk's verdict on each, with each sell's estimated realized gain (short- and long-term, FIFO) and any wash-sale window it opens. While a withdrawal is open, it plans for the smaller account. Records nothing and orders nothing. Always run this before submit_strategy.",
    inputSchema: schema({ strategy: strategyProp }, ["strategy"]),
    readOnly: true,
    handler: (deps, args) => previewStrategy(deps, strategyArg(args)),
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
