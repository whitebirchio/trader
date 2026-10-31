-- risk_gate_runs and risk_decisions are insert-only (ADR-008): they are the
-- record of what the guardrails saw and decided.
CREATE TRIGGER "risk_gate_runs_no_update_delete" BEFORE UPDATE OR DELETE ON "risk_gate_runs"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
CREATE TRIGGER "risk_gate_runs_no_truncate" BEFORE TRUNCATE ON "risk_gate_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
CREATE TRIGGER "risk_decisions_no_update_delete" BEFORE UPDATE OR DELETE ON "risk_decisions"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
CREATE TRIGGER "risk_decisions_no_truncate" BEFORE TRUNCATE ON "risk_decisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'trader_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "risk_gate_runs", "risk_decisions" FROM trader_app;
  END IF;
END $$;
--> statement-breakpoint
-- The single risk_state row: trading allowed, no halt, no kill switch.
INSERT INTO "risk_state" ("id") VALUES (1) ON CONFLICT DO NOTHING;
