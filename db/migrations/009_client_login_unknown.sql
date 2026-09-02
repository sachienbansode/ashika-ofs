-- 009 — what the client sign-in page says when nothing matches.
--
-- 'reveal'  : answer "no client found". Kinder, and it stops the desk fielding
--             "I never got my OTP" calls from people who mistyped a client code.
--             The cost: the endpoint confirms whether an identifier is a client,
--             so it stays behind the per-identifier and per-IP throttle in
--             ofs.ofs_client_otp.
-- 'generic' : answer identically either way, so the page cannot be used to
--             enumerate which mobiles and emails belong to Ashika clients.
INSERT INTO ofs.ofs_setting (key, value, description) VALUES
  ('client_login_unknown', 'reveal',
   'reveal = say "no client found"; generic = identical answer whether or not it matched')
ON CONFLICT (key) DO NOTHING;
