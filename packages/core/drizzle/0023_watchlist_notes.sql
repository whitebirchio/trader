CREATE TABLE "watchlist_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" text NOT NULL,
	"action" text NOT NULL,
	"why" text NOT NULL,
	"trigger" text,
	"revisit_by" date,
	"actor" "audit_actor" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "watchlist_notes_symbol_idx" ON "watchlist_notes" USING btree ("symbol","at");
--> statement-breakpoint
-- Insert-only (ADR-008): a change to the watchlist is a new row.
CREATE TRIGGER "watchlist_notes_no_update_delete" BEFORE UPDATE OR DELETE ON "watchlist_notes"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
CREATE TRIGGER "watchlist_notes_no_truncate" BEFORE TRUNCATE ON "watchlist_notes"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
-- update_watchlist is the MCP server's second write (SPEC-agent, #32): INSERT only, as for strategies.
-- scripts/mcp-role.ts grants the same, so --check stays exact.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'trader_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "watchlist_notes" FROM trader_app;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'trader_mcp') THEN
    GRANT INSERT ON "watchlist_notes" TO trader_mcp;
  END IF;
END $$;
