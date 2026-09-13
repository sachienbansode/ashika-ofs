-- 021 — a removed margin record must be loggable.
--
-- ofs_margin_log.new_value was NOT NULL, and DELETE /api/margin/:ucc logs the
-- removal with new_value = NULL to mean "there is no longer a value" — which is a
-- different fact from "the value is now zero", and the distinction is the whole
-- point of the row. The insert raised 23502 inside the same transaction as the
-- DELETE, so the delete rolled back too: a margin record could be zeroed but never
-- removed, and the desk was told "new_value is required" with no idea why.
--
-- NULL now means removed. Every other writer still supplies a number.
ALTER TABLE ofs.ofs_margin_log ALTER COLUMN new_value DROP NOT NULL;

COMMENT ON COLUMN ofs.ofs_margin_log.new_value IS
  'The margin after the change. NULL means the record was removed, which is not the same as zero.';
