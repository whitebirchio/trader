import { Duration, Stack, type StackProps, Tags } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { CDK_QUALIFIER, GITHUB_OIDC_SUBJECT_PREFIX } from "./config.js";

/**
 * GitHub Actions → AWS without long-lived keys (SPEC-platform-aws). Deployed
 * once by the owner. The role can do nothing itself except assume CDK's
 * bootstrap roles, which perform the deploy: CDK's least-privilege pattern.
 */
export class CiStack extends Stack {
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    Tags.of(this).add("app", "trader");

    const provider = new iam.OidcProviderNative(this, "GitHubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    this.deployRole = new iam.Role(this, "DeployRole", {
      roleName: "trader-github-deploy",
      description: "Assumed by GitHub Actions in whitebirchio/trader to run cdk deploy",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        StringLike: { "token.actions.githubusercontent.com:sub": `${GITHUB_OIDC_SUBJECT_PREFIX}:*` },
      }),
    });

    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/cdk-${CDK_QUALIFIER}-*-${this.account}-${this.region}`],
      }),
    );
  }
}
