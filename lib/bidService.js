'use strict';
/**
 * Everything a bid does, in one place, so the desk and the client cannot drift
 * apart. Before this existed there was exactly one bid path — the desk's — and the
 * client portal's own docstring claimed clients could write their own bids when no
 * such route existed. Two copies of these rules would have been worse than none:
 * the margin gate, the SEBI retail cap and the cut-off would have had to be fixed
 * twice, and one of the two would eventually have been missed.
 *
 * The routes keep what is theirs — who may call, whose UCC, what gets audited. What
 * lives here is what must be identical however the bid arrives.
 */
const { SCHEMA, one, tx } = require('../db/ofsAdapter');
const ld = require('../db/ldAdapter');
const settings = require('./settings');
const { validateBid, bidValue, makeRef, marketState, closedMessage, bidExchange,
        catStatus } = require('./domain');

/**
 * Everything validateBid needs, gathered in one place. `editingId` excludes the bid
 * being modified from the client's own margin usage — otherwise raising a bid by one
 * share would be checked as though the original were still outstanding.
 */
async function loadContext(issueId, ucc, editingId) {
  const s = await settings.all();
  const el = await ld.eligibility(ucc);
  const issue = await one(`SELECT * FROM ${SCHEMA}.ofs_issue WHERE id = $1`, [issueId]);
  const margin = await one(`SELECT available FROM ${SCHEMA}.ofs_margin WHERE client_ucc = $1`, [ucc]);
  const used = await one(
    `SELECT COALESCE(sum(value),0) AS v FROM ${SCHEMA}.ofs_bid
      WHERE client_ucc = $1 AND status = 'Live' ${editingId ? 'AND id <> $2' : ''}`,
    editingId ? [ucc, editingId] : [ucc]);
  const usedIssue = await one(
    `SELECT COALESCE(sum(value),0) AS v FROM ${SCHEMA}.ofs_bid
      WHERE client_ucc = $1 AND issue_id = $2 AND status = 'Live' ${editingId ? 'AND id <> $3' : ''}`,
    editingId ? [ucc, issueId, editingId] : [ucc, issueId]);
  const live = await one(
    `SELECT id FROM ${SCHEMA}.ofs_bid WHERE client_ucc = $1 AND issue_id = $2 AND status = 'Live'
      ${editingId ? 'AND id <> $3' : ''}`,
    editingId ? [ucc, issueId, editingId] : [ucc, issueId]);
  return {
    settings: s, issue,
    client: {
      found: el.found, active: el.active,
      // Why the client cannot bid, in words the desk can act on - "not in the
      // client master" and "account status is blank" are different problems and
      // go to different people.
      reason: el.reason || null,
      status: el.client && el.client.client_status,
      name: el.client && el.client.name,
      // The branch the client belongs to right now, so a bid can be stamped with it.
      branch: el.client && el.client.branch_id
    },
    availableMargin: Number(margin && margin.available) || 0,
    marginUsed: Number(used && used.v) || 0,
    usedValueThisIssue: Number(usedIssue && usedIssue.v) || 0,
    hasLiveBid: !!live
  };
}

function normalise(body) {
  body = body || {};
  return {
    issue_id: body.issue_id,
    client_ucc: String(body.client_ucc || '').trim().toUpperCase(),
    // Which exchange this bid goes to. Left as sent; loadContext's issue decides
    // whether it was needed and validateBid decides whether it is allowed.
    exchange: body.exchange ? String(body.exchange).trim().toUpperCase() : null,
    category: body.category,
    qty: Number(body.qty) || 0,
    is_cutoff: !!body.is_cutoff,
    price: body.is_cutoff ? null : Number(body.price) || 0,
    cp_code: body.cp_code || null,
    custody_code: body.custody_code || null,
    exch_order_no: body.exch_order_no || null
  };
}


/* ---------------------------------------------------------------- margin lock --
 *
 * validateBid checks the margin, and then the bid is written. Between those two
 * points there was nothing at all — no transaction, no lock, and no constraint in
 * the database saying the sum of a client's live bids may not exceed their margin.
 *
 * So: one client with ₹3,00,000 of margin. Two bids arrive within a few
 * milliseconds, on two DIFFERENT issues, each worth ₹2,00,000. Both reads see
 * nothing used, both compute ₹3,00,000 free, both pass, both insert. The partial
 * unique index only stops two live bids on the SAME issue, so nothing catches it,
 * and ₹4,00,000 of bids go to the exchange against ₹3,00,000 of margin. The window
 * is not microseconds either: an OTP redemption and a validation sit inside it.
 *
 * The fix is a transaction-scoped advisory lock keyed on the client, taken before
 * the total is re-read and released when the transaction ends. Per CLIENT, not
 * global: two different clients still bid concurrently, which is the whole point
 * during a window. An advisory lock rather than a row lock because a client may
 * have no ofs_margin row at all, and there is nothing to lock in that case.
 *
 * The re-check inside the lock is ONLY the margin. Everything else validateBid
 * decides — the window, the cap, the floor, the tick — is already settled and
 * cannot change under us in the way a running total can.
 */

/** The same arithmetic validateBid does, run again where nobody can interleave. */
async function marginGuard(c, ucc, settings, value, excludeId) {
  if (Number(settings && settings.enforce_margin) !== 1) return;
  if (value == null) return;                 // undisclosed floor: already reported

  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['ofs:margin:' + String(ucc)]);

  const m = await c.query(
    `SELECT COALESCE(available,0) AS v FROM ${SCHEMA}.ofs_margin WHERE client_ucc = $1`, [ucc]);
  const u = await c.query(
    `SELECT COALESCE(sum(value),0) AS v FROM ${SCHEMA}.ofs_bid
      WHERE client_ucc = $1 AND status = 'Live' ${excludeId ? 'AND id <> $2' : ''}`,
    excludeId ? [ucc, excludeId] : [ucc]);

  const available = Number(m.rows[0] && m.rows[0].v) || 0;
  const used = Number(u.rows[0] && u.rows[0].v) || 0;
  const free = available - used;

  if (available <= 0 || value > free + 1e-6) {
    const e = new Error(available <= 0
      ? 'Available margin is 0, so no bid can be placed for this client.'
      : 'Bid value ' + Math.round(value) + ' is above the free margin of ' +
        Math.round(Math.max(0, free)) + '.');
    e.status = 422;
    e.code = 'margin_exceeded';
    // Shaped like validateBid's answer so the caller can report it the same way.
    e.errors = [e.message];
    throw e;
  }
}

/**
 * Insert a Live bid. `placedBy` is 'desk' | 'client' | 'ap' and is what the audit
 * trail and the exchange file both read to say where a bid came from; the database
 * constrains it to those three.
 */
async function insertBid(b, ctx, placedBy, placedById, branchCode) {
  const value = bidValue(ctx.issue, b.category, b.qty, b.price, b.is_cutoff);
  const exch = bidExchange(ctx.issue, b.exchange);
  // The branch is stamped at placement, not looked up later: LD's BRANCH_ID can be
  // changed afterwards, and a bid already in a file sent to an exchange cannot.
  const branch = branchCode == null ? null : String(branchCode).trim().toUpperCase() || null;

  /* The reference carries the client's UCC, the IST date and the time to the
   * second, so a clash needs two bids for the same client in the same second
   * drawing the same four random characters. Retried anyway: ofs_bid.ref is
   * UNIQUE, and losing a bid to a one-in-1.6-million coincidence during a live
   * window is not a trade worth making. Only the ref is regenerated — a retry
   * must not quietly become a second, different bid. */
  const attempt = async (c) => (await c.query(
    `INSERT INTO ${SCHEMA}.ofs_bid
       (ref, issue_id, client_ucc, cp_code, custody_code, category, placed_by, placed_by_id,
        branch_code, exchange, qty, price, is_cutoff, value, status, exch_order_no)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'Live',$15)
     RETURNING *`,
    [makeRef('OFS', b.client_ucc), b.issue_id, b.client_ucc, b.cp_code, b.custody_code, b.category,
     placedBy, placedById == null ? null : String(placedById), branch, exch,
     b.qty, b.price, b.is_cutoff, value, b.exch_order_no])).rows[0];

  return tx(async (c) => {
    await marginGuard(c, b.client_ucc, ctx.settings, value, null);
    try {
      return await attempt(c);
    } catch (e) {
      // 23505 on the REF alone. A duplicate live bid is a different constraint and
      // a different answer — it must keep travelling up to the 409 the caller
      // sends.
      if (e && e.code === '23505' && /ref/.test(String(e.constraint || ''))) return attempt(c);
      throw e;
    }
  });
}

/** The fields a modification may touch. Everything else stays as it was placed. */
function mergeForModify(before, body) {
  const b = {
    issue_id: before.issue_id,
    client_ucc: before.client_ucc,
    exchange: body.exchange ? String(body.exchange).trim().toUpperCase() : before.exchange,
    category: body.category || before.category,
    qty: Number(body.qty != null ? body.qty : before.qty) || 0,
    is_cutoff: body.is_cutoff != null ? !!body.is_cutoff : before.is_cutoff,
    price: null,
    editingId: before.id
  };
  b.price = b.is_cutoff ? null : Number(body.price != null ? body.price : before.price) || 0;
  return b;
}

/**
 * Apply a modification.
 *
 * The WHERE clause carries the status the caller read, not just the id. It used to
 * name only the id and write status='Live' unconditionally, and the "is it
 * cancelled?" check sat in the route — a read taken before validation, an OTP
 * round-trip and a margin lookup. So: a client taps Withdraw at 15:09 while the
 * desk already has a modify in flight for the same bid. The cancel commits and the
 * client's screen says withdrawn; the modify then puts the row back to 'Live' with
 * a new quantity, and it goes into the 15:15 file. The client gets an allotment for
 * a bid they withdrew.
 *
 * Now the UPDATE matches nothing in that case and we say so, rather than winning a
 * race we should have lost.
 */
async function updateBid(before, b, ctx, exchOrderNo) {
  const value = bidValue(ctx.issue, b.category, b.qty, b.price, b.is_cutoff);
  const exch = bidExchange(ctx.issue, b.exchange) || before.exchange;
  const r = await tx(async (c) => {
    // Raising a bid spends margin exactly as placing one does, and the bid being
    // modified is excluded from the total — otherwise adding one share would be
    // checked as though the original were still outstanding alongside it.
    await marginGuard(c, before.client_ucc, ctx.settings, value, before.id);
    return (await c.query(
      `UPDATE ${SCHEMA}.ofs_bid
          SET qty = $1, price = $2, is_cutoff = $3, value = $4, category = $5, exchange = $6,
              status = 'Live', exch_order_no = COALESCE($7, exch_order_no)
        WHERE id = $8 AND status = $9 RETURNING *`,
      [b.qty, b.price, b.is_cutoff, value, b.category, exch, exchOrderNo || null,
       before.id, before.status])).rows[0] || null;
  });
  if (!r) {
    const e = new Error('This bid changed while you were editing it. Reload the bid book and try again.');
    e.status = 409;
    e.code = 'stale_bid';
    throw e;
  }
  return r;
}

async function cancelBid(before, reason) {
  const r = await one(
    `UPDATE ${SCHEMA}.ofs_bid SET status = 'Cancelled', reject_reason = $2
      WHERE id = $1 AND status = $3 RETURNING *`,
    [before.id, reason ? String(reason).slice(0, 300) : null, before.status]);
  if (!r) {
    const e = new Error('This bid changed while you were withdrawing it. Reload and try again.');
    e.status = 409;
    e.code = 'stale_bid';
    throw e;
  }
  return r;
}

/**
 * May this bid's CATEGORY still be withdrawn from?
 *
 * The desk cut-off is not the only clock. An HNI window can run 09:15-13:00 on T
 * day while the desk cut-off is 15:15, and a withdrawal accepted at 14:00 cannot
 * reach the exchange — the category closed an hour earlier. The book then says
 * cancelled and the exchange still holds the bid, and nobody finds out until
 * allotment. A modification has always been gated on the window, through
 * validateBid; a cancellation was not.
 */
function cancelWindowMessage(issue, category, now) {
  if (!issue) return null;
  const st = catStatus(issue, category, now || new Date());
  if (st === 'Open') return null;
  return 'The ' + category + ' window for ' + (issue.symbol || 'this offer') + ' is ' +
    st.toLowerCase() + ', so this bid can no longer be withdrawn here. ' +
    'Contact the OFS desk.';
}

/**
 * A cancellation is a bid change like any other: allowed until the cut-off, not
 * after it. Returns null when it may proceed, or the message to refuse with.
 */
async function cancelBlockedMessage(now) {
  const mkt = marketState(await settings.all(), now || new Date());
  return mkt.open ? null : closedMessage(mkt);
}

module.exports = {
  cancelWindowMessage, marginGuard,
  loadContext, normalise, insertBid, mergeForModify, updateBid, cancelBid,
  cancelBlockedMessage, validateBid, bidValue
};
