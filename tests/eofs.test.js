'use strict';
/**
 * The e-OFS mapping. No network: toIssue() is fed the shape v1.3.0 documents.
 *
 * The rule these enforce is that a half-read security becomes a REJECTION with a
 * reason, never a half-built issue. An issue with an invented window or a missing
 * floor price is worse than no issue, because bids get placed against it.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const eofs = require('../lib/issueSource/eofs');

const S = { nse_series_hni: 'IS', nse_series_retail: 'RS' };

const SEC = {
  symbol: 'COALINDIA', securityName: 'Coal India Limited', isinCode: 'INE522F01014',
  tickSize: 0.05, regularLotSize: 1,
  configurations: [
    { series: 'IS', issueSize: 123254566, basePrice: 412,
      openOnDate: '2026-05-27', mktOpenTime: '09:15:00', mktCloseTime: '15:30:00' },
    { series: 'RS', issueSize: 123254566, basePrice: 412,
      openOnDate: '2026-05-29', mktOpenTime: '09:15:00', mktCloseTime: '15:30:00' }
  ]
};

test('it stays dormant without credentials', () => {
  const u = process.env.OFS_EOFS_USER, p = process.env.OFS_EOFS_PASS;
  delete process.env.OFS_EOFS_USER; delete process.env.OFS_EOFS_PASS;
  assert.equal(eofs.configured(), false);
  process.env.OFS_EOFS_USER = 'x'; process.env.OFS_EOFS_PASS = 'y';
  assert.equal(eofs.configured(), true);
  if (u === undefined) delete process.env.OFS_EOFS_USER; else process.env.OFS_EOFS_USER = u;
  if (p === undefined) delete process.env.OFS_EOFS_PASS; else process.env.OFS_EOFS_PASS = p;
});

test('a complete security maps to an issue, with IST windows', () => {
  const { issue } = eofs.toIssue(SEC, S);
  assert.equal(issue.symbol, 'COALINDIA');
  assert.equal(issue.isin, 'INE522F01014');
  assert.equal(issue.floor_price, 412);
  assert.equal(issue.cut_price_min, 412);
  assert.equal(issue.tick, 0.05);
  assert.equal(issue.issue_qty, 123254566);
  // 09:15 IST on 27 May is 03:45 UTC.
  assert.equal(issue.hni_open.toISOString(), '2026-05-27T03:45:00.000Z');
  assert.equal(issue.hni_close.toISOString(), '2026-05-27T10:00:00.000Z');
  assert.equal(issue.ret_open.toISOString(), '2026-05-29T03:45:00.000Z');
  assert.ok(issue.ret_open > issue.hni_close, 'retail follows non-retail');
});

test('the series mapping is a setting, and an unknown series is ignored not guessed', () => {
  assert.equal(eofs.windowFor('IS', S), 'hni');
  assert.equal(eofs.windowFor('RS', S), 'ret');
  assert.equal(eofs.windowFor('ES', S), null, 'an employee series is not silently made retail');
  assert.equal(eofs.windowFor('ZZ', S), null);

  const swapped = { nse_series_hni: 'RS', nse_series_retail: 'IS' };
  assert.equal(eofs.windowFor('RS', swapped), 'hni', 'the mapping follows the setting');
});

test('a single-series offer mirrors its one window rather than inventing one', () => {
  const one = Object.assign({}, SEC, { configurations: [SEC.configurations[0]] });
  const { issue } = eofs.toIssue(one, S);
  assert.equal(issue.hni_open.getTime(), issue.ret_open.getTime());
});

test('anything incomplete is rejected with a reason, never half-built', () => {
  assert.match(eofs.toIssue({ configurations: [] }, S).rejected, /no symbol/);
  assert.match(eofs.toIssue({ symbol: 'X' }, S).rejected, /no series configuration/);

  // NOT a rejection: NSE's e-OFS FAQ v3.0 Q12 says the floor price "is not declared
  // to the market", so an OFS without one is normal. It is stored as null, and null
  // is not zero — a floor of zero would read as "any price clears".
  const noPrice = Object.assign({}, SEC, {
    configurations: SEC.configurations.map(function (c) { return Object.assign({}, c, { basePrice: 0 }); }) });
  const undisclosed = eofs.toIssue(noPrice, S);
  assert.ok(undisclosed.issue, 'an undisclosed floor is not a malformed issue');
  assert.equal(undisclosed.issue.floor_price, null);
  assert.equal(undisclosed.issue.cut_price_min, null);

  const badWindow = Object.assign({}, SEC, {
    configurations: [Object.assign({}, SEC.configurations[0], { mktCloseTime: '09:00:00' })] });
  assert.match(eofs.toIssue(badWindow, S).rejected, /no usable window/, 'close before open is not a window');

  const onlyES = Object.assign({}, SEC, {
    configurations: [Object.assign({}, SEC.configurations[0], { series: 'ES' })] });
  const out = eofs.toIssue(onlyES, S);
  assert.match(out.rejected, /unmapped series: ES/);
});

test('the time and date shapes NSE might use all parse', () => {
  assert.equal(eofs.timeToMinutes('09:15:00'), 555);
  assert.equal(eofs.timeToMinutes('09:15'), 555);
  assert.equal(eofs.timeToMinutes('0915'), 555);
  assert.equal(eofs.timeToMinutes('rubbish'), null);

  assert.equal(eofs.istAt('2026-05-27', 555).toISOString(), '2026-05-27T03:45:00.000Z');
  assert.equal(eofs.istAt('27-05-2026', 555).toISOString(), '2026-05-27T03:45:00.000Z');
  assert.equal(eofs.istAt('2026-05-27', null), null);
});

test('with no credentials, fetchIssues explains itself instead of failing', async () => {
  const u = process.env.OFS_EOFS_USER;
  delete process.env.OFS_EOFS_USER;
  const out = await eofs.fetchIssues(S);
  assert.equal(out.issues.length, 0);
  assert.equal(out.source, null);
  assert.match(out.attempts[0].error, /credentials are not configured/);
  assert.match(out.attempts[0].error, /NSE_API_REQUEST/);
  if (u === undefined) delete process.env.OFS_EOFS_USER; else process.env.OFS_EOFS_USER = u;
});
