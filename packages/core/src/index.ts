export const TRADING_ENVS = ["staging", "production"] as const;
export type TradingEnv = (typeof TRADING_ENVS)[number];
