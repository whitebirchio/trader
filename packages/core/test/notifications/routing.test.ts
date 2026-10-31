import { describe, expect, it } from "vitest";
import { AUDIT_KINDS } from "../../src/audit.js";
import { DIGEST_KINDS, URGENT_KINDS, routeFor } from "../../src/notifications/routing.js";

describe("routing (SPEC-notifications)", () => {
  it("routes every audit kind to exactly one class", () => {
    for (const kind of AUDIT_KINDS) {
      expect(["urgent", "digest", "ignore"]).toContain(routeFor(kind));
    }
    expect(new Set([...URGENT_KINDS, ...DIGEST_KINDS]).size).toBe(URGENT_KINDS.length + DIGEST_KINDS.length);
  });

  it("sends anything that stops trading or needs the owner immediately", () => {
    for (const kind of ["risk.halted", "risk.kill_switch_on", "risk.resumed", "risk.buys_paused", "broker.config_unsafe", "broker.account_changed", "broker.reconcile_mismatch", "broker.trading_allowed", "order.external", "order.unknown", "job.failed"]) {
      expect(routeFor(kind), kind).toBe("urgent");
    }
  });

  it("rolls trades and guardrail decisions into the digest", () => {
    for (const kind of ["order.submitted", "order.filled", "order.partially_filled", "order.canceled", "order.rejected", "risk.order_clipped", "risk.order_rejected", "risk.buys_resumed"]) {
      expect(routeFor(kind), kind).toBe("digest");
    }
  });

  it("doesn't email order intents, and treats an unknown kind as urgent rather than dropping it", () => {
    expect(routeFor("order.intent")).toBe("ignore");
    expect(routeFor("something.new")).toBe("urgent");
  });
});
