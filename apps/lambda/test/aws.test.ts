import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { clearSecretsCache, loadSecrets } from "../src/secrets.js";
import { SesMailer } from "../src/ses-mailer.js";

const ssmMock = mockClient(SSMClient);
const sesMock = mockClient(SESv2Client);

beforeEach(() => {
  ssmMock.reset();
  sesMock.reset();
  clearSecretsCache();
});

describe("loadSecrets", () => {
  it("reads every page under the path, decrypted, keyed by name", async () => {
    ssmMock
      .on(GetParametersByPathCommand, { Path: "/trader/staging/", WithDecryption: true, NextToken: undefined })
      .resolves({ Parameters: [{ Name: "/trader/staging/DATABASE_URL", Value: "postgres://x" }], NextToken: "t" })
      .on(GetParametersByPathCommand, { NextToken: "t" })
      .resolves({ Parameters: [{ Name: "/trader/staging/ALPACA_KEY_ID", Value: "PK1" }] });
    const values = await loadSecrets(new SSMClient({}), "/trader/staging/", 0);
    expect(values).toEqual({ DATABASE_URL: "postgres://x", ALPACA_KEY_ID: "PK1" });
  });

  it("caches per container for 15 minutes", async () => {
    ssmMock.on(GetParametersByPathCommand).resolves({ Parameters: [{ Name: "/trader/staging/A", Value: "1" }] });
    const ssm = new SSMClient({});
    await loadSecrets(ssm, "/trader/staging/", 0);
    await loadSecrets(ssm, "/trader/staging/", 14 * 60_000);
    expect(ssmMock.commandCalls(GetParametersByPathCommand)).toHaveLength(1);
    await loadSecrets(ssm, "/trader/staging/", 16 * 60_000);
    expect(ssmMock.commandCalls(GetParametersByPathCommand)).toHaveLength(2);
  });
});

describe("SesMailer", () => {
  it("sends text + HTML from Trader to the owner and returns the message id", async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: "ses-123" });
    const mailer = new SesMailer(new SESv2Client({}), "trader@whitebirch.io", "owner@example.com");
    expect(await mailer.send({ subject: "S", text: "T", html: "<p>H</p>" })).toEqual({ messageId: "ses-123" });
    const input = sesMock.commandCalls(SendEmailCommand)[0]?.args[0].input;
    expect(input).toMatchObject({
      FromEmailAddress: "Trader <trader@whitebirch.io>",
      Destination: { ToAddresses: ["owner@example.com"] },
      Content: { Simple: { Subject: { Data: "S" }, Body: { Text: { Data: "T" }, Html: { Data: "<p>H</p>" } } } },
    });
  });

  it("treats a missing message id as a failure (so the outbox retries)", async () => {
    sesMock.on(SendEmailCommand).resolves({});
    await expect(new SesMailer(new SESv2Client({}), "a@b.c", "d@e.f").send({ subject: "", text: "", html: "" })).rejects.toThrow();
  });
});
