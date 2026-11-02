-- Owner commands and their outcomes are insert-only (ADR-008): the record of what Scott asked for.
CREATE TRIGGER "capital_commands_no_update_delete" BEFORE UPDATE OR DELETE ON "capital_commands"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
CREATE TRIGGER "capital_commands_no_truncate" BEFORE TRUNCATE ON "capital_commands"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
CREATE TRIGGER "capital_command_results_no_update_delete" BEFORE UPDATE OR DELETE ON "capital_command_results"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
CREATE TRIGGER "capital_command_results_no_truncate" BEFORE TRUNCATE ON "capital_command_results"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'trader_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "capital_commands", "capital_command_results" FROM trader_app;
  END IF;
END $$;
