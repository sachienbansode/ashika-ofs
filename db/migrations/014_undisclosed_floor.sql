-- 014 — an OFS may run WITHOUT a published floor price.
--
-- NSE "FAQs on e-OFS" v3.0 (March 2026), Q12:
--   "Floor price is the minimum price at which seller wants to sell his shares.
--    However, this information is not declared to the market & is informed to the
--    designated exchange one day prior to the day of OFS after the closure of the
--    trading hours."
--
-- BSE Notice 20150122-30 §1.4 agrees by implication — "In case of disclosure of the
-- Floor Price, seller shall disclose..." — i.e. disclosure is the seller's choice.
--
-- Our schema made it NOT NULL and CHECK (> 0), so an undisclosed-floor OFS could not
-- be represented at all. The desk would have had to invent a number, and every price
-- check downstream would then have been enforcing a fiction.
--
-- NULL now means "not disclosed", which is different from zero. lib/domain.js skips
-- the below-floor check when it is NULL rather than comparing against 0 and
-- rejecting every bid.
ALTER TABLE ofs.ofs_issue ALTER COLUMN floor_price DROP NOT NULL;

ALTER TABLE ofs.ofs_issue DROP CONSTRAINT IF EXISTS ofs_issue_price_ck;
ALTER TABLE ofs.ofs_issue ADD CONSTRAINT ofs_issue_price_ck
  CHECK ((floor_price IS NULL OR floor_price > 0) AND tick > 0 AND lot >= 1);

COMMENT ON COLUMN ofs.ofs_issue.floor_price IS
  'Floor price, or NULL when the seller has not disclosed it (NSE e-OFS FAQ v3.0 Q12). '
  'NULL is not zero: it means no minimum can be enforced by us, and the exchange '
  'applies the floor at matching.';

-- The seller declares this a day ahead (NSE FAQ Q6) and it decides allotment
-- (Q13). The desk had nowhere to record it.
ALTER TABLE ofs.ofs_issue ADD COLUMN IF NOT EXISTS allocation_method text;
ALTER TABLE ofs.ofs_issue DROP CONSTRAINT IF EXISTS ofs_issue_alloc_ck;
ALTER TABLE ofs.ofs_issue ADD CONSTRAINT ofs_issue_alloc_ck
  CHECK (allocation_method IS NULL OR allocation_method IN ('price_priority','proportionate'));

-- NSE FAQ Q14: "the issuer of the OFS can withdraw his offer before the opening of
-- the OFS." That is not the same as the desk suspending it, and the client should be
-- told which happened.
ALTER TABLE ofs.ofs_issue DROP CONSTRAINT IF EXISTS ofs_issue_status_ck;
ALTER TABLE ofs.ofs_issue ADD CONSTRAINT ofs_issue_status_ck
  CHECK (status IN ('Auto','Suspended','Closed','Withdrawn'));
