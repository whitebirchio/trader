import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import {
  type BrokerAdapter,
  type Config,
  type Db,
  type EarningsCalendarPort,
  type Mailer,
  TICK_JOBS,
  getHealth,
  isJobName,
  parseConfig,
  runJob,
  slotFor,
} from "@trader/core";

/** What EventBridge Scheduler sends (SPEC-platform-aws). */
export interface ScheduledEvent {
  jobs?: string[];
  /** `<aws.scheduler.scheduled-time>`: the tick's scheduled instant, for slot idempotency. */
  scheduledTime?: string;
}

export interface HandlerDeps {
  /** TRADING_ENV etc. from the Lambda environment, merged with SSM secrets. */
  loadEnv(): Promise<Record<string, unknown>>;
  openDb(config: Config): Promise<{ db: Db; close(): Promise<void> }>;
  makeBroker(config: Config): BrokerAdapter;
  makeMailer(config: Config): Mailer;
  /** The earnings calendar's source (#30), when an Alpha Vantage key is configured. */
  makeEarnings?(config: Config): EarningsCalendarPort | undefined;
  now(): Date;
  log(level: "info" | "error", message: string, detail?: Record<string, unknown>): void;
}

function isHttp(event: unknown): event is APIGatewayProxyEventV2 {
  return typeof event === "object" && event !== null && "requestContext" in event && "rawPath" in event;
}

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

/**
 * One function, two entry points: scheduled ticks run jobs; the Function URL
 * serves /healthz. A thin shell over @trader/core (ADR-002), and it fails
 * closed on bad config: names only, never values.
 */
export function createHandler(deps: HandlerDeps) {
  return async function handler(event: unknown): Promise<APIGatewayProxyResultV2 | { status: string; results?: unknown[] }> {
    const parsed = parseConfig(await deps.loadEnv());

    if (isHttp(event)) {
      if (!parsed.ok) return json(503, { error: "misconfigured", missing: parsed.missing, invalid: parsed.invalid });
      if (event.requestContext.http.method !== "GET" || event.rawPath !== "/healthz") return json(404, { error: "not found" });
      const { db, close } = await deps.openDb(parsed.config);
      try {
        const health = await getHealth(db, parsed.config.tradingEnv, deps.now());
        return json(health.status === "healthy" ? 200 : 503, health);
      } finally {
        await close();
      }
    }

    if (!parsed.ok) {
      deps.log("error", "config invalid; no jobs run", { missing: parsed.missing, invalid: parsed.invalid });
      throw new Error(`config invalid: ${[...parsed.missing, ...parsed.invalid].join(", ")}`); // fail loudly → error alarm
    }

    const scheduled = (event ?? {}) as ScheduledEvent;
    const requested = scheduled.jobs ?? [...TICK_JOBS];
    const unknown = requested.filter((j) => !isJobName(j));
    if (unknown.length > 0) throw new Error(`unknown jobs: ${unknown.join(", ")}`);
    const at = scheduled.scheduledTime ? Date.parse(scheduled.scheduledTime) : deps.now().getTime();
    if (Number.isNaN(at)) throw new Error(`invalid scheduledTime: ${scheduled.scheduledTime}`);
    const scheduledFor = slotFor(at);

    const { config } = parsed;
    const broker = deps.makeBroker(config);
    const mailer = deps.makeMailer(config);
    const earnings = deps.makeEarnings?.(config);
    const { db, close } = await deps.openDb(config);
    const results: unknown[] = [];
    try {
      for (const job of requested.filter(isJobName)) {
        const outcome = await runJob({ db, env: config.tradingEnv, broker, mailer, now: deps.now, earnings }, job, scheduledFor);
        deps.log("info", "job", { job, scheduledFor: scheduledFor.toISOString(), ...outcome });
        results.push({ job, ...outcome });
      }
    } finally {
      await close();
    }
    return { status: "ok", results };
  };
}
