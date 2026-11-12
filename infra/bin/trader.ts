import { App } from "aws-cdk-lib";
import { fileURLToPath } from "node:url";
import { CertsStack } from "../lib/certs-stack.js";
import { CiStack } from "../lib/ci-stack.js";
import { REGION } from "../lib/config.js";
import { EngineStack } from "../lib/engine-stack.js";

// Account comes from the CLI profile (`--profile whitebirch` locally, the OIDC role in CI).
const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };

new CiStack(app, "TraderCi", { env });
// Deployed once from the laptop (DNS validation waits on Cloudflare records); the engine stacks reference it.
const certs = new CertsStack(app, "TraderCerts", { env });
// Built by `npm run build -w trader-dashboard` before synth or deploy.
const dashboard = { certificate: certs.dashboardCertificate, codeDir: fileURLToPath(new URL("../../apps/dashboard/dist/app", import.meta.url)) };
// The only deployed environment (ADR-018).
new EngineStack(app, "TraderProduction", { env, tradingEnv: "production", dashboard });
