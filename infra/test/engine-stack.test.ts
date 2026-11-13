import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ENGINE_PARAMETERS, MCP_PARAMETERS } from "@trader/core";
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
  const production = new EngineStack(app, "TraderProduction", { env, tradingEnv: "production", dashboard });
  return { production: Template.fromStack(production), certs: Template.fromStack(certs) };
}
const { production, certs } = synth();

type Statement = { Sid?: string; Action: unknown; Resource: unknown; Condition?: unknown };
const roleStatements = (t: Template): Statement[] =>
  Object.values(t.findResources("AWS::IAM::Policy")).flatMap(
    (p) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement,
  );

describe("EngineStack", () => {
  it("has the engine and MCP functions, Node 22 arm64, configured by name only", () => {
    production.resourceCountIs("AWS::Lambda::Function", 3); // engine, MCP, and the dashboard's code-upload handler
    production.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "trader-engine-production",
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: 512,
      Timeout: 300,
      Environment: {
        Variables: {
          TRADING_ENV: "production",
          SECRETS_PATH: "/trader/production/",
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
    production.resourceCountIs("AWS::Scheduler::Schedule", 2);
    const tick = named(production, "trader-tick-production");
    expect(tick?.Properties.ScheduleExpression).toBe("cron(0/15 * * * ? *)");
    expect(JSON.parse(tick?.Properties.Target.Input ?? "{}")).toEqual({
      jobs: ["heartbeat", "sync-broker", "process-capital", "earnings-calendar", "check-filings", "earnings-estimates", "earnings-backfill", "check-routine", "notify-urgent", "notify-digest", "notify-weekly"],
      scheduledTime: "<aws.scheduler.scheduled-time>",
    });
  });

  it("runs rebalance on its own schedule, every 15 minutes in weekday market hours", () => {
    const r = named(production, "trader-rebalance-production");
    expect(r?.Properties.ScheduleExpression).toBe("cron(0/15 13-20 ? * MON-FRI *)");
    expect(JSON.parse(r?.Properties.Target.Input ?? "{}")).toEqual({ jobs: ["rebalance"], scheduledTime: "<aws.scheduler.scheduled-time>" });
  });

  it("exposes the health URL and the MCP URL (which does its own OAuth)", () => {
    production.resourceCountIs("AWS::Lambda::Url", 2);
    production.hasResourceProperties("AWS::Lambda::Url", { AuthType: "NONE" });
    expect(Object.keys(production.findOutputs("*"))).toEqual(expect.arrayContaining(["HealthUrl", "McpUrl"]));
  });

  it("runs MCP as its own function: its own named secrets only, no SES, no schedule", () => {
    production.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "trader-mcp-production",
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      Timeout: 60,
      Environment: { Variables: { TRADING_ENV: "production", SECRETS_PATH: "/trader/production/" } },
    });
    production.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: "/aws/lambda/trader-mcp-production", RetentionInDays: 30 });
    const mcpRole = Object.keys(production.findResources("AWS::IAM::Role")).find((k) => k.startsWith("McpServiceRole"));
    const mcpPolicies = Object.values(production.findResources("AWS::IAM::Policy")).filter((p) => JSON.stringify(p).includes(`"${mcpRole}"`));
    const actions = JSON.stringify(mcpPolicies.map((p) => (p as { Properties: { PolicyDocument: unknown } }).Properties.PolicyDocument));
    expect(actions).toContain("ssm:GetParameters");
    expect(actions).not.toContain("ssm:GetParametersByPath");
    expect(actions).not.toContain("ses:");
    // Least privilege (review finding R1): exactly the MCP_* parameters, never the engine's database URL or Alpaca keys.
    const mcpRead = roleStatements(production).find((s) => s.Sid === "ReadMcpSecrets");
    expect(mcpRead?.Resource).toEqual(MCP_PARAMETERS.map((n) => `arn:aws:ssm:us-east-1:111111111111:parameter/trader/production/${n}`));
    expect(JSON.stringify(mcpRead?.Resource)).not.toMatch(/\/(DATABASE_URL|ALPACA_KEY_ID|ALPACA_SECRET_KEY)"/);
    const targets = JSON.stringify(Object.values(production.findResources("AWS::Scheduler::Schedule")));
    expect(targets).not.toContain("Mcp");
  });

  it("can read only its own environment's secrets", () => {
    const reads = roleStatements(production).filter((s) => s.Sid === "ReadOwnSecrets");
    expect(reads).toHaveLength(1); // the engine; the MCP server has its own named list (ReadMcpSecrets)
    // Exactly the engine's own names, read with GetParameters: never the whole path, which holds the MCP server's and dashboard's secrets.
    expect(reads[0]?.Action).toBe("ssm:GetParameters");
    expect(reads[0]?.Resource).toEqual(ENGINE_PARAMETERS.map((n) => `arn:aws:ssm:us-east-1:111111111111:parameter/trader/production/${n}`));
    // The routines API tokens (SPEC-agent § Missed-run recovery): the engine re-fires a missed research run.
    expect(ENGINE_PARAMETERS).toContain("ROUTINE_FIRE_TOKENS");
    expect(JSON.stringify(roleStatements(production))).not.toContain("ssm:GetParametersByPath");
    expect(roleStatements(production).filter((s) => JSON.stringify(s.Action).includes("ssm:"))).toHaveLength(3); // engine, MCP, dashboard
    expect(roleStatements(production).filter((s) => JSON.stringify(s.Action).includes("ses:"))).toHaveLength(1);
  });

  it("can send email only from Trader's address", () => {
    const send = roleStatements(production).find((s) => s.Sid === "SendOwnerEmail");
    expect(send).toMatchObject({
      Action: "ses:SendEmail",
      Condition: { StringEquals: { "ses:FromAddress": "trader@whitebirch.io" } },
    });
  });

  it("owns the SES identities, retained so they outlive the stack (ADR-018)", () => {
    production.resourceCountIs("AWS::SES::EmailIdentity", 2);
    production.hasResourceProperties("AWS::SES::EmailIdentity", { EmailIdentity: "whitebirch.io" });
    production.hasResourceProperties("AWS::SES::EmailIdentity", { EmailIdentity: "scott.schmalz@gmail.com" });
    for (const r of Object.values(production.findResources("AWS::SES::EmailIdentity"))) expect(r).toMatchObject({ DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  });

  it("alarms when the MCP server throws, to the same topic (#13)", () => {
    const [alarm] = Object.values(production.findResources("AWS::CloudWatch::Alarm", { Properties: { AlarmName: "trader-production-mcp-errors" } })) as { Properties: Record<string, unknown> }[];
    expect(alarm?.Properties).toMatchObject({ MetricName: "Errors", Threshold: 1, Period: 900, TreatMissingData: "notBreaching" });
    expect(JSON.stringify(alarm?.Properties.Dimensions)).toContain("Mcp");
    expect(JSON.stringify(alarm?.Properties.AlarmActions)).toContain("Alarms");
    expect(JSON.stringify(alarm?.Properties.OKActions)).toContain("Alarms");
  });

  it("alarms on errors and on silence, emailing the owner", () => {
    production.resourceCountIs("AWS::CloudWatch::Alarm", 3);
    production.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "Errors", Threshold: 1, TreatMissingData: "notBreaching" });
    production.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "Invocations", ComparisonOperator: "LessThanThreshold", TreatMissingData: "breaching" });
    production.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "scott.schmalz@gmail.com" });
  });

  it("keeps logs for 30 days and tags everything", () => {
    production.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: "/aws/lambda/trader-engine-production", RetentionInDays: 30 });
    production.hasResourceProperties("AWS::Lambda::Function", {
      Tags: Match.arrayWith([{ Key: "app", Value: "trader" }, { Key: "env", Value: "production" }]),
    });
  });

  describe("dashboard", () => {
    type WithProps = { Properties: Record<string, unknown> };
    const one = (t: Template, type: string) => Object.values(t.findResources(type))[0] as WithProps;

    it("is a Web Function with an IamAuth endpoint, capped and throttled", () => {
      production.hasResourceProperties("AWS::Lambda::WebFunction", { FunctionName: "trader-dashboard-production" });
      production.hasResourceProperties("AWS::Lambda::WebFunctionEndpoint", {
        EndpointType: "HomeRegion",
        AuthType: "IamAuth",
        ScalingConfig: { MaxEnvironments: 2 },
        ThrottleConfig: { RateLimit: 100 },
      });
      production.hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
        BuildConfig: Match.objectLike({ RuntimeConfig: { Runtime: "nodejs24.x" } }),
        ServiceConfig: Match.objectLike({
          EnvironmentVariables: Match.objectLike({ TRADING_ENV: "production", DASHBOARD_URL: "https://trader.whitebirch.io", SECRETS_PATH: "/trader/production/", NODE_ENV: "production" }),
          // A page load's burst fits in one environment, under the cap of 2 (#123).
          MaxConcurrencyPerEnvironment: 32,
        }),
      });
      production.hasResourceProperties("AWS::Lambda::WebFunctionRevision", {
        ServiceConfig: Match.objectLike({ EnvironmentVariables: Match.objectLike({ DASHBOARD_URL: "https://trader.whitebirch.io" }) }),
      });
    });

    it("can be invoked only by its own CloudFront distribution", () => {
      const policy = JSON.stringify(one(production, "AWS::Lambda::ResourcePolicy").Properties.PolicyDocument);
      expect(policy).toContain('"Service":"cloudfront.amazonaws.com"');
      expect(policy).toContain("lambda:InvokeWebFunctionEndpoint");
      expect(policy).toContain("aws:SourceArn");
      expect(policy).not.toContain('"Principal":"*"');
      production.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
        OriginAccessControlConfig: Match.objectLike({ OriginAccessControlOriginType: "lambda", SigningBehavior: "always-amz-auth" }),
      });
      const dist = JSON.stringify(one(production, "AWS::CloudFront::Distribution").Properties);
      expect(dist).toContain("OriginAccessControlId");
      expect(dist).toContain('"Aliases":["trader.whitebirch.io"]');
      expect(dist).toContain('"ViewerProtocolPolicy":"redirect-to-https"');
      expect(dist).toContain("4135ea2d-6df8-44a3-9df3-4b5a84be39ad"); // CachingDisabled for pages
      expect(dist).toContain('"EventType":"viewer-request"'); // + → %20 before OAC signs
      production.hasResourceProperties("AWS::CloudFront::Function", { FunctionCode: Match.stringLikeRegexp('replace\\(/\\\\\\+/g, "%20"\\)') });
    });

    it("reads only its three secrets: never the Alpaca keys, no SES, no path reads", () => {
      const read = roleStatements(production).find((s) => s.Sid === "ReadDashboardSecrets");
      expect(read?.Action).toBe("ssm:GetParameters");
      expect(JSON.stringify(read?.Resource)).toContain("parameter/trader/production/DATABASE_READ_URL");
      expect((read?.Resource as unknown[]).length).toBe(3);
      expect(JSON.stringify(read?.Resource)).not.toMatch(/ALPACA|MCP_/);
      const dashboardRole = Object.keys(production.findResources("AWS::IAM::Role")).find((k) => k.startsWith("DashboardRole"));
      const policies = JSON.stringify(Object.values(production.findResources("AWS::IAM::Policy")).filter((p) => JSON.stringify(p).includes(`"${dashboardRole}"`)));
      expect(policies).not.toContain("ses:");
      expect(policies).not.toContain("GetParametersByPath");
    });

    it("keeps code versions the live revision needs, and logs for 30 days", () => {
      production.hasResourceProperties("AWS::S3::Bucket", {
        VersioningConfiguration: { Status: "Enabled" },
        LifecycleConfiguration: { Rules: [Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 30 } })] },
      });
      for (const g of ["/aws/lambda/web/trader-dashboard-production", "/aws/lambda/web/trader-dashboard-production.local"]) {
        production.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: g, RetentionInDays: 30 });
      }
    });

    it("gets one certificate for both names from TraderCerts", () => {
      certs.hasResourceProperties("AWS::CertificateManager::Certificate", {
        DomainName: "trader.whitebirch.io",
        SubjectAlternativeNames: ["trader-staging.whitebirch.io"], // dropped when the certificate is next reissued (ADR-018),
        ValidationMethod: "DNS",
      });
    });
  });
});
