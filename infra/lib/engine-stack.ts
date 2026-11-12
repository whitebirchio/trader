import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps, Tags } from "aws-cdk-lib";
import type * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import { ENGINE_PARAMETERS, MCP_PARAMETERS, TICK_JOBS } from "@trader/core";
import type { Construct } from "constructs";
import { Dashboard } from "./dashboard.js";
import { MAIL_DOMAIN, NOTIFY_FROM, OWNER_EMAIL, type TradingEnv, secretsPath } from "./config.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export interface EngineStackProps extends StackProps {
  tradingEnv: TradingEnv;
  /** The dashboard's certificate (TraderCerts) and packaged code directory. */
  dashboard: { certificate: acm.ICertificate; codeDir: string };
}

/** One Trader environment on AWS (SPEC-platform-aws): Lambda, its schedule, health URL, email and alarms. */
export class EngineStack extends Stack {
  constructor(scope: Construct, id: string, props: EngineStackProps) {
    super(scope, id, props);
    const env = props.tradingEnv;
    Tags.of(this).add("app", "trader");
    Tags.of(this).add("env", env);

    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: `/aws/lambda/trader-engine-${env}`,
      retention: logs.RetentionDays.ONE_MONTH,
    });

    const bundling = { format: OutputFormat.ESM, target: "node22", minify: true, sourceMap: true, mainFields: ["module", "main"],
      // ESM bundles still meet CommonJS deps; give them a require().
      banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" };

    const fn = new NodejsFunction(this, "Engine", {
      functionName: `trader-engine-${env}`,
      entry: `${repoRoot}apps/lambda/src/index.ts`,
      projectRoot: repoRoot,
      depsLockFilePath: `${repoRoot}package-lock.json`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(5),
      logGroup,
      environment: {
        TRADING_ENV: env,
        SECRETS_PATH: secretsPath(env),
        NOTIFY_FROM,
        NOTIFY_TO: OWNER_EMAIL,
      },
      bundling,
    });

    // Secrets: only this environment's (ADR-005), and of those only the
    // engine's own names (ENGINE_PARAMETERS), never the MCP server's or the
    // dashboard's. aws/ssm decrypt is allowed via SSM by the key's own policy.
    const readOwnSecrets = () =>
      new iam.PolicyStatement({
        sid: "ReadOwnSecrets",
        actions: ["ssm:GetParameters"],
        resources: ENGINE_PARAMETERS.map((name) => `arn:aws:ssm:${this.region}:${this.account}:parameter${secretsPath(env)}${name}`),
      });
    fn.addToRolePolicy(readOwnSecrets());

    // Email: only from Trader's address, via this account's identities.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "SendOwnerEmail",
        actions: ["ses:SendEmail"],
        resources: [
          `arn:aws:ses:${this.region}:${this.account}:identity/${MAIL_DOMAIN}`,
          `arn:aws:ses:${this.region}:${this.account}:identity/${OWNER_EMAIL}`,
        ],
        conditions: { StringEquals: { "ses:FromAddress": NOTIFY_FROM } },
      }),
    );

    // SES identities are account-wide. Retained, so they outlive the stack
    // (TraderStaging created them; production imported them, ADR-018).
    const domain = new ses.EmailIdentity(this, "MailDomain", { identity: ses.Identity.domain(MAIL_DOMAIN) });
    const owner = new ses.EmailIdentity(this, "OwnerAddress", { identity: ses.Identity.email(OWNER_EMAIL) });
    for (const identity of [domain, owner]) identity.applyRemovalPolicy(RemovalPolicy.RETAIN);
    domain.dkimRecords.forEach((r, i) => {
      new CfnOutput(this, `DkimRecord${i + 1}`, { value: `${r.name} CNAME ${r.value}`, description: "Add in Cloudflare DNS (DNS only)" });
    });

    // Every 15 minutes; the scheduled time feeds the job runner's slot (ADR-007).
    const schedulerRole = new iam.Role(this, "SchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
    });
    fn.grantInvoke(schedulerRole);
    new scheduler.CfnSchedule(this, "Tick", {
      name: `trader-tick-${env}`,
      scheduleExpression: "cron(0/15 * * * ? *)",
      scheduleExpressionTimezone: "UTC",
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: fn.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ jobs: [...TICK_JOBS], scheduledTime: "<aws.scheduler.scheduled-time>" }),
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 600 },
      },
    });

    // The daily check (SPEC-portfolio): its own schedule, every 15 minutes on
    // weekdays 13:00–20:59 UTC, which covers 9:45–15:30 ET in both EST and EDT.
    // The job gates on the exact window and the Alpaca calendar itself. It
    // runs alongside the tick and plans on the previous tick's sync (≤ 15 min
    // old, inside risk's 20-minute freshness limit).
    new scheduler.CfnSchedule(this, "Rebalance", {
      name: `trader-rebalance-${env}`,
      scheduleExpression: "cron(0/15 13-20 ? * MON-FRI *)",
      scheduleExpressionTimezone: "UTC",
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: fn.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ jobs: ["rebalance"], scheduledTime: "<aws.scheduler.scheduled-time>" }),
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 600 },
      },
    });

    // Public health check only: it reveals liveness, nothing about the account.
    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    new CfnOutput(this, "HealthUrl", { value: `${url.url}healthz` });

    // The MCP server (SPEC-agent): its own function, so a tool bug can't touch
    // the trading schedule. It's public behind its own OAuth, so it gets least
    // privilege (review finding R1): only its own named parameters (a
    // trader_mcp database URL and a paper-account market-data key), never the
    // engine's DATABASE_URL or Alpaca keys; no SES permission; no schedule.
    const mcp = new NodejsFunction(this, "Mcp", {
      functionName: `trader-mcp-${env}`,
      entry: `${repoRoot}apps/mcp/src/index.ts`,
      projectRoot: repoRoot,
      depsLockFilePath: `${repoRoot}package-lock.json`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(60),
      logGroup: new logs.LogGroup(this, "McpLogs", { logGroupName: `/aws/lambda/trader-mcp-${env}`, retention: logs.RetentionDays.ONE_MONTH }),
      environment: { TRADING_ENV: env, SECRETS_PATH: secretsPath(env) },
      bundling,
    });
    mcp.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadMcpSecrets",
        actions: ["ssm:GetParameters"],
        resources: MCP_PARAMETERS.map((name) => `arn:aws:ssm:${this.region}:${this.account}:parameter${secretsPath(env)}${name}`),
      }),
    );
    const mcpUrl = mcp.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    new CfnOutput(this, "McpUrl", { value: `${mcpUrl.url}mcp`, description: "Add in Claude as a custom connector" });

    // The read-only dashboard (SPEC-dashboard).
    new Dashboard(this, "Dashboard", { tradingEnv: env, ...props.dashboard });

    // Alarms → your inbox, independent of Trader's own email path.
    const topic = new sns.Topic(this, "Alarms", { topicName: `trader-alarms-${env}` });
    topic.addSubscription(new subs.EmailSubscription(OWNER_EMAIL));
    const notify = new cwActions.SnsAction(topic);

    const errors = new cloudwatch.Alarm(this, "ErrorsAlarm", {
      alarmName: `trader-${env}-errors`,
      alarmDescription: "The Trader engine Lambda threw (failed config, crash, or an uncaught job error).",
      metric: fn.metricErrors({ period: Duration.minutes(15), statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const silent = new cloudwatch.Alarm(this, "SilenceAlarm", {
      alarmName: `trader-${env}-not-running`,
      alarmDescription: "No Trader engine invocation in an hour: the schedule or the function is broken.",
      metric: fn.metricInvocations({ period: Duration.hours(1), statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    // The MCP server is idle between routine runs and chats, so there's no
    // silence alarm; but a crash (bad deploy, SSM failure) must not show up only
    // as a missing strategy.activated email after the 8:00 ET run (#13). Tool
    // failures are reported to Claude in-band and don't count; only throws do.
    const mcpErrors = new cloudwatch.Alarm(this, "McpErrorsAlarm", {
      alarmName: `trader-${env}-mcp-errors`,
      alarmDescription: "The Trader MCP Lambda threw (crash, failed config load, or an unhandled error). Claude's routine and chats can't reach Trader.",
      metric: mcp.metricErrors({ period: Duration.minutes(15), statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    for (const alarm of [errors, silent, mcpErrors]) {
      alarm.addAlarmAction(notify);
      alarm.addOkAction(notify);
    }
  }
}
