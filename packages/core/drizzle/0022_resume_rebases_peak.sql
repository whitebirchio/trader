-- A resume re-bases the drawdown (ADR-017): risk_state records when the owner
-- last cleared a halt, and the halt then measures from that level until the
-- index regains its old peak.
ALTER TABLE "risk_state" ADD COLUMN "resumed_at" timestamp with time zone;
--> statement-breakpoint
-- Moving resumed_at moves the halt's base, so like clearing a halt it's the
-- owner's alone (0021). Same function, one more column guarded.
CREATE OR REPLACE FUNCTION "risk_state_owner_only_resume"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  table_owner name;
BEGIN
  SELECT tableowner INTO table_owner FROM pg_tables WHERE schemaname = TG_TABLE_SCHEMA AND tablename = TG_TABLE_NAME;
  IF current_user = table_owner THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'risk_state: only the owner can % it (ADR-012), not %', TG_OP, current_user;
  END IF;
  IF (OLD.kill_switch AND NOT NEW.kill_switch) OR (OLD.halted AND NOT NEW.halted) THEN
    RAISE EXCEPTION 'risk_state: only the owner can clear the kill switch or a halt (ADR-012), not %', current_user;
  END IF;
  IF NEW.resumed_at IS DISTINCT FROM OLD.resumed_at THEN
    RAISE EXCEPTION 'risk_state: only the owner can move resumed_at (ADR-017), not %', current_user;
  END IF;
  RETURN NEW;
END;
$$;
