-- Archive closed OFS issues without losing anything.
--
-- Archiving is a FLAG, not a move: bids, exports, allotments and audit rows keep
-- pointing at the same issue id, so an archived issue can still be opened in full
-- years later. Nothing is deleted — this is a regulated bidding record.

ALTER TABLE ofs.ofs_issue ADD COLUMN IF NOT EXISTS archived_at    timestamptz;
ALTER TABLE ofs.ofs_issue ADD COLUMN IF NOT EXISTS archived_by    text;
ALTER TABLE ofs.ofs_issue ADD COLUMN IF NOT EXISTS archive_reason text;

-- The desk's open lists filter on this, so it needs to be cheap.
CREATE INDEX IF NOT EXISTS ofs_issue_live_ix ON ofs.ofs_issue (greatest(hni_close, ret_close) DESC)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS ofs_issue_archived_ix ON ofs.ofs_issue (archived_at DESC)
  WHERE archived_at IS NOT NULL;

INSERT INTO ofs.ofs_setting (key, value, description) VALUES
  ('archive_after_days', '7',
   'Days after the last bidding window closes before an issue is offered for archiving')
ON CONFLICT (key) DO NOTHING;

-- One row per issue with everything the desk needs to judge it at a glance.
-- Built as a view so an archived issue reports the same figures it always did.
CREATE OR REPLACE VIEW ofs.ofs_issue_summary AS
SELECT i.id,
       i.symbol, i.company, i.isin, i.exchange, i.issue_date,
       i.floor_price, i.cut_price_min, i.discount_pct,
       i.issue_qty, i.retail_qty,
       i.hni_open, i.hni_close, i.ret_open, i.ret_close,
       i.status, i.source, i.archived_at, i.archived_by, i.archive_reason,
       i.created_at, i.updated_at,
       COALESCE(b.bids, 0)            AS bid_count,
       COALESCE(b.live_bids, 0)       AS live_bids,
       COALESCE(b.cancelled_bids, 0)  AS cancelled_bids,
       COALESCE(b.clients, 0)         AS client_count,
       COALESCE(b.qty, 0)             AS total_qty,
       COALESCE(b.value, 0)           AS total_value,
       COALESCE(b.ret_qty, 0)         AS retail_qty_bid,
       COALESCE(b.ret_value, 0)       AS retail_value_bid,
       COALESCE(b.hni_qty, 0)         AS hni_qty_bid,
       COALESCE(b.hni_value, 0)       AS hni_value_bid,
       b.vwap,
       COALESCE(x.files, 0)           AS files_generated,
       x.last_export_at,
       COALESCE(a.allottees, 0)       AS allottees,
       COALESCE(a.allot_qty, 0)       AS allot_qty,
       COALESCE(a.allot_value, 0)     AS allot_value,
       COALESCE(a.mails_sent, 0)      AS allot_mails_sent
  FROM ofs.ofs_issue i
  LEFT JOIN (
    SELECT issue_id,
           count(*)                                            AS bids,
           count(*) FILTER (WHERE status = 'Live')             AS live_bids,
           count(*) FILTER (WHERE status = 'Cancelled')        AS cancelled_bids,
           count(DISTINCT client_ucc)                          AS clients,
           sum(qty) FILTER (WHERE status <> 'Cancelled')       AS qty,
           sum(value) FILTER (WHERE status <> 'Cancelled')     AS value,
           sum(qty) FILTER (WHERE category = 'Retail' AND status <> 'Cancelled')   AS ret_qty,
           sum(value) FILTER (WHERE category = 'Retail' AND status <> 'Cancelled') AS ret_value,
           sum(qty) FILTER (WHERE category = 'HNI' AND status <> 'Cancelled')      AS hni_qty,
           sum(value) FILTER (WHERE category = 'HNI' AND status <> 'Cancelled')    AS hni_value,
           CASE WHEN sum(qty) FILTER (WHERE NOT is_cutoff AND status <> 'Cancelled') > 0
                THEN sum(qty * price) FILTER (WHERE NOT is_cutoff AND status <> 'Cancelled')
                   / sum(qty) FILTER (WHERE NOT is_cutoff AND status <> 'Cancelled') END AS vwap
      FROM ofs.ofs_bid GROUP BY issue_id
  ) b ON b.issue_id = i.id
  LEFT JOIN (
    SELECT issue_id, count(*) AS files, max(generated_at) AS last_export_at
      FROM ofs.ofs_export_log GROUP BY issue_id
  ) x ON x.issue_id = i.id
  LEFT JOIN (
    SELECT issue_id,
           count(*) FILTER (WHERE allot_qty > 0)        AS allottees,
           sum(allot_qty)                               AS allot_qty,
           sum(allot_value)                             AS allot_value,
           count(*) FILTER (WHERE mail_status = 'sent') AS mails_sent
      FROM ofs.ofs_allotment GROUP BY issue_id
  ) a ON a.issue_id = i.id;
