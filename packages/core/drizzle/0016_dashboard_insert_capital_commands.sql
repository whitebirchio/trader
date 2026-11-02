-- The dashboard's one write (SPEC-capital, ADR-015): INSERT on capital_commands,
-- nothing else. trader_dashboard keeps default_transaction_read_only, so the
-- dashboard writes in an explicit READ WRITE transaction; it has no UPDATE or
-- DELETE anywhere, and capital_commands' trigger rejects them for everyone.
-- The engine validates and applies each command on its next tick.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'trader_dashboard') THEN
    GRANT INSERT ON "capital_commands" TO trader_dashboard;
  END IF;
END $$;
