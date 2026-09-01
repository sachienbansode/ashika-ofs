-- The code now goes to BOTH the registered email and mobile, and sign-in accepts
-- either identifier. 'both' becomes a valid channel; the identifier the client
-- typed is what we throttle on, so widen the column that holds it.

ALTER TABLE ofs.ofs_client_otp DROP CONSTRAINT IF EXISTS ofs_client_otp_channel_ck;
ALTER TABLE ofs.ofs_client_otp
  ADD CONSTRAINT ofs_client_otp_channel_ck
  CHECK (channel IN ('email','sms','both','test'));

COMMENT ON COLUMN ofs.ofs_client_otp.mobile IS
  'The identifier the client typed (mobile or email), lowercased. Throttling and resend key off this, not the contact the code was sent to.';
COMMENT ON COLUMN ofs.ofs_client_otp.delivered_to IS
  'Masked destinations the code was actually sent to. Display only.';
