-- ============================================================================
-- Which exchange is this bid going to?
--
-- ofs_issue.exchange says where the OFS is listed — NSE, BSE, or BOTH. A BID had no
-- exchange at all, and routes/export.js never filtered on one. The consequences were
-- not subtle:
--
--   * an issue listed on NSE only still had its bids written into the BSE file
--   * an issue listed on BOTH had every bid written into BOTH files, so uploading
--     both files submits the same client's bid twice, once to each exchange
--
-- A bid goes to exactly one exchange. Where the issue is on one exchange that is
-- decided for you; where it is on BOTH, somebody has to choose, and now does.
--
-- Backfill: every existing bid takes its issue's exchange when that is unambiguous.
-- A bid on a BOTH issue cannot be guessed — nobody has ever chosen for it — so it is
-- left NULL and the export refuses to file it until the desk says which. Guessing
-- here would silently route real money to an exchange nobody picked.
-- ============================================================================

ALTER TABLE ofs.ofs_bid ADD COLUMN IF NOT EXISTS exchange text;

ALTER TABLE ofs.ofs_bid DROP CONSTRAINT IF EXISTS ofs_bid_exchange_ck;
ALTER TABLE ofs.ofs_bid ADD CONSTRAINT ofs_bid_exchange_ck
  CHECK (exchange IS NULL OR exchange IN ('NSE','BSE'));

UPDATE ofs.ofs_bid b
   SET exchange = i.exchange
  FROM ofs.ofs_issue i
 WHERE i.id = b.issue_id
   AND b.exchange IS NULL
   AND i.exchange IN ('NSE','BSE');

CREATE INDEX IF NOT EXISTS ofs_bid_exchange_ix ON ofs.ofs_bid (exchange, issue_id)
  WHERE status IN ('Live','Modified');
