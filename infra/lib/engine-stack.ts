import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, Stack, type StackProps, Tags } from "aws-cdk-lib";
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
import { TICK_JOBS } from "@trader/core";
import type { Construct } from "constructs";
import { MAIL_DOMAIN, NOTIFY_FROM, OWNER_EMAIL, type TradingEnv, secretsPath } from "./config.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export interface EngineStackProps extends StackProps {
  tradingEnv: TradingEnv;
  /**
   * SES identities are account-wide, so exactly one stack creates them
   * (staging) and the other only references them by name.
   */
  ownsSesIdentities: boolean;
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
      bundling: { format: OutputFormat.ESM, target: "node22", minify: true, sourceMap: true, mainFields: ["module", "main"],
        // ESM bundles still meet CommonJS deps; give them a require().
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
    });

    // Secrets: only this environment's SSM path (ADR-005). aws/ssm decrypt is implied for SecureStrings.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadOwnSecrets",
        actions: ["ssm:GetParametersByPath"],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/trader/${env}`],
      }),
    );

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

    if (props.ownsSesIdentities) {
      const domain = new ses.EmailIdentity(this, "MailDomain", { identity: ses.Identity.domain(MAIL_DOMAIN) });
      new ses.EmailIdentity(this, "OwnerAddress", { identity: ses.Identity.email(OWNER_EMAIL) });
      domain.dkimRecords.forEach((r, i) => {
        new CfnOutput(this, `DkimRecord${i + 1}`, { value: `${r.name} CNAME ${r.value}`, description: "Add in Cloudflare DNS (DNS only)" });
      });
    }

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

    // Public health check only: it reveals liveness, nothing about the account.
    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    new CfnOutput(this, "HealthUrl", { value: `${url.url}healthz` });

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
    for (const alarm of [errors, silent]) {
      alarm.addAlarmAction(notify);
      alarm.addOkAction(notify);
    }
  }
}
