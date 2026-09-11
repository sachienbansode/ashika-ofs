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
const { SCHEMA, one } = require('../db/ofsAdapter');
const ld = require('../db/ldAdapter');
const settings = require('./settings');
const { validateBid, bidValue, makeRef, marketState, closedMessage } = require('./domain');

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
    category: body.category,
    qty: Number(body.qty) || 0,
    is_cutoff: !!body.is_cutoff,
    price: body.is_cutoff ? null : Number(body.price) || 0,
    cp_code: body.cp_code || null,
    custody_code: body.custody_code || null,
    exch_order_no: body.exch_order_no || null
  };
}

/**
 * Insert a Live bid. `placedBy` is 'desk' | 'client' | 'ap' and is what the audit
 * trail and the exchange file both read to say where a bid came from; the database
 * constrains it to those three.
 */
async function insertBid(b, ctx, placedBy, placedById, branchCode) {
  const value = bidValue(ctx.issue, b.category, b.qty, b.price, b.is_cutoff);
  // The branch is stamped at placement, not looked up later: LD's BRANCH_ID can be
  // changed afterwards, and a bid already in a file sent to an exchange cannot.
  const branch = branchCode == null ? null : String(branchCode).trim().toUpperCase() || null;
  return one(
    `INSERT INTO ${SCHEMA}.ofs_bid
       (ref, issue_id, client_ucc, cp_code, custody_code, category, placed_by, placed_by_id,
        branch_code, qty, price, is_cutoff, value, status, exch_order_no)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Live',$14)
     RETURNING *`,
    [makeRef('OFS'), b.issue_id, b.client_ucc, b.cp_code, b.custody_code, b.category,
     placedBy, placedById == null ? null : String(placedById), branch,
     b.qty, b.price, b.is_cutoff, value, b.exch_order_no]);
}

/** The fields a modification may touch. Everything else stays as it was placed. */
function mergeForModify(before, body) {
  const b = {
    issue_id: before.issue_id,
    client_ucc: before.client_ucc,
    category: body.category || before.category,
    qty: Number(body.qty != null ? body.qty : before.qty) || 0,
    is_cutoff: body.is_cutoff != null ? !!body.is_cutoff : before.is_cutoff,
    price: null,
    editingId: before.id
  };
  b.price = b.is_cutoff ? null : Number(body.price != null ? body.price : before.price) || 0;
  return b;
}

async function updateBid(before, b, ctx, exchOrderNo) {
  const value = bidValue(ctx.issue, b.category, b.qty, b.price, b.is_cutoff);
  return one(
    `UPDATE ${SCHEMA}.ofs_bid
        SET qty = $1, price = $2, is_cutoff = $3, value = $4, category = $5,
            status = 'Live', exch_order_no = COALESCE($6, exch_order_no)
      WHERE id = $7 RETURNING *`,
    [b.qty, b.price, b.is_cutoff, value, b.category, exchOrderNo || null, before.id]);
}

async function cancelBid(before, reason) {
  return one(
    `UPDATE ${SCHEMA}.ofs_bid SET status = 'Cancelled', reject_reason = $2 WHERE id = $1 RETURNING *`,
    [before.id, reason ? String(reason).slice(0, 300) : null]);
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
  loadContext, normalise, insertBid, mergeForModify, updateBid, cancelBid,
  cancelBlockedMessage, validateBid, bidValue
};
