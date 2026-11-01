import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CiStack } from "../lib/ci-stack.js";

const env = { account: "111111111111", region: "us-east-1" };
const template = Template.fromStack(new CiStack(new App(), "TraderCi", { env }));

describe("TraderCi", () => {
  it("creates GitHub's OIDC provider natively (no custom resource)", () => {
    template.hasResourceProperties("AWS::IAM::OIDCProvider", {
      Url: "https://token.actions.githubusercontent.com",
      ClientIdList: ["sts.amazonaws.com"],
    });
    template.resourceCountIs("AWS::Lambda::Function", 0);
  });

  it("trusts only this repository's workflows, by immutable org and repo id", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "trader-github-deploy",
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
              StringLike: { "token.actions.githubusercontent.com:sub": "repo:whitebirchio@104479267/trader@1440835277:*" },
            },
          }),
        ],
      },
    });
  });

  it("can only assume CDK's bootstrap roles", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const statements = Object.values(policies).flatMap(
      (p) => (p as { Properties: { PolicyDocument: { Statement: unknown[] } } }).Properties.PolicyDocument.Statement,
    );
    expect(statements).toEqual([
      {
        Sid: "AssumeCdkBootstrapRoles",
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Resource: "arn:aws:iam::111111111111:role/cdk-hnb659fds-*-111111111111-us-east-1",
      },
    ]);
  });
});
