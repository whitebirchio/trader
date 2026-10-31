-- broker_activities is insert-only, like audit_events (ADR-008): Alpaca's
-- activity log is history, and tax lots are derived from it.
CREATE FUNCTION "reject_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (ADR-008): % rejected', TG_TABLE_NAME, TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "broker_activities_no_update_delete" BEFORE UPDATE OR DELETE ON "broker_activities"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
CREATE TRIGGER "broker_activities_no_truncate" BEFORE TRUNCATE ON "broker_activities"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
-- trader_app got full DML via default privileges when 0002 created the table.
-- Guarded so the migration also runs where the role doesn't exist (PGlite tests).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'trader_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "broker_activities" FROM trader_app;
  END IF;
END $$;
