import { CfnOutput, Duration, Fn, RemovalPolicy, Stack } from "aws-cdk-lib";
import type * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { DASHBOARD_DOMAINS, GOOGLE_CLIENT_ID, OWNER_EMAIL, type TradingEnv, secretsPath } from "./config.js";

export interface DashboardProps {
  tradingEnv: TradingEnv;
  certificate: acm.ICertificate;
  /** The packaged app (apps/dashboard/dist/app, from `npm run build -w trader-dashboard`). */
  codeDir: string;
}

/** Secrets the dashboard may read, by exact name. Never the Alpaca keys. */
export const DASHBOARD_SECRETS = ["DATABASE_READ_URL", "GOOGLE_CLIENT_SECRET", "DASHBOARD_SESSION_KEY"] as const;

/** Requests one environment serves at once (1–128). */
export const DASHBOARD_CONCURRENCY_PER_ENVIRONMENT = 32;

/**
 * The read-only dashboard (SPEC-dashboard; D1 spike findings): a Lambda Web
 * Function whose IamAuth endpoint only this CloudFront distribution can call
 * (OAC + resource policy), so the raw endpoint URL refuses everyone else.
 */
export class Dashboard extends Construct {
  constructor(scope: Construct, id: string, props: DashboardProps) {
    super(scope, id);
    const env = props.tradingEnv;
    const { account, region } = Stack.of(this);
    const name = `trader-dashboard-${env}`;
    const domain = DASHBOARD_DOMAINS[env];

    // Code: Web Functions load it only from a versioned bucket of ours. A
    // revision pins an object version, and deleting that version fails the
    // revision for good, so only noncurrent versions ever expire.
    const bucket = new s3.Bucket(this, "Code", {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
    });
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "WebFunctionReadsCode",
        principals: [new iam.ServicePrincipal("lambda.amazonaws.com")],
        actions: ["s3:GetObject", "s3:GetObjectVersion"],
        resources: [bucket.arnForObjects("*")],
        conditions: { ArnLike: { "aws:SourceArn": `arn:aws:lambda:${region}:${account}:web-function/${name}/revision/*` } },
      }),
    );
    const upload = new s3deploy.BucketDeployment(this, "Upload", {
      sources: [s3deploy.Source.asset(props.codeDir)],
      destinationBucket: bucket,
      extract: false,
      prune: true,
      memoryLimit: 512,
    });

    // Logs land in "<group>.local" and are centralized into "<group>"; create
    // both, so neither is auto-created without retention.
    const logGroupName = `/aws/lambda/web/${name}`;
    for (const [lid, groupName] of [["Logs", logGroupName], ["LocalLogs", `${logGroupName}.local`]] as const) {
      new logs.LogGroup(this, lid, { logGroupName: groupName, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
    }

    const role = new iam.Role(this, "Role", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteOwnLogs",
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [`arn:aws:logs:${region}:${account}:log-group:${logGroupName}:*`, `arn:aws:logs:*:${account}:log-group:${logGroupName}.local:*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadDashboardSecrets",
        actions: ["ssm:GetParameters"],
        resources: DASHBOARD_SECRETS.map((s) => `arn:aws:ssm:${region}:${account}:parameter${secretsPath(env)}${s}`),
      }),
    );

    const fn = new lambda.CfnWebFunction(this, "Function", { functionName: name, tags: [{ key: "app", value: "trader" }, { key: "env", value: env }] });
    const revision = new lambda.CfnWebFunctionRevision(this, "Revision", {
      functionName: name,
      buildConfig: { codeConfig: { s3Object: { bucket: bucket.bucketName, key: Fn.select(0, upload.objectKeys) } }, runtimeConfig: { runtime: "nodejs24.x" } },
      serviceConfig: {
        executionRoleArn: role.roleArn,
        timeoutSeconds: 30,
        // One Next.js server handles many requests at once. Unset, an
        // environment took about one, so a page load's burst (the page plus a
        // prefetch per link on screen) outran the 2-environment cap and got
        // 429s (#123). This needs no extra environments, so the cap still bounds cost.
        maxConcurrencyPerEnvironment: DASHBOARD_CONCURRENCY_PER_ENVIRONMENT,
        environmentVariables: {
          NODE_ENV: "production",
          TRADING_ENV: env,
          DASHBOARD_URL: `https://${domain}`,
          OWNER_EMAIL,
          GOOGLE_CLIENT_ID,
          SECRETS_PATH: secretsPath(env),
        },
      },
    });
    revision.addDependency(fn);
    revision.node.addDependency(upload, bucket.policy!, role);

    const endpoint = new lambda.CfnWebFunctionEndpoint(this, "Endpoint", {
      functionName: name,
      endpointName: "main",
      endpointType: "HomeRegion",
      authType: "IamAuth",
      revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
      // Cost bounds: 2 is the minimum environment cap; 100 req/s is far above one person.
      scalingConfig: { maxEnvironments: 2 },
      throttleConfig: { rateLimit: 100 },
    });
    endpoint.addDependency(fn);

    const oac = new cloudfront.CfnOriginAccessControl(this, "Oac", {
      originAccessControlConfig: { name: `${name}-oac`, originAccessControlOriginType: "lambda", signingBehavior: "always-amz-auth", signingProtocol: "sigv4" },
    });
    const origin = new origins.HttpOrigin(endpoint.attrDomainName, { originId: "web-function", protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY });
    // OAC signs the origin request with the query string as sent, but Lambda
    // canonicalizes a literal "+" differently, so the signature fails (403
    // "not authorized to access this endpoint"). Google's callback always
    // carries scope=a+b+c. Re-encode "+" as "%20" (the same space) first.
    const plusAsSpace = new cloudfront.Function(this, "PlusAsSpace", {
      functionName: `${name}-plus-as-space`,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: "Re-encode + as %20 in query strings so OAC signatures verify",
      code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var qs = event.request.querystring;
  for (var key in qs) {
    var p = qs[key];
    if (typeof p.value === "string") p.value = p.value.replace(/\\+/g, "%20");
    if (p.multiValue) p.multiValue.forEach(function (m) { m.value = m.value.replace(/\\+/g, "%20"); });
  }
  return event.request;
}`),
    });
    const dynamicPages = {
      origin,
      functionAssociations: [{ function: plusAsSpace, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };
    const distribution = new cloudfront.Distribution(this, "Cdn", {
      comment: name,
      domainNames: [domain],
      certificate: props.certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: dynamicPages,
      // Hashed build assets never change: cache them at the edge (no data in them).
      additionalBehaviors: {
        "/_next/static/*": { origin, viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS, cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED },
      },
    });
    const cfn = distribution.node.defaultChild as cloudfront.CfnDistribution;
    cfn.addPropertyOverride("DistributionConfig.Origins.0.OriginAccessControlId", oac.attrId);

    new lambda.CfnResourcePolicy(this, "OnlyThisDistribution", {
      resourceArn: fn.attrFunctionArn,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowThisDistribution",
            Effect: "Allow",
            Principal: { Service: "cloudfront.amazonaws.com" },
            Action: "lambda:InvokeWebFunctionEndpoint",
            Resource: endpoint.attrEndpointArn,
            Condition: { StringEquals: { "aws:SourceArn": `arn:aws:cloudfront::${account}:distribution/${distribution.distributionId}` } },
          },
        ],
      },
    });

    new CfnOutput(Stack.of(this), "DashboardUrl", { value: `https://${domain}` });
    new CfnOutput(Stack.of(this), "DashboardCname", { value: `${domain} CNAME ${distribution.distributionDomainName}`, description: "Add in Cloudflare DNS (DNS only)" });
  }
}
