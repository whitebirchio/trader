-- Only the owner resumes trading (ADR-012), enforced by the database. The
-- engine and MCP roles may turn the kill switch or a halt ON, but clearing
-- either, or deleting the row (whose re-insert would default to "running"),
-- needs the role that owns the table: the owner, which risk:resume connects as
-- (scripts/ops.ts). Any other role's attempt raises.
CREATE FUNCTION "risk_state_owner_only_resume"() RETURNS trigger LANGUAGE plpgsql AS $$
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
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "risk_state_owner_only_resume" BEFORE UPDATE OR DELETE ON "risk_state"
  FOR EACH ROW EXECUTE FUNCTION "risk_state_owner_only_resume"();
--> statement-breakpoint
CREATE TRIGGER "risk_state_owner_only_truncate" BEFORE TRUNCATE ON "risk_state"
  FOR EACH STATEMENT EXECUTE FUNCTION "risk_state_owner_only_resume"();
