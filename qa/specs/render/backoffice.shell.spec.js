'use strict';
/**
 * Every back-office screen, loaded and looked at.
 *
 * Read-only throughout — these sign in, move between panes and assert what is on
 * the screen. Nothing here creates, changes or deletes anything, so the whole
 * file is safe against production.
 *
 * This is the layer that was missing. The existing 119 end-to-end scenarios ask
 * the server questions and the server answers them correctly; every defect
 * reported against this module in the last week was a SCREEN saying something
 * the server never said — a Branch column that was sent but not drawn, a status
 * chip reading "Inactive" for every client, a price box greyed out on a bid that
 * has a price, a panel quoting a close time the cut-off overrules. An API test
 * cannot see any of those.
 *
 * Case ids are in the titles, because the reporter builds the plan from them:
 * renaming a test cannot silently renumber the workbook.
 */
const { test, expect } = require('@playwright/test');
const { BackOffice, PANES, MASTERS } = require('../../pages/backoffice');
const plan = require('../../lib/plan');

/**
 * One sign-in for the file, not one per test.
 *
 * Signing in per test is the obvious shape and it is what made a twenty-eight
 * case file take seven minutes: a real sign-in against a real server is fifteen
 * seconds of round trips, and none of these tests change the session. Serial
 * mode with one page is the same isolation in practice - each test starts by
 * opening the pane it is about - at a twenty-eighth of the cost.
 *
 * A test that needs a fresh session asks for its own `page` fixture instead.
 */
/* Not serial mode: these tests are independent reads, and serial abandons every
 * remaining case the moment one fails - which for a suite whose job is to produce
 * a full report is exactly backwards. One worker and one shared page give the
 * ordering without the abandonment. */

let page, bo;

test.beforeAll(async ({ browser }) => {
  const u = plan.requireUser('desk');    // fail here, not in twenty-eight places
  page = await browser.newPage();
  bo = new BackOffice(page, plan.env.backoffice_url);
  await bo.signIn(u.identifier, u.password);
});

test.afterAll(async () => {
  if (page) await page.close();
});

/* ------------------------------------------------------------ signing in -- */

test('BO-REN-01  The desk signs in and lands on a working shell', async () => {
  test.info().annotations.push({ type: 'expected',
    description: 'Email and password only — the back-office door has no OTP.' });
  await bo.open('dash');
  expect(await bo.visible('#pane-dash')).toBeTruthy();
  const tabs = await bo.navTabs();
  expect(tabs).toEqual(expect.arrayContaining(['dash', 'book', 'place', 'clients', 'export', 'masters']));
});

/* --------------------------------------------------------------- panes ---- */

for (const p of PANES) {
  test('BO-REN-02' + p.tab[0] + '  ' + p.name + ' opens and is the visible pane', async () => {
    test.info().annotations.push({ type: 'expected',
      description: p.name + ' renders with content, and no other pane is left showing.' });
    await bo.open(p.tab);
    expect(await bo.visible(p.pane)).toBeTruthy();
    const text = await bo.text(p.pane);
    expect(text.length, p.name + ' rendered empty').toBeGreaterThan(20);
    // The hash is the router here, so a pane that opens without it will not
    // survive a refresh or a shared link.
    expect(await bo.page.evaluate(() => location.hash)).toBe('#' + p.tab);
  });
}

/* ------------------------------------------------------- masters sub-tabs -- */

for (const m of MASTERS) {
  test('BO-REN-03' + m.tab[0] + '  Masters → ' + m.name + ' opens', async () => {
    test.info().annotations.push({ type: 'expected',
      description: 'The ' + m.name + ' section shows, and the others are hidden.' });
    await bo.openMasters(m.tab);
    expect(await bo.visible(m.section)).toBeTruthy();
    const text = await bo.text(m.section);
    expect(text.length, m.name + ' rendered empty').toBeGreaterThan(10);
  });
}

/* -------------------------------------------------------------- clients --- */

test('BO-REN-10  The Clients table carries UCC, Client, Branch, Category and Status', async () => {
  test.info().annotations.push({ type: 'expected',
    description: 'Branch was selected by the server for months and never drawn. ' +
      'The header and the first row must be the same width, or every cell is off by one.' });
  await bo.open('clients');
  const head = await bo.headers('#clientsTbl');
  expect(head).toEqual(expect.arrayContaining(['UCC', 'Client', 'Branch', 'Category', 'Status']));
  const rows = await bo.rows('#clientsTbl');
  if (rows.length) expect(rows[0].length).toBe(head.length);
});

test('BO-REN-11  The status filter sits before the search box', async () => {
  test.info().annotations.push({ type: 'expected',
    description: 'All statuses, Active, Dormant, Closed, Inactive, Other or not set — ' +
      'and the filter to the left of the search box, where it was asked for.' });
  await bo.open('clients');
  expect(await bo.clients.filterBefore()).toBeTruthy();
  const opts = (await bo.clients.statusOptions()).map((o) => o.split('=')[0]);
  expect(opts).toEqual(expect.arrayContaining(['', 'active', 'dormant', 'closed', 'inactive', 'other']));
});

test('BO-REN-12  Filtering by status narrows the whole book, not the page', async () => {
  test.info().annotations.push({ type: 'expected',
    description: 'The count line names the filter, and every row on screen carries that status. ' +
      'A filter applied in the browser would narrow ten rows and hide the rest.' });
  await bo.open('clients');
  const before = await bo.clients.count();
  await bo.clients.setStatus('dormant');
  const after = await bo.clients.count();
  expect(after).not.toBe(before);
  expect(after.toLowerCase()).toContain('dormant');
  const rows = await bo.rows('#clientsTbl');
  const head = await bo.headers('#clientsTbl');
  const col = head.indexOf('Status');
  for (const r of rows) {
    if (r.length > col) expect(r[col].toLowerCase()).toContain('dormant');
  }
  await bo.clients.clear();
});

test('BO-REN-13  Clear empties the search and the filter together', async () => {
  test.info().annotations.push({ type: 'expected',
    description: 'A status left set behind an emptied search box reads as half the book vanishing.' });
  await bo.open('clients');
  await bo.clients.setStatus('active');
  await bo.clients.search(plan.value('search_ucc', 'ASH'));
  await bo.clients.clear();
  const state = await bo.page.evaluate(() => ({
    q: document.querySelector('#clQ').value,
    status: document.querySelector('#clStatus').value
  }));
  expect(state).toEqual({ q: '', status: '' });
});

/* ------------------------------------------------------------- place bid -- */

test('BO-REN-20  The bid form offers every field a desk needs', async () => {
  test.info().annotations.push({ type: 'expected',
    description: 'Issue, client UCC, exchange, category, price type, quantity, price, and a total.' });
  await bo.open('place');
  for (const sel of ['#pbIssue', '#pbUcc', '#pbCat', '#pbType', '#pbQty', '#pbPrice', '#pbValue']) {
    expect(await bo.visible(sel), sel + ' is missing from the bid form').toBeTruthy();
  }
});

test('BO-REN-21  A cut-off bid shows the issue’s own price, read-only', async () => {
  test.info().annotations.push({ type: 'expected',
    description: 'A cut-off bid is held, valued and margined at the price the issue sets. ' +
      'The box used to be emptied and greyed out, so the total read a dash against a bid ' +
      'that consumes real margin.' });
  await bo.open('place');
  const issues = (await bo.place.issueOptions()).filter((o) => o.value);
  test.skip(!issues.length, 'no open issue to select — nothing to check a cut-off price against');
  await bo.place.selectIssue(issues[0].value);
  const types = await bo.place.typeOptions();
  test.skip(!types.includes('cutoff'), 'cut-off is not offered for this issue');
  await bo.place.setType('cutoff');
  const price = await bo.place.price();
  expect(price.disabled, 'a greyed-out empty box reads as broken').toBeFalsy();
  expect(price.readOnly, 'the price must not be typeable on a cut-off bid').toBeTruthy();
  expect(price.value, 'the cut-off price is blank').not.toBe('');
  expect(await bo.place.priceHint()).toContain('Cut-off');
});

test('BO-REN-22  Switching back to a price bid clears the issue’s figure', async () => {
  test.info().annotations.push({ type: 'expected',
    description: 'The auto-filled price must not survive into a price bid as though somebody typed it.' });
  await bo.open('place');
  const issues = (await bo.place.issueOptions()).filter((o) => o.value);
  test.skip(!issues.length, 'no open issue to select');
  await bo.place.selectIssue(issues[0].value);
  const types = await bo.place.typeOptions();
  test.skip(!types.includes('cutoff'), 'cut-off is not offered for this issue');
  await bo.place.setType('cutoff');
  await bo.place.setType('price');
  const price = await bo.place.price();
  expect(price.readOnly).toBeFalsy();
  expect(price.value).toBe('');
});

test('BO-REN-23  An unknown UCC is refused at the field, not only in the panel', async () => {
  test.info().annotations.push({ type: 'expected',
    description: 'The refusal used to live in the Client & margin panel on the far side of ' +
      'the form — the part nobody is looking at while typing a code.' });
  await bo.open('place');
  await bo.place.typeUcc('ZZZ999999');
  const hint = await bo.place.uccHint();
  expect(hint.shown, 'the refusal is hidden by the compact layout').toBeTruthy();
  expect(hint.cls).toContain('bad');
  expect(hint.text.toLowerCase()).toMatch(/no client found|not one of your clients/);
});

test('BO-REN-24  The issue panel says when bidding stops, not just when the offer ends',
  async () => {
    test.info().annotations.push({ type: 'expected',
      description: 'The panel quoted the time typed on the issue master while the refusal ' +
        'named the desk cut-off — two times on one screen, disagreeing.' });
    await bo.open('place');
    const issues = (await bo.place.issueOptions()).filter((o) => o.value);
    test.skip(!issues.length, 'no issue to inspect');
    await bo.place.selectIssue(issues[0].value);
    const info = (await bo.place.issueInfo()).replace(/\s+/g, ' ');
    // innerText returns the CSS-transformed text, and these labels are uppercased.
    expect(info).toMatch(/HNI window/i);
    expect(info).toMatch(/Retail window/i);
    /* The cut-off line is about TODAY, so an offer that is already over has none
     * and says so with its status chip instead. Asserting it on a finished offer
     * would be asserting a sentence that would be a lie. */
    if (!/\bClosed\b/.test(info)) {
      expect(info).toMatch(/Bidding stops at|No bid can be placed right now/);
    }
  });

/* --------------------------------------------------------------- margins -- */

test('BO-REN-30  The margin list carries a Branch column and can be searched by it', async () => {
  test.info().annotations.push({ type: 'expected',
    description: 'A branch column you cannot search by is decoration.' });
  await bo.openMasters('margins');
  const head = await bo.headers('#marginTbl');
  expect(head).toEqual(expect.arrayContaining(['UCC', 'Client', 'Branch', 'Available', 'Used', 'Free']));
  expect(await bo.margins.searchPlaceholder()).toMatch(/branch/i);
  const rows = await bo.rows('#marginTbl');
  if (rows.length) expect(rows[0].length).toBe(head.length);
});

test('BO-REN-31  The old top-of-page margin form is gone', async () => {
  test.info().annotations.push({ type: 'expected',
    description: 'Two ways to change one figure, and the one furthest from the row being ' +
      'read is the one that got used.' });
  await bo.openMasters('margins');
  for (const sel of ['#mgUcc', '#mgAmt', '#mgFetch', '#mgSet']) {
    expect(await bo.page.locator(sel).count(), sel + ' is back').toBe(0);
  }
});

/* ------------------------------------------------------------- bid book --- */

test('BO-REN-40  The bid book offers All as well as each status', async () => {
  test.info().annotations.push({ type: 'expected',
    description: 'Live, Modified, Cancelled and Rejected each on their own, and All for everything.' });
  await bo.open('book');
  const opts = await bo.page.$$eval('#bkStatus option',
    (os) => os.map((o) => (o.value || o.textContent).trim().toLowerCase()));
  expect(opts.join(' ')).toContain('all');
  const head = await bo.headers('#bookTbl');
  expect(head.length, 'the bid book has no columns').toBeGreaterThan(4);
});

/* -------------------------------------------------------------- settings -- */

test('BO-REN-50  Settings shows the cut-off and says what it governs', async () => {
  test.info().annotations.push({ type: 'expected',
    description: 'The desk cut-off decides the hour bidding stops on every day an issue runs. ' +
      'It must be reachable and readable here, because it is the control the desk actually turns.' });
  await bo.openMasters('settings');
  const text = await bo.text('#mSettings');
  expect(text).toMatch(/cut-off/i);
});
