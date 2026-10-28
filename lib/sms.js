'use strict';
/**
 * SMS delivery — two ways to send, one interface.
 *
 * GATEWAY (the default). The platform already talks to the ACL / Sinch
 * TextListener, and its configuration — credentials, sender header, DLT template,
 * the fallback gateway — lives in "admin-staging-api".app_settings, in the SAME
 * database OFS already reads for staff accounts and SMTP. So OFS reads that one
 * row rather than holding a second copy of the credentials and a second screen to
 * keep in step with it. Change the gateway on the portal's Settings page and OFS
 * follows on the next send. This is REUSE.md 3 applied to SMS.
 *
 * API. Any vendor with an HTTP endpoint: OFS posts JSON and reads the reply. The
 * URL, the token and the field names are environment settings, so moving to
 * another provider is configuration rather than a deploy.
 *
 * Both report the same shape, and both log every attempt — request and reply —
 * to the platform's Email & OTP Logs, because an SMS that did not arrive is
 * almost always explained by the gateway's own answer.
 *
 * The OTP text comes from the REGISTERED DLT TEMPLATE and nowhere else. India's
 * DLT regime matches the delivered text against the template registered for the
 * sender; a message composed here instead would be rejected by the gateway (ACL
 * answers -3) however well it reads.
 */
const { adminOne, SCHEMA } = require('../db/adminAdapter');
const { logSms } = require('./emailLog');

const DEFAULT_BASE =
  'https://push3.aclgateway.com/servlet/com.aclwireless.pushconnectivity.listeners.TextListener';
const FIXED = { contenttype: '1', alert: '1', selfid: 'true' };
const TIMEOUT_MS = Number(process.env.OFS_SMS_TIMEOUT_MS || 15000);
const DEFAULT_OTP_TEXT = 'Hi, {otp} is the OTP for 2FA login. Team Ashika';

/** gateway | api | off. Unset means gateway — the platform's own route. */
const provider = () => String(process.env.OFS_SMS_PROVIDER || 'gateway').trim().toLowerCase();

/* The platform row, cached briefly. Every send would otherwise cross from Azure
 * to AWS just to read its own settings, in front of somebody waiting to sign in. */
let cache = null;
const cacheMs = () => Number(process.env.OFS_SMS_CONFIG_TTL_MS || 60000);
/** Drop the cached settings — after a Settings change, and for tests. */
function resetConfigCache() { cache = null; }
async function config() {
  if (cache && Date.now() - cache.at < cacheMs()) return cache.cfg;
  const row = await adminOne(
    `SELECT sms_enabled, sms_base_url, sms_appid, sms_user_id, sms_pass, sms_header,
            sms_fb_base_url, sms_fb_appid, sms_fb_user_id, sms_fb_pass, sms_fb_header,
            sms_prepend_91, sms_failure_contains, sms_otp_template_id, sms_otp_text
       FROM "${SCHEMA}".app_settings WHERE id = 1`).catch(() => null);
  cache = { at: Date.now(), cfg: row || {} };
  return cache.cfg;
}

/**
 * India's country code is the default, not an option.
 *
 * Digits only; a leading trunk 0 goes; a bare ten-digit number gets 91. A number
 * that already carries a country code is left alone — prefixing it again is how
 * a valid mobile becomes undeliverable.
 */
function normTo(raw, plain) {
  let d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!d || plain) return d;
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = '91' + d;
  return d;
}

/* Built with encodeURIComponent, NOT URLSearchParams: the latter encodes a space
 * as '+', which ACL takes literally, so the text stops matching the registered
 * DLT template and the gateway rejects it. The working URL uses %20. */
function buildUrl(gw, { to, text, templateId }) {
  const base = String(gw.base_url || DEFAULT_BASE).trim();
  const params = [
    ['appid', gw.appid || ''], ['userId', gw.user_id || ''], ['pass', gw.pass || ''],
    ['contenttype', FIXED.contenttype], ['from', gw.header || ''],
    ['to', to], ['text', text], ['alert', FIXED.alert], ['selfid', FIXED.selfid]
  ];
  if (templateId) params.push(['dtm', String(templateId)]);
  const qs = params.map(([k, v]) => k + '=' + encodeURIComponent(v == null ? '' : v)).join('&');
  return base + (base.includes('?') ? '&' : '?') + qs;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const maskUrl = (u) => String(u).replace(/([?&](?:pass|pwd|password|token|key)=)[^&]*/gi, '$1••••');

/**
 * HTTP 200 is not success.
 *
 * The TextListener answers with a NUMBER: positive is the accepted message id,
 * while 0 or negative is a refusal — -1 bad credentials, -2 bad parameters, -3
 * sender ID, DLT template or IP not whitelisted — all of them returned with a
 * perfectly cheerful HTTP 200. Reading only the status code would record every
 * rejected message as delivered.
 */
function gatewayOk(resp, failureContains) {
  if (!resp.httpOk) return false;
  const body = String(resp.body || '').trim();
  const lead = body.match(/^\s*(-?\d+)/);
  if (lead && Number(lead[1]) <= 0) return false;
  const f = String(failureContains || '').trim();
  if (f) {
    const re = new RegExp(f.split('|').map((x) => x.trim()).filter(Boolean).map(escapeRe).join('|'), 'i');
    if (re.test(body)) return false;
  }
  return true;
}

async function http(url, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, Object.assign({ signal: ctrl.signal, redirect: 'follow' }, init || {}));
    const body = await res.text().catch(() => '');
    return { httpOk: res.ok, statusCode: res.status, body: String(body || '').slice(0, 2000) };
  } finally { clearTimeout(t); }
}

/** Node's fetch reports every network fault as "fetch failed"; the cause has the reason. */
function reason(e) {
  const code = e && e.cause && (e.cause.code || e.cause.message);
  if (e && e.name === 'AbortError') return 'timeout — no response in ' + TIMEOUT_MS + 'ms';
  if (code) return 'cannot reach the gateway (' + code + ') — check egress and IP whitelisting';
  return (e && e.message) || 'request failed';
}

async function viaGateway(cfg, { to, text, templateId, purpose, triggeredBy, ip }) {
  const gateways = [
    { name: 'primary', base_url: cfg.sms_base_url, appid: cfg.sms_appid,
      user_id: cfg.sms_user_id, pass: cfg.sms_pass, header: cfg.sms_header },
    { name: 'fallback', base_url: cfg.sms_fb_base_url, appid: cfg.sms_fb_appid,
      user_id: cfg.sms_fb_user_id, pass: cfg.sms_fb_pass, header: cfg.sms_fb_header }
  ].filter((g) => g.appid && g.user_id);     // ACL needs both; half a gateway is not one

  if (!gateways.length) return { sent: false, error: 'no_gateway_configured' };

  let last = { error: 'not_attempted' };
  for (const gw of gateways) {
    const url = buildUrl(gw, { to, text, templateId });
    const started = Date.now();
    let resp, err = null;
    try { resp = await http(url, { method: 'GET' }); }
    catch (e) { err = reason(e); resp = { httpOk: false, statusCode: 0, body: '' }; }
    const ms = Date.now() - started;
    const ok = !err && gatewayOk(resp, cfg.sms_failure_contains);
    await logSms({
      purpose, to, text, ip_address: ip, triggered_by: triggeredBy,
      status: ok ? 'sent' : 'failed', message_id: gw.name,
      request: 'GET ' + maskUrl(url),
      response: '[' + gw.name + '] HTTP ' + resp.statusCode + ' · ' + ms + 'ms'
        + (resp.body ? ' · body: ' + resp.body : '') + (err ? ' · ' + err : ''),
      error_text: ok ? null : (err || 'gateway reported failure')
    });
    if (ok) return { sent: true, gateway: gw.name, response: resp.body, ms };
    last = { sent: false, error: err || ('gateway "' + gw.name + '" refused: ' + (resp.body || 'HTTP ' + resp.statusCode)) };
  }
  return last;
}

/**
 * Any vendor with an HTTP endpoint.
 *
 * The field names are configurable because no two providers agree on them, and a
 * change of provider should be a change of settings rather than of code. The
 * body is JSON by default; OFS_SMS_API_FORM=true posts form-encoded instead.
 */
async function viaApi({ to, text, templateId, purpose, triggeredBy, ip }) {
  const url = String(process.env.OFS_SMS_API_URL || '').trim();
  if (!url) return { sent: false, error: 'no_api_url_configured' };

  const f = {
    to: process.env.OFS_SMS_API_FIELD_TO || 'to',
    text: process.env.OFS_SMS_API_FIELD_TEXT || 'text',
    template: process.env.OFS_SMS_API_FIELD_TEMPLATE || 'templateId'
  };
  const payload = {};
  payload[f.to] = to;
  payload[f.text] = text;
  if (templateId) payload[f.template] = String(templateId);
  // Anything else the vendor insists on: OFS_SMS_API_EXTRA={"route":"otp"}
  try { Object.assign(payload, JSON.parse(process.env.OFS_SMS_API_EXTRA || '{}')); } catch (e) { /* ignore */ }

  const form = /^(1|true|yes)$/i.test(String(process.env.OFS_SMS_API_FORM || ''));
  const headers = { Accept: 'application/json' };
  headers['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
  const token = String(process.env.OFS_SMS_API_TOKEN || '').trim();
  if (token) headers[process.env.OFS_SMS_API_AUTH_HEADER || 'Authorization'] =
    (process.env.OFS_SMS_API_AUTH_SCHEME || 'Bearer') + ' ' + token;

  const body = form ? new URLSearchParams(payload).toString() : JSON.stringify(payload);
  const started = Date.now();
  let resp, err = null;
  try { resp = await http(url, { method: process.env.OFS_SMS_API_METHOD || 'POST', headers, body }); }
  catch (e) { err = reason(e); resp = { httpOk: false, statusCode: 0, body: '' }; }
  const ms = Date.now() - started;

  // 200 with a refusal in the body is still a refusal — same trap as the gateway.
  let ok = !err && resp.httpOk;
  const fail = String(process.env.OFS_SMS_API_FAILURE_CONTAINS || '').trim();
  if (ok && fail) {
    const re = new RegExp(fail.split('|').map((x) => x.trim()).filter(Boolean).map(escapeRe).join('|'), 'i');
    if (re.test(resp.body)) ok = false;
  }

  await logSms({
    purpose, to, text, ip_address: ip, triggered_by: triggeredBy,
    status: ok ? 'sent' : 'failed', message_id: 'api',
    request: (process.env.OFS_SMS_API_METHOD || 'POST') + ' ' + maskUrl(url)
      + ' · ' + maskUrl(body).slice(0, 500),
    response: 'HTTP ' + resp.statusCode + ' · ' + ms + 'ms' + (resp.body ? ' · body: ' + resp.body : '')
      + (err ? ' · ' + err : ''),
    error_text: ok ? null : (err || 'provider reported failure')
  });
  return ok ? { sent: true, gateway: 'api', response: resp.body, ms }
            : { sent: false, error: err || ('provider refused: ' + (resp.body || 'HTTP ' + resp.statusCode)) };
}

/**
 * Can an SMS actually be sent right now?
 *
 * Asked before a sign-in decides whether a mobile on its own is a way in, so it
 * has to be the truth rather than a hopeful default. Async because the gateway's
 * answer lives in the platform database.
 */
async function configured() {
  const p = provider();
  if (p === 'off') return false;
  if (p === 'api') return !!String(process.env.OFS_SMS_API_URL || '').trim();
  const cfg = await config();
  if (!cfg.sms_enabled) return false;
  return !!((cfg.sms_appid && cfg.sms_user_id) || (cfg.sms_fb_appid && cfg.sms_fb_user_id));
}

/** Send one message. Same shape as lib/mailer.send, so callers treat them alike. */
async function send({ to, text, templateId, purpose, triggeredBy, ip }) {
  const p = provider();
  if (p === 'off') return { sent: false, skipped: true, reason: 'sms_disabled' };

  const cfg = p === 'api' ? {} : await config();
  if (p !== 'api' && !cfg.sms_enabled) return { sent: false, skipped: true, reason: 'sms_not_enabled' };

  const dest = normTo(to, cfg.sms_prepend_91 === false);
  if (!dest) return { sent: false, error: 'no_valid_mobile' };
  if (!text) return { sent: false, error: 'empty_message' };

  const args = { to: dest, text, templateId, purpose: purpose || 'ofs_sms',
                 triggeredBy: triggeredBy || 'system', ip: ip || null };
  return p === 'api' ? viaApi(args) : viaGateway(cfg, args);
}

/**
 * A sign-in code, in the words the template is registered with.
 *
 * NOT composed here. The DLT regime matches delivered text against the template
 * registered against the sender ID, so the message has to be the template with
 * {otp} filled in — anything else is refused by the gateway no matter how well
 * it reads. Both the text and its id come from the platform's settings.
 */
async function sendOtp(to, code, opts) {
  opts = opts || {};
  const cfg = await config();
  const tpl = String(cfg.sms_otp_text || process.env.OFS_SMS_OTP_TEXT || DEFAULT_OTP_TEXT);
  return send({
    to, text: tpl.replace(/\{otp\}/gi, String(code)),
    templateId: cfg.sms_otp_template_id || process.env.OFS_SMS_OTP_TEMPLATE_ID || null,
    purpose: opts.purpose || 'ofs_client_otp_sms',
    triggeredBy: opts.triggeredBy || 'client-signin', ip: opts.ip
  });
}

module.exports = { configured, send, sendOtp, normTo, config, resetConfigCache, provider,
                   gatewayOk, buildUrl, maskUrl, DEFAULT_BASE };
