'use strict';
/**
 * Ported from omnenest-uploader-api lib/emailBranding.js — one branded shell so OFS
 * mail looks like every other Ashika platform email. Table layout for mail-client
 * compatibility; the logo is a hosted URL because inline base64 is widely blocked.
 */
const APP_NAME = 'Ashika Group · OFS BackOffice';
const APP_TAG = 'OFFER FOR SALE · BIDDING DESK';

/* An investor is not on the BackOffice and should not be told they are.
 * The shell is the same; the two words under the logo and in the footer are not. */
const AUDIENCE = {
  staff:  { name: APP_NAME, tag: APP_TAG },
  branch: { name: 'Ashika Group · Offer for Sale', tag: 'OFFER FOR SALE · PARTNER DESK' },
  client: { name: 'Ashika Group · Offer for Sale', tag: 'OFFER FOR SALE · BIDDING' }
};
const brandFor = (a) => AUDIENCE[a] || AUDIENCE.staff;

/**
 * The fallback is the OFS domain, NOT the portal's.
 *
 * This was inherited from omnenest-uploader-api, where falling back to the portal's
 * own URL is correct. Here it is not: the logo is served by THIS app at
 * /shared/brand-logo.png, and the portal serves its copy at /brand-logo.png, so an
 * unset APP_URL pointed every OFS email's logo at a path that does not exist on the
 * host it named — a broken image in every sign-in code, with nothing in any log to
 * say so. Same for the footer link, which would have sent clients to the portal.
 */
function appUrl() {
  return String(process.env.APP_URL || process.env.PUBLIC_BASE_URL || 'https://ofs-bids.ashikagroup.com')
    .replace(/\/+$/, '');
}

/**
 * Is the address every email will carry one a recipient can actually use?
 *
 * This URL is not decoration: the logo is fetched from it and the footer links to
 * it. Pointed at the server's own IP over http, as it was on the first live
 * morning, every sign-in mail shipped a broken image and a bare address - which
 * is what a phishing mail looks like, to a reader and to a spam filter alike.
 *
 * Returns null when it is fine, or the reason when it is not.
 */
function appUrlProblem(url) {
  const u = String(url || appUrl());
  if (/^http:\/\//i.test(u)) return 'it is http, not https — mail clients flag the link and block the logo';
  const host = u.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return 'it is a bare IP address (' + host + '), so the logo cannot load and the ' +
           'footer link goes nowhere a client can trust';
  }
  return null;
}

function brandedEmail(innerHtml, opts) {
  opts = opts || {};
  const url = appUrl();
  const b = brandFor(opts.audience);
  const name = opts.appName || b.name;
  const tag = opts.tag || b.tag;
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
                <div style="color:#dbe4ef;font-size:11px;letter-spacing:.5px">${tag}</div>
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
          <div style="margin-top:8px;color:#9ca3af">&copy; ${new Date().getFullYear()} Ashika Stock Services LTD. All rights reserved.</div>
        </td>
      </tr>
    </table>
  </div>`;
}

module.exports = { brandedEmail, appUrl, appUrlProblem, brandFor, APP_NAME };
