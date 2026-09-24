-- The sign-in page says "no account found" again, at the first step, and sends
-- nothing.
--
-- Migration 023 turned the seeded value to 'generic' on the grounds that naming a
-- miss hands an unauthenticated caller a yes/no oracle over Ashika's client base,
-- and that the throttle could not help because a miss writes no challenge row.
-- The first half is true and the second half overlooked the limiter that was
-- already there: POST /client/auth/start is capped at ten requests per connection
-- per fifteen minutes at the HTTP layer, which is nowhere near enough to walk a
-- client-code range. A second, tighter count of MISSES per address now sits under
-- it as well.
--
-- What 'generic' cost was paid by every real investor: a mistyped code, an
-- address on no account, a staff member using the client door — all of them were
-- carried to a code step, told a code might be on its way, and left at a box that
-- would never be filled.
--
-- Only the untouched seed is changed, exactly as 023 did in the other direction:
-- a desk that has since chosen 'generic' deliberately keeps it.
UPDATE ofs.ofs_setting
   SET value = 'reveal'
 WHERE key = 'client_login_unknown'
   AND value = 'generic'
   AND updated_by IS NULL;
