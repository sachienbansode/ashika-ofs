'use strict';
/**
 * The back-office shell, as one object.
 *
 * Every selector this suite knows about the desk screens lives here and nowhere
 * else. That is the whole point: about a hundred UI cases across three roles is
 * only maintainable if renaming an id is one edit rather than sixty. A spec that
 * reaches for `#clStatus` directly has quietly undone that, so specs talk to
 * these methods and never to the DOM.
 *
 * The same files serve the desk at /backoffice and a branch or AP at /partner —
 * one shell, two scopes, decided by the server. So this object takes the shell
 * URL rather than assuming the desk's.
 */

/** Panes, in nav order, with the heading each one is known by. */
const PANES = [
  { tab: 'dash', pane: '#pane-dash', name: 'Dashboard' },
  { tab: 'book', pane: '#pane-book', name: 'Bid book' },
  { tab: 'place', pane: '#pane-place', name: 'Place bid' },
  { tab: 'clients', pane: '#pane-clients', name: 'Clients' },
  { tab: 'export', pane: '#pane-export', name: 'Export' },
  { tab: 'masters', pane: '#pane-masters', name: 'Masters' },
  { tab: 'rules', pane: '#pane-rules', name: 'Bidding rules' }
];

/** Masters sub-tabs, and the section each one reveals. */
const MASTERS = [
  { tab: 'issues', section: '#mIssues', name: 'Issue master' },
  { tab: 'sync', section: '#mSync', name: 'Exchange pull' },
  { tab: 'margins', section: '#mMargins', name: 'Margins' },
  { tab: 'archive', section: '#mArchive', name: 'Archive' },
  { tab: 'circulars', section: '#mCirculars', name: 'Circulars' },
  { tab: 'audit', section: '#mAudit', name: 'Audit' },
  { tab: 'settings', section: '#mSettings', name: 'Settings' }
];

class BackOffice {
  constructor(page, url) {
    this.page = page;
    this.url = url;
  }

  static get PANES() { return PANES; }
  static get MASTERS() { return MASTERS; }

  /* ------------------------------------------------------------- signing in */

  /**
   * Sign in at the desk.
   *
   * Two steps, not one. The password is the first; a staff account with MFA
   * turned on then gets a six-digit code, and whether it does is per USER
   * (lib/staffAuth needsMfa reads mfa_enabled on the account), not a property of
   * the door. So the second step is detected rather than assumed — a suite that
   * assumed either way would work against one admin and hang against the next.
   *
   * `otp` decides what happens if the code step appears:
   *   { mode: 'static', code: '123456' }  type it
   *   { mode: 'manual', waitMs, who }     wait for a person to type it
   * and with neither, a code step is a clear failure rather than a timeout on a
   * selector that was never going to appear.
   */
  async signIn(email, password, otp) {
    await this.page.goto(this.url + 'login.html', { waitUntil: 'domcontentloaded' });
    await this.page.fill('#email', email);
    await this.page.fill('#password', password);
    await this.page.click('#signIn');

    // The shell, the code step, or a refusal — whichever arrives first.
    const shell = this.page.locator('#pane-dash');
    const code = this.page.locator('#paneOtp:not(.hide) #code');
    const err = this.page.locator('#credErr:not(:empty)');
    await Promise.race([
      shell.waitFor({ state: 'attached', timeout: 25000 }).catch(() => {}),
      code.waitFor({ state: 'visible', timeout: 25000 }).catch(() => {}),
      err.waitFor({ state: 'visible', timeout: 25000 }).catch(() => {})
    ]);

    if (await err.isVisible().catch(() => false)) {
      throw new Error('Sign-in refused: ' + (await err.textContent()).trim());
    }

    if (await code.isVisible().catch(() => false)) {
      await this.enterStaffOtp(otp);
    }

    await this.page.waitForSelector('#pane-dash', { state: 'attached', timeout: 25000 });
    await this.settled();
  }

  /** The code step, however the plan says it is to be answered. */
  async enterStaffOtp(otp) {
    const o = otp || {};
    if (o.mode === 'static' && o.code) {
      await this.page.fill('#code', String(o.code).replace(/\D/g, ''));
      await this.page.click('#verify');
      return;
    }
    if (o.mode === 'manual') {
      const { waitForHumanOtp } = require('../lib/otpPause');
      await waitForHumanOtp(this.page, {
        who: o.who || 'the back-office account',
        label: 'back-office sign-in',
        timeoutMs: o.waitMs,
        done: this.page.locator('#pane-dash')
      });
      return;
    }
    const sentTo = await this.page.locator('#sentTo').textContent().catch(() => '');
    throw new Error(
      'The desk account has MFA turned on and this run has no way to answer it.\n' +
      'The code went to ' + (sentTo || 'the address on the account').trim() + '.\n' +
      'Set otp_mode=manual on the desk row of the Users sheet to type it yourself, or ' +
      'otp_mode=static with the code in static_otp where the screen shows a fixed one.');
  }

  /**
   * Let the screen catch up.
   *
   * NOT networkidle. This shell re-polls the dashboard and the book on a timer —
   * every fifteen seconds on the investor side, thirty on the desk — so the
   * network is never idle and every wait for it burns its full timeout before
   * carrying on. That alone took a twenty-eight case run to seven minutes.
   *
   * What a render assertion actually needs is for the fetch it triggered to have
   * landed and been drawn, which is a short settle, and the assertions
   * themselves retry. Anything that needs a specific row waits for that row.
   */
  async settled(ms) {
    await this.page.waitForTimeout(ms == null ? 500 : ms);
  }

  async signedInAs() {
    const el = this.page.locator('#who, #whoami, header .who').first();
    return (await el.count()) ? (await el.textContent()).trim() : '';
  }

  /* ---------------------------------------------------------------- moving */

  /** Go to a pane by its nav key and wait for it to be the visible one. */
  async open(tab) {
    await this.page.evaluate((t) => { location.hash = '#' + t; }, tab);
    const p = PANES.find((x) => x.tab === tab);
    await this.page.waitForSelector(p.pane + ':not(.hide)', { timeout: 15000 });
    await this.settled();
  }

  async openMasters(sub) {
    await this.open('masters');
    await this.page.click('[data-mtab="' + sub + '"]');
    const m = MASTERS.find((x) => x.tab === sub);
    await this.page.waitForSelector(m.section + ':not(.hide)', { timeout: 15000 });
    await this.settled();
  }

  /** Which nav tabs this role is actually offered. */
  async navTabs() {
    return this.page.$$eval('[data-tab]', (els) => els
      .filter((e) => e.offsetParent !== null)
      .map((e) => e.getAttribute('data-tab')));
  }

  /* --------------------------------------------------------------- reading */

  /** Column headings of a table, trimmed, blanks kept so positions line up. */
  async headers(sel) {
    return this.page.$$eval(sel + ' thead th', (th) => th.map((t) => t.textContent.trim()));
  }

  /** Body rows as arrays of cell text. */
  async rows(sel) {
    return this.page.$$eval(sel + ' tbody tr', (trs) => trs.map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())));
  }

  /** The text of a pane, whitespace collapsed — for "does it say X" checks. */
  async text(sel) {
    return (await this.page.locator(sel).innerText()).replace(/\s+/g, ' ').trim();
  }

  async visible(sel) {
    return this.page.locator(sel).first().isVisible().catch(() => false);
  }

  /* ---------------------------------------------- clients tab, specifically */

  get clients() {
    const page = this.page;
    return {
      statusOptions: () => page.$$eval('#clStatus option',
        (os) => os.map((o) => o.value + '=' + o.textContent.trim())),
      filterBefore: async () => page.evaluate(() => {
        const q = document.querySelector('#clQ').getBoundingClientRect();
        const s = document.querySelector('#clStatus').getBoundingClientRect();
        return Math.round(s.right) <= Math.round(q.left);
      }),
      /* Each of these fires one request and redraws the count line, so the wait
       * is for THAT request rather than for the network to go quiet, which it
       * never does while the shell is polling. */
      setStatus: async (v) => {
        const done = page.waitForResponse((r) => /\/clients\?/.test(r.url()), { timeout: 15000 }).catch(() => {});
        await page.selectOption('#clStatus', v);
        await done;
        await page.waitForTimeout(250);
      },
      search: async (q) => {
        await page.fill('#clQ', q);
        const done = page.waitForResponse((r) => /\/clients\?/.test(r.url()), { timeout: 15000 }).catch(() => {});
        await page.click('#clGo');
        await done;
        await page.waitForTimeout(250);
      },
      clear: async () => {
        const done = page.waitForResponse((r) => /\/clients\?/.test(r.url()), { timeout: 15000 }).catch(() => {});
        await page.click('#clClear');
        await done;
        await page.waitForTimeout(250);
      },
      count: () => page.locator('#clCount').textContent()
    };
  }

  /* ------------------------------------------------ place bid, specifically */

  get place() {
    const page = this.page;
    return {
      issueOptions: () => page.$$eval('#pbIssue option',
        (os) => os.map((o) => ({ value: o.value, label: o.textContent.trim() }))),
      selectIssue: async (id) => {
        await page.selectOption('#pbIssue', String(id));
        await page.waitForTimeout(400);
      },
      setType: async (v) => {
        await page.selectOption('#pbType', v);
        await page.waitForTimeout(250);
      },
      price: () => page.$eval('#pbPrice', (el) => ({
        value: el.value, readOnly: el.readOnly, disabled: el.disabled
      })),
      priceHint: () => page.locator('#pbPriceHint').textContent(),
      typeOptions: () => page.$$eval('#pbType option', (os) => os.map((o) => o.value)),
      typeUcc: async (v) => {
        await page.fill('#pbUcc', v);
        await page.waitForTimeout(1200);          // the lookup is debounced at 350ms
      },
      uccHint: () => page.$eval('#pbUccHint', (el) => ({
        text: el.textContent.trim(), cls: el.className,
        shown: getComputedStyle(el).display !== 'none'
      })),
      clientPanel: () => page.locator('#pbClient').innerText(),
      issueInfo: () => page.locator('#pbIssueInfo').innerText()
    };
  }

  /* --------------------------------------------------- margins, specifically */

  get margins() {
    const page = this.page;
    return {
      searchPlaceholder: () => page.$eval('#mgQ', (el) => el.placeholder),
      search: async (q) => {
        await page.fill('#mgQ', q);
        await page.click('#mgGo');
        await page.waitForTimeout(400);
      },
      clear: () => page.click('#mgClear'),
      count: () => page.locator('#mgCount').textContent()
    };
  }
}

module.exports = { BackOffice, PANES, MASTERS };
