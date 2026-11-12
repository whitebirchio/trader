/**
 * Show and apply the account configuration Trader requires (SPEC-broker
 * assumption 1): margin multiplier 1 (buying power = cash), shorting off,
 * fractional trading on. syncBroker refuses to allow trading otherwise.
 *
 *   npm run broker:configure -w @trader/core -- --env production|paper [--check] [--margin N]
 *
 * --check   print only, change nothing
 * --margin  STAGING ONLY: set an unsafe multiplier to test the fail-closed path
 *
 * Reads the env's Alpaca keys from the repo .env (paper: STAGING_ALPACA_*).
 */
import { parseArgs } from "node:util";
import { AlpacaBroker } from "../src/broker/alpaca.js";
import type { AccountConfig } from "../src/broker/port.js";
import { paperBroker, parseOpsEnv } from "./ops.js";
import { readRepoEnv } from "./repo-env.js";

const { values } = parseArgs({
  options: { env: { type: "string" }, check: { type: "boolean" }, margin: { type: "string" } },
});
const env = parseOpsEnv(values.env);
if (values.margin && env !== "paper") throw new Error("--margin is paper-only");

const repo = readRepoEnv();
const broker =
  env === "paper" ? paperBroker() : new AlpacaBroker({ env: "production", keyId: repo.require("PRODUCTION_ALPACA_KEY_ID"), secretKey: repo.require("PRODUCTION_ALPACA_SECRET_KEY") });

const show = (label: string, c: AccountConfig) =>
  console.log(
    `${label}: margin multiplier ${c.maxMarginMultiplier} · shorting ${c.noShorting ? "off" : "ON"} · fractional ${c.fractionalTrading ? "on" : "OFF"} · trading ${c.suspendTrade ? "SUSPENDED" : "enabled"}`,
  );

const account = await broker.getAccount();
console.log(`${env}: account status ${account.status}, cash $${account.cash}, equity $${account.equity}`);
show("current", await broker.getAccountConfig());
if (values.check) process.exit(0);

const target: Partial<AccountConfig> = {
  maxMarginMultiplier: values.margin ?? "1",
  noShorting: true,
  fractionalTrading: true,
};
show("applied", await broker.updateAccountConfig(target));
