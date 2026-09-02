-- 013 — a cut-off bid must carry the FLOOR PRICE, not zero.
--
-- BSE Notice 20150122-30 (22 Jan 2015), "Comprehensive Modified Guidelines for
-- Bidding in OFS Segment", supplied by Ashika on 2 Sep 2026, says it twice:
--
--   Annexure 1, Price field:
--     "Bid price which should be more or equal to the floor price. Please mention
--      floor price when category is RIC."
--   Section 4.3.5:
--     "Margin for bids placed at cut-off price shall be at the floor price."
--
-- We were writing 0, which fails the exchange's own at-or-above-floor check — every
-- retail cut-off row in an uploaded file would have come back rejected.
--
-- Only the DEFAULT is changed. A desk that has deliberately set 'zero' keeps it,
-- because an exchange may yet ask for that in writing; but nobody gets it by accident.
UPDATE ofs.ofs_setting
   SET value = 'floor',
       description = 'Price written for a cut-off bid: floor (per BSE 20150122-30) | zero',
       updated_at = now(),
       updated_by = 'migration-013'
 WHERE key = 'cutoff_price_mode' AND value = 'zero';

INSERT INTO ofs.ofs_setting (key, value, description) VALUES
  ('cutoff_price_mode', 'floor', 'Price written for a cut-off bid: floor (per BSE 20150122-30) | zero')
ON CONFLICT (key) DO NOTHING;
