'use strict';
/**
 * Waiting for a human to type the code.
 *
 * Client and branch sign-in send a real six-digit code to a real mailbox, and on
 * a production server the fixed test code is floored off by construction
 * (lib/otp.js: `if (isProduction()) return false`). There is no way for a script
 * to read that code, so a person types it — into the REAL browser window, not
 * into the terminal.
 *
 * Into the browser, deliberately. A terminal prompt would mean reading the code
 * from the phone, typing it into one window and watching another, and it would
 * also mean the suite driving the OTP boxes itself — which then tests the
 * suite's typing rather than the screen's. This way the person uses the form the
 * way a client does, and the spec simply waits for the form to get past it.
 *
 * The wait is bounded by otp_wait_seconds on the Environment sheet, and the
 * failure when it runs out says what nobody did, rather than "timeout".
 */

/**
 * Wait until the sign-in gets past the code step.
 *
 * `done` is a locator that only exists once the session is established — the
 * signed-in shell — so this cannot pass on a code that was typed but refused.
 */
async function waitForHumanOtp(page, opts) {
  const o = opts || {};
  const who = o.who || 'this account';
  const ms = Number(o.timeoutMs || 180000);
  const label = o.label || 'sign-in';

  // Loud, and on its own lines: this scrolls past in a wall of green ticks
  // otherwise, and an unattended run then just looks slow before it fails.
  const bar = '─'.repeat(64);
  console.log('\n' + bar);
  console.log('  PAUSED — ' + label + ' needs the code sent to ' + who);
  console.log('  Type it into the browser window that is open, then press Verify.');
  console.log('  Waiting up to ' + Math.round(ms / 1000) + 's.');
  console.log(bar + '\n');

  // Bring the window forward so it is not buried behind the terminal.
  try { await page.bringToFront(); } catch (e) { /* headless, or no window manager */ }

  try {
    await o.done.waitFor({ state: 'visible', timeout: ms });
  } catch (e) {
    throw new Error(
      'Nobody entered the code for ' + who + ' within ' + Math.round(ms / 1000) + 's. ' +
      'Run headed (npm run test:headed) so the window is visible, raise otp_wait_seconds ' +
      'on the Environment sheet, or set otp_mode=static for this user once the admin ' +
      'allow-list exists in the app.');
  }
  console.log('  …code accepted, continuing.\n');
}

/**
 * Type a code the workbook already knows.
 *
 * For otp_mode=static, once the app has an admin allow-list of test accounts.
 * Until then no user should carry one, and this is here so the specs are written
 * against the shape they will have rather than being rewritten later.
 */
async function typeStaticOtp(page, code, boxSelector) {
  const boxes = page.locator((boxSelector || '#otpBox') + ' input');
  const n = await boxes.count();
  const digits = String(code).replace(/\D/g, '');
  if (digits.length !== n) {
    throw new Error('static_otp is ' + digits.length + ' digit(s) and the form wants ' + n + '.');
  }
  for (let i = 0; i < n; i++) await boxes.nth(i).fill(digits[i]);
}

module.exports = { waitForHumanOtp, typeStaticOtp };
