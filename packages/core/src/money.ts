/**
 * Exact decimal arithmetic for prices, cash and share quantities (ADR-009).
 * Values travel as plain decimal strings (what Postgres `numeric` and the
 * Alpaca API both use) and are computed with big.js. A JS `number` is never
 * accepted: the Big constructor below runs in strict mode, which throws on one.
 */
import BigConstructor, { type Big } from "big.js";
import { z } from "zod";

const B = BigConstructor();
B.strict = true;
// Exponent notation only past 1e±1000, so toString() is plain decimal in practice.
B.NE = -1000;
B.PE = 1000;
// Intermediate division precision. Results are always re-rounded by the caller's
// mode, so this only needs to be far past QTY_DP to avoid double-rounding.
B.DP = 40;
B.RM = 0;

/** Alpaca accepts fractional quantities to 9 decimal places. */
export const QTY_DP = 9;
/** Notional order amounts and cash are cents. */
export const NOTIONAL_DP = 2;

export type RoundingMode = "down" | "half-up" | "half-even" | "up";

const ROUNDING: Record<RoundingMode, 0 | 1 | 2 | 3> = {
  down: 0, // toward zero
  "half-up": 1,
  "half-even": 2,
  up: 3, // away from zero
};

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** Zod schema for decimal strings arriving from outside (broker payloads, tool input). */
export const decimalString = z.string().regex(DECIMAL, "expected a plain decimal string");

/** Parse a decimal string. Throws on anything else: a bad value here is a bug, not input. */
export function toBig(value: string): Big {
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    throw new TypeError(`not a decimal string: ${JSON.stringify(value)}`);
  }
  return new B(value);
}

function out(value: Big): string {
  // Normalise negative zero so "-0" never reaches the database.
  return value.eq("0") ? "0" : value.toString();
}

export function add(a: string, b: string): string {
  return out(toBig(a).plus(toBig(b)));
}

export function sub(a: string, b: string): string {
  return out(toBig(a).minus(toBig(b)));
}

export function mul(a: string, b: string): string {
  return out(toBig(a).times(toBig(b)));
}

/** Division always takes an explicit precision and rounding mode. */
export function div(a: string, b: string, dp: number, mode: RoundingMode): string {
  const divisor = toBig(b);
  if (divisor.eq("0")) throw new RangeError("division by zero");
  // Divide with headroom, then round once with the caller's mode.
  return out(toBig(a).div(divisor).round(dp, ROUNDING[mode]));
}

export function round(value: string, dp: number, mode: RoundingMode): string {
  return out(toBig(value).round(dp, ROUNDING[mode]));
}

export function compare(a: string, b: string): -1 | 0 | 1 {
  return toBig(a).cmp(toBig(b));
}
