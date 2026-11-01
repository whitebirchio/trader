import { App } from "aws-cdk-lib";
import { CiStack } from "../lib/ci-stack.js";
import { REGION } from "../lib/config.js";
import { EngineStack } from "../lib/engine-stack.js";

// Account comes from the CLI profile (`--profile whitebirch` locally, the OIDC role in CI).
const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };

new CiStack(app, "TraderCi", { env });
new EngineStack(app, "TraderStaging", { env, tradingEnv: "staging", ownsSesIdentities: true });
new EngineStack(app, "TraderProduction", { env, tradingEnv: "production", ownsSesIdentities: false });
