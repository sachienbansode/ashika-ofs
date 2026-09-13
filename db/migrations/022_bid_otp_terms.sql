-- 022 — the client's confirmation is bound to the AMOUNT, not only to the action.
--
-- ofs_bid_otp bound a code to {client, issue, action, bid}. What the client was
-- actually TOLD — "500 shares at ₹400, ₹2,00,000" — travelled in the requester's
-- own `detail` string, went into the email and the SMS, and was never compared
-- against anything at redemption.
--
-- So: the desk (or an AP) requests a code showing the client 500 shares at ₹400.
-- The client reads that, approves, and reads the code back. The same otp_ref is
-- then spent on a bid for 20,000 shares — same client, same issue, same action, so
-- verify() passed — and ofs_bid.otp_verified was stamped true against it. The audit
-- trail then asserted the client had consented to a ₹20 lakh bid they were shown as
-- ₹50,000.
--
-- That is the one control the whole table exists to provide, and it is aimed
-- squarely at the insider who could abuse it. terms_hash pins the material terms —
-- category, quantity, price or cut-off, exchange — at the moment the client is
-- told them. A bid that does not match the terms the code was issued for is
-- refused, and the client is asked again for the bid actually being placed.
--
-- NULL means a code issued before this migration, or a cancellation, which has no
-- terms of its own. Those keep the old behaviour: the binding that exists is
-- checked, and nothing is invented.
ALTER TABLE ofs.ofs_bid_otp ADD COLUMN IF NOT EXISTS terms_hash text;

COMMENT ON COLUMN ofs.ofs_bid_otp.terms_hash IS
  'sha256 of the bid terms the client was shown (category|qty|price|cutoff|exchange). '
  'Checked at redemption so a code approved for one amount cannot authorise another. '
  'NULL for a cancellation, and for codes issued before migration 022.';
