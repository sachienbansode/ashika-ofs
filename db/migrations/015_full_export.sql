-- The desk's own bid extract is logged like any other generated file, so that
-- "who downloaded the full book, when" is answerable. ofs_export_log.exchange was
-- constrained to NSE|BSE, which is right for a file that reaches an exchange and
-- wrong for this one — it never leaves Ashika.
ALTER TABLE ofs.ofs_export_log DROP CONSTRAINT IF EXISTS ofs_export_exch_ck;
ALTER TABLE ofs.ofs_export_log ADD CONSTRAINT ofs_export_exch_ck
  CHECK (exchange IN ('NSE','BSE','ALL'));
