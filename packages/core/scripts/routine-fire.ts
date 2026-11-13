/**
 * Start a research run now, through the routines API (SPEC-agent § Missed-run
 * recovery): the same call check-routine makes for a retry, by hand. The
 * routine's token comes from SSM (/trader/production/ROUTINE_FIRE_TOKENS) and
 * is never printed. A fired run researches and submits a strategy like any
 * scheduled one, so this trades real money through the usual risk checks.
 *
 *   npm run routine:fire -w @trader/core -- --env production --routine 8:00|12:00 [--dry-run] [--text "why"]
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { AnthropicRoutineFirer, fireRequest } from "../src/agent/routine-firer.js";
import { ROUTINES } from "../src/agent/routine-watch.js";

const { values } = parseArgs({ options: { env: { type: "string" }, routine: { type: "string" }, "dry-run": { type: "boolean" }, text: { type: "string" } } });
if (values.env !== "production") throw new Error("--env production is required: the routines run against production only (ADR-018)");
const routine = ROUTINES.find((r) => r.name.includes(`(${values.routine} ET)`) || r.triggerId === values.routine);
if (!routine) throw new Error(`--routine must be one of ${ROUTINES.map((r) => /\((.+) ET\)/.exec(r.name)?.[1]).join(", ")} (or a trigger id)`);
const text = values.text ?? `Started by hand with routine:fire at ${new Date().toISOString()}.`;

if (values["dry-run"]) {
  const req = fireRequest(routine.triggerId, null, text);
  console.log(`${routine.name}: would POST ${req.url}`);
  for (const [k, v] of Object.entries(req.headers)) console.log(`  ${k}: ${v}`);
  console.log(`  body: ${req.body}`);
} else {
  const raw = execFileSync(
    "aws",
    ["ssm", "get-parameter", "--name", "/trader/production/ROUTINE_FIRE_TOKENS", "--with-decryption", "--query", "Parameter.Value", "--output", "text", "--region", "us-east-1", "--profile", process.env.AWS_PROFILE ?? "whitebirch"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ).trim();
  let tokens: Record<string, string>;
  try {
    tokens = JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error("ROUTINE_FIRE_TOKENS isn't JSON; see docs/SETUP.md");
  }
  const result = await new AnthropicRoutineFirer(tokens).fire(routine.triggerId, text);
  console.log(
    result.status === "fired"
      ? `${routine.name}: fired${result.sessionUrl ? `, ${result.sessionUrl}` : ""}`
      : `${routine.name}: refused (${[result.httpStatus, result.errorType].filter((x) => x !== null).join(" ")})${result.errorType === "no_token" ? ": no token for this routine in ROUTINE_FIRE_TOKENS" : ""}`,
  );
  if (result.status === "failed") process.exitCode = 1;
}
