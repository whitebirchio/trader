/**
 * Every term the dashboard explains (SPEC-dashboard Amendment 3), in one
 * place: each figure's ⓘ reads its entry here, and /help lists them all. A
 * term an ⓘ names must be a key here: the type checks it.
 */
export const GLOSSARY = {
  todayMove: {
    term: "Today's move",
    text: "What the account made or lost in the last session, from the previous close, with any deposit that day left out. On a weekend or holiday it's the last session.",
  },
  pnl: {
    term: "Made or lost",
    text: "The account's value at the end of the range, less its value at the start, less any money you added (or plus any you took out). It's the dollars the investments earned.",
  },
  vsVti: {
    term: "Against VTI",
    text: "What the same money would have done held in VTI, the total US stock market fund Trader is trying to beat, over the same days, with your deposits and withdrawals bought and sold at the same times. Ahead means Trader did better.",
  },
  returnPct: {
    term: "Return",
    text: "The percentage gain over the range, flow-adjusted: deposits and withdrawals are taken out, so adding money doesn't count as a gain. It's the figure to compare with VTI's.",
  },
  gapPts: {
    term: "Points against VTI",
    text: "Trader's return minus VTI's, in percentage points. +2 pts means Trader returned 2% more than VTI over the same days.",
  },
  extendedHours: {
    term: "Pre-market and after hours",
    text: "Trading before 9:30 AM and after 4:00 PM ET. The move shown is indicative: few shares trade, prices are about 16 minutes behind, and it isn't added into the day's figures.",
  },
  afterClosePricing: {
    term: "After-close pricing",
    text: "Each evening, Alpaca values the account a few minutes after the close, sometimes at an after-hours trade rather than the official 4:00 PM price. Positions here use the official close, and this line is the difference, so everything adds up exactly. Usually cents.",
  },
  cashAndOther: {
    term: "Dividends, fees and rounding",
    text: "Money that moved cash without belonging to a position's price: dividends received, small regulatory fees, and rounding on fractional-share trades.",
  },
  headline: {
    term: "Headline",
    text: "The bet in one line, written by the research routine. Marked \"(summary)\" while it's still the first sentence of the plain-language summary, before the routine has written one.",
  },
  weight: {
    term: "Weight and target",
    text: "How much of the account the position is now, against the share the strategy aims for. Positions drift with prices; the rebalance trades them back when they drift too far.",
  },
  stop: {
    term: "Stop",
    text: "The price at which a position is sold automatically: if it closes at or below it, code sells it at the next rebalance. It's set as a percentage below the average price paid.",
  },
  review: {
    term: "Review date",
    text: "The date by which a bet must be re-justified with fresh evidence. If it isn't renewed by then, code sells it.",
  },
  stale: {
    term: "Goes stale",
    text: "The research routine reaffirms every bet each time it runs. If it hasn't for 30 days, the bet unwinds into VTI: a safety net in case the research stops.",
  },
  exitIf: {
    term: "Sells sooner if",
    text: "The conditions the routine wrote that would make it sell before the stop: things anyone could check in a filing, a report or the price. It re-judges them every run.",
  },
  flags: {
    term: "Flags",
    text: "Warning signs code checks on each held bet, like insiders selling or analysts cutting estimates. The routine weighs them every run. A flag isn't an automatic sale.",
  },
  idle: {
    term: "Idle money in VTI",
    text: "Whatever the bets don't use sits in VTI rather than cash, so it keeps up with the market until a bet needs it.",
  },
  washSale: {
    term: "Wash-sale window",
    text: "After selling at a loss, buying the same stock back within 30 days makes the loss non-deductible for taxes. The window shows when that ends.",
  },
  trigger: {
    term: "Buys if",
    text: "What would turn a watched name into a bet: a specific report, filing or price the routine is waiting for.",
  },
  forecast: {
    term: "Forecast",
    text: "The routine's honest chance that a stock beats VTI by a date, scored later against what happened. About 45% of stocks beat VTI over a few months, so anything above 50% is a real claim.",
  },
  openVsVti: {
    term: "Open: ahead, even or behind",
    text: "Where a bet still held stands now against the same dollars in VTI over the same days. Within half a point either way counts as even, so a few cents don't swing it. \"Not scored yet\" means there aren't the closes to compare yet.",
  },
  leadSignal: {
    term: "Lead signal",
    text: "The kind of evidence that surfaced a bet and carries the case: insider buying, a fund manager's filing (13F), fundamentals, and so on. History groups results by it, to see which kinds have worked.",
  },
  guardrails: {
    term: "Guardrails",
    text: "Limits code enforces that the research can't change: the kill switch (stops all trading), the halt (30% below the peak), a pause on buys after a bad day, and the broker's own checks.",
  },
  drawdown: {
    term: "From peak",
    text: "How far the account's flow-adjusted value is below its highest point. Trading halts at 30%.",
  },
} as const;

export type GlossaryTerm = keyof typeof GLOSSARY;
