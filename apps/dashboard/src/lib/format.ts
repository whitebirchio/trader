import { compare, round } from "@trader/core";

/** Display formatting for decimal strings: no arithmetic on JS numbers (ADR-009). */
function group(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatUsd(value: string, dp = 2): string {
  const r = round(value, dp, "half-even");
  const negative = r.startsWith("-");
  const [int, frac = ""] = (negative ? r.slice(1) : r).split(".");
  const fraction = dp > 0 ? `.${frac.padEnd(dp, "0")}` : "";
  return `${negative ? "−" : ""}$${group(int ?? "0")}${fraction}`;
}

/** "+1.24%" / "−0.50%" / "0.00%". */
export function formatPct(value: string, dp = 2, signed = true): string {
  const r = round(value, dp, "half-even");
  const negative = r.startsWith("-");
  const [int, frac = ""] = (negative ? r.slice(1) : r).split(".");
  const body = `${int}${dp > 0 ? `.${frac.padEnd(dp, "0")}` : ""}%`;
  if (negative) return `−${body}`;
  return signed && compare(r, "0") > 0 ? `+${body}` : body;
}

export function formatQty(value: string): string {
  return round(value, 4, "half-even").replace(/\.?0+$/, "") || "0";
}

const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", year: "numeric" });

/** "Nov 2, 9:45 AM" in New York time. */
export const formatEt = (iso: string) => ET.format(new Date(iso));
export const formatDay = (iso: string) => DAY.format(new Date(iso));

/** -1 / 0 / 1, for picking an up/down glyph next to a number. */
export const sign = (value: string) => compare(value, "0");

/** Only http(s) links from strategy evidence are rendered as links. */
export const safeHref = (url: string | undefined) => (url && /^https?:\/\//i.test(url) ? url : null);
