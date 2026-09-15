-- 023 — zero-all could never work, on a book of any size.
--
-- POST /api/margin/reset writes source = 'reset' into ofs_margin.source, and the
-- CHECK constraint from migration 001 permits only manual, csv and rms. Every call
-- — the Masters button AND the nightly job the Stage API scheduler calls — failed
-- with 23514, which dbErr turns into "Margin source must be manual, csv or rms."
--
-- So margins were never actually cleared. A figure uploaded on Monday stayed
-- available all week unless someone overwrote it, which is the exact thing the
-- reset exists to prevent: yesterday's margin funding today's bid.
--
-- Found by running the application against a real schema end to end. The
-- row-by-row timeout fixed in the previous commit was a second, independent fault
-- in the same endpoint — fixing it only got the request as far as this one.
ALTER TABLE ofs.ofs_margin DROP CONSTRAINT IF EXISTS ofs_margin_src_ck;
ALTER TABLE ofs.ofs_margin ADD CONSTRAINT ofs_margin_src_ck
  CHECK (source IN ('manual','csv','rms','reset'));

COMMENT ON COLUMN ofs.ofs_margin.source IS
  'Where the figure came from: manual (typed), csv (uploaded), rms (fed), '
  'reset (zeroed at start of day). ofs_margin_log.source carries the same values.';

-- The sign-in page answers the same way whether or not an identifier belongs to a
-- client. Migration 009 seeded 'reveal', which names what was typed back — kinder
-- to an investor who mistyped, and a yes/no oracle over Ashika's client base to
-- anyone else. The code default is 'generic'; a row in the table always beats a
-- code default, so the seeded row is brought into line here.
--
-- Only the untouched seed is changed: a desk that has since chosen 'reveal'
-- deliberately keeps it.
UPDATE ofs.ofs_setting
   SET value = 'generic'
 WHERE key = 'client_login_unknown'
   AND value = 'reveal'
   AND updated_by IS NULL;
