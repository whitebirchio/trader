import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CertsStack } from "../lib/certs-stack.js";
import { EngineStack } from "../lib/engine-stack.js";

const env = { account: "111111111111", region: "us-east-1" };

function synth() {
  // Skip esbuild bundling in unit tests; `cdk synth` and deploys bundle for real.
  const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
  const certs = new CertsStack(app, "TraderCerts", { env });
  const codeDir = mkdtempSync(join(tmpdir(), "dashboard-code-"));
  writeFileSync(join(codeDir, "index.js"), "// test stand-in for apps/dashboard/dist/app\n");
  const dashboard = { certificate: certs.dashboardCertificate, codeDir };
  const staging = new EngineStack(app, "TraderStaging", { env, tradingEnv: "staging", ownsSesIdentities: true, dashboard });
  const production = new EngineStack(app, "TraderProduction", { env, tradingEnv: "production", ownsSesIdentities: false, dashboard });
  return { staging: Template.fromStack(staging), production: Template.fromStack(production), certs: Template.fromStack(certs) };
}
const { staging, production, certs } = synth();

type Statement = { Sid?: string; Action: unknown; Resource: unknown; Condition?: unknown };
const roleStatements = (t: Template): Statement[] =>
  Object.values(t.findResources("AWS::IAM::Policy")).flatMap(
    (p) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement,
  );

describe("EngineStack", () => {
  it("has the engine and MCP functions, Node 22 arm64, configured by name only", () => {
    staging.resourceCountIs("AWS::Lambda::Function", 3); // engine, MCP, and the dashboard's code-upload handler
    staging.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "trader-engine-staging",
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: 512,
      Timeout: 300,
      Environment: {
        Variables: {
          TRADING_ENV: "staging",
          SECRETS_PATH: "/trader/staging/",
          NOTIFY_FROM: "trader@whitebirch.io",
          NOTIFY_TO: "scott.schmalz@gmail.com",
        },
      },
    });
  });

  type Schedule = { Properties: { Name: string; ScheduleExpression: string; Target: { Input: string } } };
  const schedules = (t: Template) => Object.values(t.findResources("AWS::Scheduler::Schedule")) as Schedule[];
  const named = (t: Template, name: string) => schedules(t).find((s) => s.Properties.Name === name);

  it("ticks every 15 minutes with the full job list and the scheduled time", () => {
    staging.resourceCountIs("AWS::Scheduler::Schedule", 2);
    const tick = named(staging, "trader-tick-staging");
    expect(tick?.Properties.ScheduleExpression).toBe("cron(0/15 * * * ? *)");
    expect(JSON.parse(tick?.Properties.Target.Input ?? "{}")).toEqual({
      jobs: ["heartbeat", "sync-broker", "notify-urgent", "notify-digest"],
      scheduledTime: "<aws.scheduler.scheduled-time>",
    });
  });

  it("runs rebalance on its own schedule, every 15 minutes in weekday market hours", () => {
    const r = named(production, "trader-rebalance-production");
    expect(r?.Properties.ScheduleExpression).toBe("cron(0/15 13-20 ? * MON-FRI *)");
    expect(JSON.parse(r?.Properties.Target.Input ?? "{}")).toEqual({ jobs: ["rebalance"], scheduledTime: "<aws.scheduler.scheduled-time>" });
  });

  it("exposes the health URL and the MCP URL (which does its own OAuth)", () => {
    staging.resourceCountIs("AWS::Lambda::Url", 2);
    staging.hasResourceProperties("AWS::Lambda::Url", { AuthType: "NONE" });
    expect(Object.keys(staging.findOutputs("*"))).toEqual(expect.arrayContaining(["HealthUrl", "McpUrl"]));
  });

  it("runs MCP as its own function: secrets path only, no SES, no schedule", () => {
    staging.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "trader-mcp-staging",
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      Timeout: 60,
      Environment: { Variables: { TRADING_ENV: "staging", SECRETS_PATH: "/trader/staging/" } },
    });
    staging.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: "/aws/lambda/trader-mcp-staging", RetentionInDays: 30 });
    const mcpRole = Object.keys(staging.findResources("AWS::IAM::Role")).find((k) => k.startsWith("McpServiceRole"));
    const mcpPolicies = Object.values(staging.findResources("AWS::IAM::Policy")).filter((p) => JSON.stringify(p).includes(`"${mcpRole}"`));
    const actions = JSON.stringify(mcpPolicies.map((p) => (p as { Properties: { PolicyDocument: unknown } }).Properties.PolicyDocument));
    expect(actions).toContain("ssm:GetParametersByPath");
    expect(actions).not.toContain("ses:");
    const targets = JSON.stringify(Object.values(staging.findResources("AWS::Scheduler::Schedule")));
    expect(targets).not.toContain("Mcp");
  });

  it("can read only its own environment's secrets", () => {
    const read = (t: Template) => roleStatements(t).find((s) => s.Sid === "ReadOwnSecrets");
    for (const t of [staging, production]) {
      const reads = roleStatements(t).filter((s) => s.Sid === "ReadOwnSecrets");
      expect(reads).toHaveLength(2); // engine + MCP, the same path
      expect(reads[1]?.Resource).toEqual(reads[0]?.Resource);
    }
    // Both spellings of the path: the SDK requests ".../trader/<env>/" (with the slash).
    expect(read(staging)?.Resource).toEqual([
      "arn:aws:ssm:us-east-1:111111111111:parameter/trader/staging",
      "arn:aws:ssm:us-east-1:111111111111:parameter/trader/staging/",
    ]);
    expect(read(production)?.Resource).toEqual([
      "arn:aws:ssm:us-east-1:111111111111:parameter/trader/production",
      "arn:aws:ssm:us-east-1:111111111111:parameter/trader/production/",
    ]);
    for (const t of [staging, production]) {
      expect(roleStatements(t).filter((s) => JSON.stringify(s.Action).includes("ssm:"))).toHaveLength(3); // engine, MCP, dashboard
      expect(roleStatements(t).filter((s) => JSON.stringify(s.Action).includes("ses:"))).toHaveLength(1);
    }
  });

  it("can send email only from Trader's address", () => {
    const send = roleStatements(staging).find((s) => s.Sid === "SendOwnerEmail");
    expect(send).toMatchObject({
      Action: "ses:SendEmail",
      Condition: { StringEquals: { "ses:FromAddress": "trader@whitebirch.io" } },
    });
  });

  it("creates the SES identities in staging only", () => {
    staging.resourceCountIs("AWS::SES::EmailIdentity", 2);
    production.resourceCountIs("AWS::SES::EmailIdentity", 0);
    staging.hasResourceProperties("AWS::SES::EmailIdentity", { EmailIdentity: "whitebirch.io" });
  });

  it("alarms when the MCP server throws, to the same topic (#13)", () => {
    for (const [t, env] of [[staging, "staging"], [production, "production"]] as const) {
      const [alarm] = Object.values(t.findResources("AWS::CloudWatch::Alarm", { Properties: { AlarmName: `trader-${env}-mcp-errors` } })) as { Properties: Record<string, unknown> }[];
      expect(alarm?.Properties).toMatchObject({ MetricName: "Errors", Threshold: 1, Period: 900, TreatMissingData: "notBreaching" });
      expect(JSON.stringify(alarm?.Properties.Dimensions)).toContain("Mcp");
      expect(JSON.stringify(alarm?.Properties.AlarmActions)).toContain("Alarms");
      expect(JSON.stringify(alarm?.Properties.OKActions)).toContain("Alarms");
    }
  });

  it("alarms on errors and on silence, emailing the owner", () => {
    for (const t of [staging, production]) {
      t.resourceCountIs("AWS::CloudWatch::Alarm", 3);
      t.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "Errors", Threshold: 1, TreatMissingData: "notBreaching" });
      t.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "Invocations", ComparisonOperator: "LessThanThreshold", TreatMissingData: "breaching" });
      t.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "scott.schmalz@gmail.com" });
    }
  });

  it("keeps logs for 30 days and tags everything", () => {
    staging.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: "/aws/lambda/trader-engine-staging", RetentionInDays: 30 });
    staging.hasResourceProperties("AWS::Lambda::Function", {
      Tags: Match.arrayWith([{ Key: "app", Value: "trader" }, { Key: "env", Value: "staging" }]),
    });
  });

  it("differs between environments only in names, env and paths", () => {
    const normalize = (t: Template) =>
      JSON.stringify(t.toJSON())
        .replaceAll("trader-staging.whitebirch.io", "trader.whitebirch.io")
        // BucketDeployment tags its bucket with a hash of the construct path.
        .replace(/aws-cdk:cr-owned:[0-9a-f]+/g, "aws-cdk:cr-owned:HASH")
        .replaceAll("production", "ENV")
        .replaceAll("staging", "ENV")
        .replaceAll("Production", "Env")
        .replaceAll("Staging", "Env");
    const strip = (s: string) => {
      const doc = JSON.parse(s) as { Resources: Record<string, { Type: string }>; Outputs?: Record<string, unknown> };
      // SES identities and their DKIM outputs live in staging only, by design.
      for (const [k, r] of Object.entries(doc.Resources)) if (r.Type === "AWS::SES::EmailIdentity") delete doc.Resources[k];
      for (const k of Object.keys(doc.Outputs ?? {})) if (k.startsWith("DkimRecord")) delete doc.Outputs?.[k];
      return doc;
    };
    expect(strip(normalize(production))).toEqual(strip(normalize(staging)));
  });

  describe("dashboard", () => {
    type WithProps = { Properties: Record<string, unknown> };
    const one = (t: Template, type: string) => Object.values(t.findResources(type))[0] as WithProps;

    it("is a Web Function with an IamAuth endpoint, capped and throttled", () => {
      staging.hasResourceProperties("AWS::Lambda::WebFunction", { FunctionName: "trader-dashboard-staging" });
      staging.hasResourceProperties("AWS::Lambda::WebFunctionEndpoint", {
        EndpointType: "HomeRegion",
        AuthType: "IamAuth",
        ScalingConfig: { MaxEnvironments: 2 },
        ThrottleConfig: { RateLimit: 100 },
      });
      staging.hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
        BuildConfig: Match.objectLike({ RuntimeConfig: { Runtime: "nodejs24.x" } }),
        ServiceConfig: Match.objectLike({
          EnvironmentVariables: Match.objectLike({ TRADING_ENV: "staging", DASHBOARD_URL: "https://trader-staging.whitebirch.io", SECRETS_PATH: "/trader/staging/", NODE_ENV: "production" }),
        }),
      });
      production.hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
        ServiceConfig: Match.objectLike({ EnvironmentVariables: Match.objectLike({ DASHBOARD_URL: "https://trader.whitebirch.io" }) }),
      });
    });

    it("can be invoked only by its own CloudFront distribution", () => {
      const policy = JSON.stringify(one(staging, "AWS::Lambda::ResourcePolicy").Properties.PolicyDocument);
      expect(policy).toContain('"Service":"cloudfront.amazonaws.com"');
      expect(policy).toContain("lambda:InvokeWebFunctionEndpoint");
      expect(policy).toContain("aws:SourceArn");
      expect(policy).not.toContain('"Principal":"*"');
      staging.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
        OriginAccessControlConfig: Match.objectLike({ OriginAccessControlOriginType: "lambda", SigningBehavior: "always-amz-auth" }),
      });
      const dist = JSON.stringify(one(staging, "AWS::CloudFront::Distribution").Properties);
      expect(dist).toContain("OriginAccessControlId");
      expect(dist).toContain('"Aliases":["trader-staging.whitebirch.io"]');
      expect(dist).toContain('"ViewerProtocolPolicy":"redirect-to-https"');
      expect(dist).toContain("4135ea2d-6df8-44a3-9df3-4b5a84be39ad"); // CachingDisabled for pages
      expect(dist).toContain('"EventType":"viewer-request"'); // + → %20 before OAC signs
      staging.hasResourceProperties("AWS::CloudFront::Function", { FunctionCode: Match.stringLikeRegexp('replace\\(/\\\\\\+/g, "%20"\\)') });
    });

    it("reads only its three secrets: never the Alpaca keys, no SES, no path reads", () => {
      const read = roleStatements(staging).find((s) => s.Sid === "ReadDashboardSecrets");
      expect(read?.Action).toBe("ssm:GetParameters");
      expect(JSON.stringify(read?.Resource)).toContain("parameter/trader/staging/DATABASE_READ_URL");
      expect((read?.Resource as unknown[]).length).toBe(3);
      expect(JSON.stringify(read?.Resource)).not.toMatch(/ALPACA|MCP_/);
      const dashboardRole = Object.keys(staging.findResources("AWS::IAM::Role")).find((k) => k.startsWith("DashboardRole"));
      const policies = JSON.stringify(Object.values(staging.findResources("AWS::IAM::Policy")).filter((p) => JSON.stringify(p).includes(`"${dashboardRole}"`)));
      expect(policies).not.toContain("ses:");
      expect(policies).not.toContain("GetParametersByPath");
    });

    it("keeps code versions the live revision needs, and logs for 30 days", () => {
      staging.hasResourceProperties("AWS::S3::Bucket", {
        VersioningConfiguration: { Status: "Enabled" },
        LifecycleConfiguration: { Rules: [Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 30 } })] },
      });
      for (const g of ["/aws/lambda/web/trader-dashboard-staging", "/aws/lambda/web/trader-dashboard-staging.local"]) {
        staging.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: g, RetentionInDays: 30 });
      }
    });

    it("gets one certificate for both names from TraderCerts", () => {
      certs.hasResourceProperties("AWS::CertificateManager::Certificate", {
        DomainName: "trader.whitebirch.io",
        SubjectAlternativeNames: ["trader-staging.whitebirch.io"],
        ValidationMethod: "DNS",
      });
    });
  });
});
