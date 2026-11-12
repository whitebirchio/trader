CREATE TABLE "thesis_lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thesis_id" text NOT NULL,
	"symbol" text NOT NULL,
	"primary_kind" text,
	"ending" text NOT NULL,
	"expected" text NOT NULL,
	"happened" text NOT NULL,
	"lesson" text NOT NULL,
	"outcome" jsonb NOT NULL,
	"actor" "audit_actor" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "thesis_lessons_symbol_idx" ON "thesis_lessons" USING btree ("symbol","at");--> statement-breakpoint
CREATE INDEX "thesis_lessons_thesis_idx" ON "thesis_lessons" USING btree ("thesis_id","at");--> statement-breakpoint
-- Insert-only (ADR-008): a new lesson on a thesis is a new row.
CREATE TRIGGER "thesis_lessons_no_update_delete" BEFORE UPDATE OR DELETE ON "thesis_lessons"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
CREATE TRIGGER "thesis_lessons_no_truncate" BEFORE TRUNCATE ON "thesis_lessons"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_mutation"();
--> statement-breakpoint
-- record_lesson is the MCP server's third write (SPEC-agent § Lessons, #28): INSERT only.
-- scripts/mcp-role.ts grants the same, so --check stays exact.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'trader_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "thesis_lessons" FROM trader_app;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'trader_mcp') THEN
    GRANT INSERT ON "thesis_lessons" TO trader_mcp;
  END IF;
END $$;
