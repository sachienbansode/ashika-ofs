'use strict';
/**
 * SMS delivery.
 *
 * No provider is wired yet — Ashika has not named one. Rather than pretend, this
 * reports honestly so the caller can decide, and so a missing SMS never silently
 * looks like a delivered one. Email carries the code in the meantime.
 *
 * To wire a provider: implement send() against it, keep the same return shape, and
 * log through lib/emailLog (purpose 'ofs_client_otp_sms') so OTP delivery stays
 * visible in one place.
 */
const configured = () => Boolean(process.env.SMS_PROVIDER && process.env.SMS_API_KEY);

async function send({ to, text }) {
  if (!configured()) {
    return { sent: false, skipped: true, reason: 'sms_not_configured' };
  }
  // eslint-disable-next-line no-unused-vars
  const _ = { to, text };
  return { sent: false, skipped: true, reason: 'sms_provider_not_implemented' };
}

module.exports = { configured, send };
