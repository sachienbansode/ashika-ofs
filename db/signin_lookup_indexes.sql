-- ===========================================================================
-- Sign-in is slow because the client lookup cannot use an index.
--
-- lib/clientAuth.js findClients() has to match dirty data, so every predicate
-- is wrapped:   lower(btrim(coalesce(email,'')))
--               right(regexp_replace(coalesce(mobile,''),'[^0-9]','','g'),10)
--               upper(btrim(ucc))
-- A wrapped column cannot use an ordinary index, so each sign-in sequentially
-- scans dwh.tbl_user_info (~136,700 rows) AND stg.ask_clientmast, joined on
-- upper(btrim(...)) which cannot use one either — then does it again across the
-- internet, because the app is on Azure and this database is on AWS.
--
-- The cure is an index on the SAME EXPRESSION the query uses. Every function
-- here is immutable, so PostgreSQL will accept and use them.
--
-- Run in pgAdmin against uat_ananta_staging.
--
-- CONCURRENTLY: builds without taking a write lock, so the platform keeps
-- working while it runs. It must NOT be inside a transaction — run these one at
-- a time, with pgAdmin's "auto-commit" ON. Each may take a few minutes.
-- They add no columns and change no rows; dropping them later is instant.
-- ===========================================================================

-- ---- what the sign-in actually costs today -------------------------------
-- Run this FIRST and keep the number. Substitute a real registered address.
EXPLAIN (ANALYZE, BUFFERS)
SELECT upper(btrim(u.ucc)) AS ucc
  FROM dwh.tbl_user_info u
  LEFT JOIN stg.ask_clientmast c
    ON upper(btrim(c.ctermcode)) = upper(btrim(u.ucc))
 WHERE (lower(btrim(COALESCE(u.email,''))) = 'someone@example.com'
     OR lower(btrim(COALESCE(c.email_id,''))) = 'someone@example.com')
   AND lower(btrim(COALESCE(u.status, ''))) = 'active'
 ORDER BY 1 LIMIT 25;

-- ---- the join key, which both sides pay for -------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS tbl_user_info_ucc_norm_ix
  ON dwh.tbl_user_info (upper(btrim(ucc)));

CREATE INDEX CONCURRENTLY IF NOT EXISTS ask_clientmast_ctermcode_norm_ix
  ON stg.ask_clientmast (upper(btrim(ctermcode)));

-- ---- sign-in by email -----------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS tbl_user_info_email_norm_ix
  ON dwh.tbl_user_info (lower(btrim(COALESCE(email, ''))));

CREATE INDEX CONCURRENTLY IF NOT EXISTS ask_clientmast_email_norm_ix
  ON stg.ask_clientmast (lower(btrim(COALESCE(email_id, ''))));

-- ---- sign-in by mobile (last ten digits, however it is stored) ------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS tbl_user_info_mobile10_ix
  ON dwh.tbl_user_info (right(regexp_replace(COALESCE(mobile, ''), '[^0-9]', '', 'g'), 10));

CREATE INDEX CONCURRENTLY IF NOT EXISTS ask_clientmast_mobile10_ix
  ON stg.ask_clientmast (right(regexp_replace(COALESCE(mobile, ''), '[^0-9]', '', 'g'), 10));

-- ---- let the planner see them ---------------------------------------------
ANALYZE dwh.tbl_user_info;
ANALYZE stg.ask_clientmast;

-- ---- then run the EXPLAIN at the top again and compare --------------------
-- Expect "Seq Scan on tbl_user_info" to become an Index Scan, and the total
-- time to fall from seconds to milliseconds.

-- To undo, any time, with no effect on data:
--   DROP INDEX CONCURRENTLY dwh.tbl_user_info_ucc_norm_ix;   -- etc.
