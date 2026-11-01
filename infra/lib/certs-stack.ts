import { CfnOutput, Stack, type StackProps, Tags } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import type { Construct } from "constructs";
import { DASHBOARD_DOMAINS } from "./config.js";

/**
 * One certificate for both dashboard names (SPEC-dashboard). It's its own
 * stack because DNS validation waits until the owner adds the CNAMEs in
 * Cloudflare (`aws acm describe-certificate` lists them). Deploy it once from
 * the laptop; the engine stacks then reference it.
 */
export class CertsStack extends Stack {
  readonly dashboardCertificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    Tags.of(this).add("app", "trader");
    const cert = new acm.Certificate(this, "Dashboard", {
      domainName: DASHBOARD_DOMAINS.production,
      subjectAlternativeNames: [DASHBOARD_DOMAINS.staging],
      validation: acm.CertificateValidation.fromDns(),
    });
    this.dashboardCertificate = cert;
    new CfnOutput(this, "DashboardCertificateArn", { value: cert.certificateArn });
  }
}
