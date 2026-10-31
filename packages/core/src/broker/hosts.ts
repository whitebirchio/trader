import type { TradingEnv } from "../env.js";

export interface AlpacaHosts {
  trading: string;
  data: string;
}

/**
 * The Alpaca host is a function of the environment and nothing else (ADR-005).
 * Paper and live keys only authenticate against their own host (a paper key on
 * the live host gets 401), so a key in the wrong environment can't reach the
 * other account. There is deliberately no override.
 */
export function alpacaHosts(env: TradingEnv): AlpacaHosts {
  const trading =
    env === "production" ? "https://api.alpaca.markets" : "https://paper-api.alpaca.markets";
  return { trading, data: "https://data.alpaca.markets" };
}
