import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { EngineStack } from "../lib/engine-stack.js";

const env = { account: "111111111111", region: "us-east-1" };

function synth() {
  // Skip esbuild bundling in unit tests; `cdk synth` and deploys bundle for real.
  const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
  const staging = new EngineStack(app, "TraderStaging", { env, tradingEnv: "staging", ownsSesIdentities: true });
  const production = new EngineStack(app, "TraderProduction", { env, tradingEnv: "production", ownsSesIdentities: false });
  return { staging: Template.fromStack(staging), production: Template.fromStack(production) };
}
const { staging, production } = synth();

type Statement = { Sid?: string; Action: unknown; Resource: unknown; Condition?: unknown };
const roleStatements = (t: Template): Statement[] =>
  Object.values(t.findResources("AWS::IAM::Policy")).flatMap(
    (p) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement,
  );

describe("EngineStack", () => {
  it("has one Node 22 arm64 function per environment, configured by name only", () => {
    staging.resourceCountIs("AWS::Lambda::Function", 1);
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

  it("runs rebalance on its own schedule, 5 minutes after each tick, weekday market hours", () => {
    const r = named(production, "trader-rebalance-production");
    expect(r?.Properties.ScheduleExpression).toBe("cron(5/15 14-20 ? * MON-FRI *)");
    expect(JSON.parse(r?.Properties.Target.Input ?? "{}")).toEqual({ jobs: ["rebalance"], scheduledTime: "<aws.scheduler.scheduled-time>" });
  });

  it("exposes only a public health URL", () => {
    staging.resourceCountIs("AWS::Lambda::Url", 1);
    staging.hasResourceProperties("AWS::Lambda::Url", { AuthType: "NONE" });
  });

  it("can read only its own environment's secrets", () => {
    const read = (t: Template) => roleStatements(t).find((s) => s.Sid === "ReadOwnSecrets");
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
      expect(roleStatements(t).filter((s) => JSON.stringify(s.Action).includes("ssm:"))).toHaveLength(1);
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

  it("alarms on errors and on silence, emailing the owner", () => {
    for (const t of [staging, production]) {
      t.resourceCountIs("AWS::CloudWatch::Alarm", 2);
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
});
