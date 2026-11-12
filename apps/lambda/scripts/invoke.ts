/**
 * Run the deployed engine Lambda now, instead of waiting for its schedule:
 *
 *   npm run invoke -w trader-lambda -- --env production [--jobs heartbeat,sync-broker]
 *
 * Without a scheduled time the slot is the current minute, so a second invoke
 * within the same minute is a recorded no-op (ADR-007). Uses AWS_PROFILE
 * (default "whitebirch").
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { env: { type: "string" }, jobs: { type: "string" } } });
if (values.env !== "production") throw new Error("--env production is required (staging was retired, ADR-018)");

const payload = values.jobs ? { jobs: values.jobs.split(",").map((j) => j.trim()) } : {};
const dir = mkdtempSync(join(tmpdir(), "trader-invoke-"));
try {
  const out = join(dir, "out.json");
  const meta = execFileSync(
    "aws",
    [
      "lambda", "invoke",
      "--function-name", `trader-engine-${values.env}`,
      "--payload", JSON.stringify(payload),
      "--cli-binary-format", "raw-in-base64-out",
      "--profile", process.env.AWS_PROFILE ?? "whitebirch",
      "--region", "us-east-1",
      out,
    ],
    { encoding: "utf8" },
  );
  const result = JSON.parse(readFileSync(out, "utf8")) as unknown;
  const { FunctionError } = JSON.parse(meta) as { FunctionError?: string };
  console.log(JSON.stringify(result, null, 2));
  if (FunctionError) process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
