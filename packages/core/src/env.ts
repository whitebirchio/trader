/** Deployment environments; each maps to exactly one Alpaca account (ADR-005). */
export const TRADING_ENVS = ["staging", "production"] as const;
export type TradingEnv = (typeof TRADING_ENVS)[number];
