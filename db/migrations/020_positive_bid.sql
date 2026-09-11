-- ============================================================================
-- A bid cannot be negative.
--
-- ofs_bid had CHECK (qty > 0) and nothing at all on price or value. The application
-- check was `if (!p) ...`, which catches zero and blank and lets -5 through. On an
-- issue with a published floor the "below the floor" test caught it by accident; on
-- an issue whose floor is NOT published — which NSE's own FAQ (v3.0, Q12) says is
-- normal before the offer opens — there was nothing to compare against. A negative
-- price passed every check, produced a negative order value, and made the margin
-- test pass trivially because a negative number is below any limit.
--
-- Fixed in lib/domain.js. This is the floor under it: the application decides what a
-- good bid is, and the database refuses to hold one that is arithmetically impossible
-- however it got here — a CSV import, a direct SQL fix, a future route.
-- ============================================================================

ALTER TABLE ofs.ofs_bid DROP CONSTRAINT IF EXISTS ofs_bid_price_ck;
ALTER TABLE ofs.ofs_bid ADD CONSTRAINT ofs_bid_price_ck
  CHECK ((is_cutoff OR price IS NOT NULL) AND (price IS NULL OR price > 0));

ALTER TABLE ofs.ofs_bid DROP CONSTRAINT IF EXISTS ofs_bid_value_ck;
ALTER TABLE ofs.ofs_bid ADD CONSTRAINT ofs_bid_value_ck
  CHECK (value >= 0);

-- Margin too. A negative available margin is not a debt the desk is tracking here;
-- it is a typo, and it silently raises what every client can bid.
ALTER TABLE ofs.ofs_margin DROP CONSTRAINT IF EXISTS ofs_margin_available_ck;
ALTER TABLE ofs.ofs_margin ADD CONSTRAINT ofs_margin_available_ck
  CHECK (available IS NULL OR available >= 0);
