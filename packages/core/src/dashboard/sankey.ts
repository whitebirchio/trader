/**
 * The dashboard's four Sankey diagrams (SPEC-dashboard Amendment 3), as nodes
 * and links the page only draws. Pure. Every diagram is balanced (each node's
 * inflow equals its outflow) and its `total` is the figure it explains, to
 * the cent: the builders throw if their inputs don't add up, because that's a
 * bug upstream, not something to draw.
 *
 * Values are decimal strings (dollars, or counts for the funnels). `cap`
 * groups the smallest items on a side into one "Other" node, for phones.
 */
import Big from "big.js";

export interface SankeyNode {
  name: string;
}
export interface SankeyLink {
  source: number;
  target: number;
  value: string;
  /** Dollars behind a count link (signal to outcome), for the tooltip. */
  usd?: string;
}
export interface SankeyData {
  nodes: SankeyNode[];
  links: SankeyLink[];
  total: string;
}

export interface Item {
  name: string;
  value: string;
}

/** The `cap` largest items, the rest summed into `other` (none if it would be zero). */
export function groupSmallest(items: Item[], cap: number | undefined, other: string): Item[] {
  const sorted = [...items].sort((a, b) => new Big(b.value).cmp(a.value));
  if (cap === undefined || sorted.length <= cap) return sorted;
  const kept = sorted.slice(0, cap - 1);
  const rest = sorted.slice(cap - 1).reduce((sum, i) => sum.plus(i.value), new Big(0));
  return [...kept, { name: other, value: rest.toString() }];
}

class Builder {
  readonly nodes: SankeyNode[] = [];
  readonly links: SankeyLink[] = [];
  private index = new Map<string, number>();
  node(name: string): number {
    let i = this.index.get(name);
    if (i === undefined) {
      i = this.nodes.push({ name }) - 1;
      this.index.set(name, i);
    }
    return i;
  }
  link(from: string, to: string, value: Big | string, usd?: string): void {
    const v = new Big(value);
    if (v.lte(0)) return;
    this.links.push({ source: this.node(from), target: this.node(to), value: v.toString(), ...(usd ? { usd } : {}) });
  }
  done(total: Big | string): SankeyData {
    return { nodes: this.nodes, links: this.links, total: new Big(total).toString() };
  }
}

const sum = (items: { value: string }[]) => items.reduce((s, i) => s.plus(i.value), new Big(0));

/**
 * Where the money is (Today): what was put in and what the bets gained flow
 * into the account, and out to each holding and cash; losses leave as their
 * own flow. Since start, deposited + the parts' P&L = holdings + cash exactly
 * (holdings at the official close; the after-close pricing is on both sides).
 */
export function moneySankey(input: { deposited: string; parts: Item[]; holdings: Item[]; cash: string; cap?: number }): SankeyData {
  const gains = input.parts.filter((p) => new Big(p.value).gt(0));
  const losses = input.parts.filter((p) => new Big(p.value).lt(0)).map((p) => ({ name: p.name, value: new Big(p.value).abs().toString() }));
  const held = input.holdings.filter((h) => new Big(h.value).gt(0));
  const value = sum(held).plus(input.cash);
  const expected = new Big(input.deposited).plus(sum(input.parts));
  if (!value.eq(expected)) throw new Error(`moneySankey: holdings + cash (${value}) ≠ deposited + P&L (${expected})`);
  const b = new Builder();
  b.link("Deposited", "Your account", input.deposited);
  b.link("Gains", "Your account", sum(gains));
  for (const h of groupSmallest(held, input.cap, "Other holdings")) b.link("Your account", h.name, h.value);
  b.link("Your account", "Cash", input.cash);
  b.link("Your account", "Losses", sum(losses));
  return b.done(value);
}

/**
 * Profit and loss by bet (Performance, over a range): each bet that made money
 * flows into the middle, which pays for each bet that lost and the net
 * profit; a net loss enters on the left instead. `total` is the net P&L.
 */
export function pnlSankey(input: { parts: Item[]; cap?: number }): SankeyData {
  const net = sum(input.parts);
  const gains = groupSmallest(input.parts.filter((p) => new Big(p.value).gt(0)), input.cap, "Other gains");
  const losses = groupSmallest(
    input.parts.filter((p) => new Big(p.value).lt(0)).map((p) => ({ name: p.name, value: new Big(p.value).abs().toString() })),
    input.cap,
    "Other losses",
  );
  const b = new Builder();
  const middle = net.gte(0) ? "Gained" : "Lost";
  for (const g of gains) b.link(`${g.name} (gain)`, middle, g.value);
  if (net.lt(0)) b.link("Net loss", middle, net.abs());
  for (const l of losses) b.link(middle, `${l.name} (loss)`, l.value);
  if (net.gt(0)) b.link(middle, "Net profit", net);
  return b.done(net);
}

/**
 * How a thesis turned out, or for one still open how it stands now: open
 * theses are split by their current figure against the same dollars in VTI
 * (ideas.ts's outcomeOf). "open" alone is one not scored yet.
 */
export type Outcome = "beat" | "lagged" | "stopped" | "open_ahead" | "open_even" | "open_behind" | "open";
const OUTCOME_LABELS: Record<Outcome, string> = {
  beat: "Beat VTI",
  lagged: "Lagged VTI",
  stopped: "Stopped out",
  open_ahead: "Open, ahead of VTI",
  open_even: "Open, even with VTI",
  open_behind: "Open, behind VTI",
  open: "Open, not scored yet",
};

/**
 * The idea funnel (Ideas), by count: watched names end bought, dropped or
 * still watching; theses never on the watchlist enter as found directly; what
 * was bought ends beating VTI, lagging it, stopped out, or still open.
 */
export function ideaFunnelSankey(ideas: { watched: boolean; state: "bought" | "dropped" | "watching"; outcome?: Outcome }[]): SankeyData {
  const b = new Builder();
  const count = (pred: (i: (typeof ideas)[number]) => boolean) => String(ideas.filter(pred).length);
  b.link("Watched", "Bought", count((i) => i.watched && i.state === "bought"));
  b.link("Watched", "Dropped", count((i) => i.watched && i.state === "dropped"));
  b.link("Watched", "Still watching", count((i) => i.watched && i.state === "watching"));
  b.link("Found directly", "Bought", count((i) => !i.watched && i.state === "bought"));
  for (const o of Object.keys(OUTCOME_LABELS) as Outcome[]) b.link("Bought", OUTCOME_LABELS[o], count((i) => i.state === "bought" && i.outcome === o));
  if (ideas.some((i) => i.state === "bought" && !i.outcome)) throw new Error("ideaFunnelSankey: a bought idea has no outcome");
  return b.done(String(ideas.length));
}

/** Signal to outcome (History), by count, with each link's dollars of P&L for the tooltip. */
export function signalSankey(theses: { leadSignal: string; outcome: Outcome; pnl: string }[]): SankeyData {
  const b = new Builder();
  const groups = new Map<string, { n: number; usd: Big }>();
  for (const t of theses) {
    const key = `${t.leadSignal}|${t.outcome}`;
    const g = groups.get(key) ?? { n: 0, usd: new Big(0) };
    groups.set(key, { n: g.n + 1, usd: g.usd.plus(t.pnl) });
  }
  for (const [key, g] of [...groups].sort(([a], [z]) => a.localeCompare(z))) {
    const [signal, outcome] = key.split("|") as [string, Outcome];
    b.link(signal, OUTCOME_LABELS[outcome], String(g.n), g.usd.toFixed(2));
  }
  return b.done(String(theses.length));
}

/** Every node but the sources and sinks takes in what it sends out (the test's check, exported for the page's too). */
export function isBalanced(d: SankeyData): boolean {
  const flow = new Map<number, { in: Big; out: Big }>();
  for (const l of d.links) {
    const s = flow.get(l.source) ?? { in: new Big(0), out: new Big(0) };
    const t = flow.get(l.target) ?? { in: new Big(0), out: new Big(0) };
    flow.set(l.source, { ...s, out: s.out.plus(l.value) });
    flow.set(l.target, { ...t, in: t.in.plus(l.value) });
  }
  return [...flow.values()].every((f) => f.in.eq(0) || f.out.eq(0) || f.in.eq(f.out));
}
