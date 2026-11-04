-- One-off backfill (additive): give the equity index a base at the close before
-- the first snapshot, so the first trading day's return counts. Before this,
-- the index started at the first trading day's close, which hid day one.
--
-- Only when the account was all cash until then: every broker activity before
-- the first snapshot's trading day is a capital flow (no fills, dividends or
-- fees). Its equity at that close is then the net of the flows so far. The
-- sync seeds the base itself for any environment that starts later
-- (writeSnapshot), so this matters only for the environments live today.
INSERT INTO "equity_snapshots" ("trading_date", "equity", "cash", "long_market_value", "recorded_at")
SELECT b."trading_date", f."net", f."net", 0, b."closed_at"
FROM (SELECT min("trading_date") AS "first" FROM "equity_snapshots") s
CROSS JOIN LATERAL (
  SELECT "trading_date", ("trading_date" + time '16:00') AT TIME ZONE 'America/New_York' AS "closed_at"
  FROM "benchmark_closes"
  WHERE "symbol" = 'VTI' AND "trading_date" < s."first"
  ORDER BY "trading_date" DESC
  LIMIT 1
) b
CROSS JOIN LATERAL (
  SELECT coalesce(sum("amount"), 0) AS "net"
  FROM "capital_flows"
  WHERE ("status" IS NULL OR "status" <> 'canceled') AND "at" <= b."closed_at"
) f
WHERE NOT EXISTS (
  SELECT 1 FROM "broker_activities" a
  WHERE a."at" < (s."first"::timestamp) AT TIME ZONE 'America/New_York'
    AND a."id" NOT IN (SELECT "activity_id" FROM "capital_flows")
)
ON CONFLICT ("trading_date") DO NOTHING;
