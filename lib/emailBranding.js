'use strict';
/**
 * Ported from omnenest-uploader-api lib/emailBranding.js — one branded shell so OFS
 * mail looks like every other Ashika platform email. Table layout for mail-client
 * compatibility; the logo is a hosted URL because inline base64 is widely blocked.
 */
const APP_NAME = 'Ashika Group · OFS Desk';
const APP_TAG = 'OFFER FOR SALE · BIDDING DESK';

function appUrl() {
  return String(process.env.APP_URL || process.env.PUBLIC_BASE_URL || 'https://staging-api-uat.ashikagroup.com')
    .replace(/\/+$/, '');
}

function brandedEmail(innerHtml, opts) {
  opts = opts || {};
  const url = appUrl();
  const name = opts.appName || APP_NAME;
  const logo = process.env.BRAND_LOGO_URL || (url + '/shared/brand-logo.png');
  return `
  <div style="background:#f4f5f7;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
      <tr>
        <td style="background:#1F4E79;padding:0">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td width="64" style="padding:16px 0 16px 20px" valign="middle">
                <img src="${logo}" alt="Ashika Group" width="40" height="40" style="display:block;border-radius:6px;background:#ffffff"/>
              </td>
              <td style="padding:16px 20px 16px 12px" valign="middle">
                <div style="color:#ffffff;font-size:16px;font-weight:700;line-height:1.15">Ashika Group</div>
                <div style="color:#dbe4ef;font-size:11px;letter-spacing:.5px">${APP_TAG}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr><td style="padding:24px;color:#1f2328;font-size:14px;line-height:1.6">${innerHtml}</td></tr>
      <tr>
        <td style="border-top:1px solid #e5e7eb;background:#fafafa;padding:14px 24px;color:#6b7280;font-size:11px;line-height:1.7">
          <div style="font-weight:600;color:#4b5563">${name}</div>
          <div><a href="${url}" style="color:#1F4E79;text-decoration:none">${url}</a></div>
          <div style="margin-top:6px;color:#9ca3af">This is an automated message — please do not reply.</div>
        </td>
      </tr>
    </table>
  </div>`;
}

module.exports = { brandedEmail, appUrl, APP_NAME };
