-- ===========================================================================
-- GO-LIVE RESET — clears every row of TEST data from the OFS database.
--
-- Run ONCE, in pgAdmin, against ofs_bids, before the first live offer.
-- It is destructive and it is not reversible: take a backup first.
--
-- WHAT IT CLEARS
--   Every bid, allotment, margin and margin history row, every issue and its
--   documents, every circular and sync/export run, every audit line, every
--   session and every one-time code. The desk starts the day with an empty book.
--
-- WHAT IT KEEPS, deliberately
--   ofs_setting         the desk's configuration - cut-off, retail cap, HNI
--                       minimum, allowed exchanges. These were seeded by the
--                       migrations, which are already marked applied, so
--                       emptying this table would NOT re-seed it: the desk would
--                       come up on code defaults with no way to tell.
--   ofs_branch_setting  per-branch access overrides (a branch the desk has
--                       disabled stays disabled - clearing it would silently let
--                       them back in).
--   ofs._migration      the record of which migrations have run. Clearing it
--                       makes the next deploy try to re-apply all of them.
--
-- To clear either of the first two as well, say so explicitly and re-check the
-- settings screen afterwards. Do not add them to this script.
--
-- NOTHING in this script touches uat_ananta_staging. The client master, the
-- branch master and the staff accounts live there and are NOT ours to clear.
-- ===========================================================================

BEGIN;

-- Guard. This is the only thing standing between a go-live reset and the
-- production client master, and it costs nothing.
DO $$
BEGIN
  IF current_database() <> 'ofs_bids' THEN
    RAISE EXCEPTION 'Refusing to run: connected to %, not ofs_bids', current_database();
  END IF;
  IF to_regclass('ofs.ofs_bid') IS NULL THEN
    RAISE EXCEPTION 'Refusing to run: no ofs.ofs_bid here - wrong database or wrong schema';
  END IF;
END $$;

-- What is about to go, so the output is a record of what was cleared.
SELECT 'before' AS stage, relname AS tbl, n_live_tup AS approx_rows
  FROM pg_stat_user_tables
 WHERE schemaname = 'ofs'
 ORDER BY relname;

-- Every table in the ofs schema except the three named above. Built from the
-- catalogue rather than a hand-written list, so a table added by a later
-- migration cannot be quietly left full of test data.
--
-- ONE TRUNCATE for the lot: ofs_bid references ofs_issue ON DELETE RESTRICT, so
-- truncating them separately would be refused. RESTART IDENTITY so the first
-- live bid is id 1 and the reference numbers start clean.
DO $$
DECLARE
  keep text[] := ARRAY['ofs_setting', 'ofs_branch_setting', '_migration'];
  list text;
BEGIN
  SELECT string_agg(format('ofs.%I', tablename), ', ' ORDER BY tablename)
    INTO list
    FROM pg_tables
   WHERE schemaname = 'ofs' AND NOT (tablename = ANY (keep));

  IF list IS NULL THEN
    RAISE EXCEPTION 'Nothing to clear - is the ofs schema empty?';
  END IF;

  RAISE NOTICE 'Clearing: %', list;
  EXECUTE format('TRUNCATE TABLE %s RESTART IDENTITY CASCADE', list);
END $$;

-- And what is left. Every row here should be configuration, nothing else.
SELECT 'after' AS stage, relname AS tbl, n_live_tup AS approx_rows
  FROM pg_stat_user_tables
 WHERE schemaname = 'ofs'
 ORDER BY relname;

SELECT key, value FROM ofs.ofs_setting ORDER BY key;

-- Read the two lists above. If they are right:
COMMIT;
-- If they are not:
-- ROLLBACK;
