'use strict';
/**
 * What a signed-in client can see and do. Every route is scoped to req.client.ucc:
 * a client can only ever read or write their own bids, never another account's.
 */
const express = require('express');
const { SCHEMA, rows, one } = require('../db/ofsAdapter');
const { requireClient, requireSingleClient } = require('../middleware/clientAuth');
const branches = require('../db/branchAdapter');
const ba = require('../lib/branchAuth');
const { issueStatus, catStatus, minPrice, validateBid, openOnDay, issueOpenOnDay,
        marketState, closedMessage } = require('../lib/domain');
const settings = require('../lib/settings');
const bids = require('../lib/bidService');
const audit = require('../lib/audit');
const dbErr = require('../lib/dbErrors');
const bidOtp = require('../lib/bidOtp');
const ld = require('../db/ldAdapter');
const pii = require('../lib/pii');

const router = express.Router();
router.use(requireClient);

/**
 * Which clients is this session allowed to see?
 *
 * A client session answers with its own UCC. A branch or AP session answers with
 * every active client whose ask_clientmast.BRANCH_ID is that branch — read live from
 * LD, so a client moved to another branch this morning moves with it.
 *
 * Returned as a list rather than a flag, because every query below filters on it and
 * a missing filter must produce an empty result, not everybody's.
 */
async function scopeUccs(req) {
  const p = req.portal || {};
  if (p.kind === 'client') return p.ucc ? [String(p.ucc).toUpperCase()] : [];
  if (p.kind === 'ap' || p.kind === 'branch') {
    if (!p.branchCode) return [];          // scoped to nothing is not scoped to everything
    return branches.uccsOfBranch(p.branchCode);
  }
  return [];
}

/** How this session describes itself on screen. */
/**
 * Mask contact details for a branch or an AP.
 *
 * ld.enrich hands back pan, mobile and email raw, and these rows go to a branch
 * session — which is not the desk. An AP already knows their own clients, so full
 * PAN and email on the screen add exposure without adding capability, and the same
 * rows go out in the CSV, which leaves the building.
 *
 * A CLIENT session is left alone: masking someone's own address back at them is
 * noise, and it is their address.
 */
function maskPortalRows(req, list) {
  if (!req.portal || req.portal.kind === 'client') return list;
  return (list || []).map((r) => Object.assign({}, r, {
    pan: r.pan ? pii.maskPan(r.pan) : r.pan,
    mobile: r.mobile ? pii.maskMobile(r.mobile) : r.mobile,
    email: r.email ? pii.maskEmail(r.email) : r.email
  }));
}

function whoAmI(req) {
  const p = req.portal || {};
  return {
    kind: p.kind,
    label: ba.actorLabel(p.kind),
    ucc: p.ucc || null,
    branch_code: p.branchCode || null,
    branch_name: p.branchName || null
  };
}

/** Open issues, as a client sees them: no desk aggregates, no other clients' bids. */
/**
 * The client's list of open issues.
 *
 * status = 'Auto' rather than "not Closed": a Suspended issue must not appear here.
 * That covers both a desk suspension and — the case that made this explicit — an
 * issue the circular watch created automatically, whose floor price and windows were
 * read out of a PDF and not yet checked by anyone. Showing a client a floor price of
 * 0.01 with invented dates would be worse than showing them nothing.
 */
router.get('/issues', async (req, res, next) => {
  try {
    const s = await settings.all();
    const list = await rows(
      `SELECT id, symbol, company, isin, exchange, floor_price, cut_price_min, tick, lot,
              discount_pct, cutoff_flag, hni_open, hni_close, ret_open, ret_close,
              indicative_ri, indicative_ni, status
         FROM ${SCHEMA}.ofs_issue
        WHERE archived_at IS NULL
          AND status = 'Auto'                 -- never Suspended, never Closed
          AND needs_review = false            -- never one the app created from a circular
          AND greatest(hni_close, ret_close) > now()
        ORDER BY greatest(hni_close, ret_close)`);

    const scope = await scopeUccs(req);
    const mine = scope.length ? await rows(
      `SELECT id, ref, issue_id, client_ucc, branch_code, placed_by, category, qty, price,
              is_cutoff, value, status, created_at
         FROM ${SCHEMA}.ofs_bid
        WHERE client_ucc = ANY($1) AND status <> 'Cancelled'
        ORDER BY created_at DESC`, [scope]) : [];

    const now = new Date();
    res.json({
      server_time: now.toISOString(),
      actor: whoAmI(req),
      settings: { retail_cap: s.retail_cap, hni_min: s.hni_min, daily_cutoff: s.daily_cutoff },
      issues: list.map((i) => Object.assign({}, i, {
        status_label: issueStatus(i, now),
        ret_status: catStatus(i, 'Retail', now),
        hni_status: catStatus(i, 'HNI', now),
        min_price_retail: minPrice(i, 'Retail'),
        min_price_hni: minPrice(i, 'HNI'),
        // A client sees their own bid. A branch sees how many of its clients have
        // bid on this issue — the single "my bid" line means nothing to a branch
        // holding two hundred clients.
        my_bid: req.portal.kind === 'client'
          ? (mine.find((b) => String(b.issue_id) === String(i.id)) || null)
          : null,
        branch_bids: req.portal.kind === 'client' ? null : (() => {
          const rowsFor = mine.filter((b) => String(b.issue_id) === String(i.id));
          return {
            count: rowsFor.length,
            clients: new Set(rowsFor.map((b) => b.client_ucc)).size,
            qty: rowsFor.reduce((t, b) => t + Number(b.qty || 0), 0),
            value: rowsFor.reduce((t, b) => t + Number(b.value || 0), 0)
          };
        })()
      }))
    });
  } catch (e) { next(e); }
});

/** The client's own bids, and their margin. */
/**
 * The bids this session may see.
 *
 * For an AP or a branch that includes bids the CLIENT placed themselves — asked for
 * explicitly, and right: an AP who cannot see what their own client did cannot
 * advise them, and will place a duplicate the exchange then rejects. placed_by says
 * which it was, so the distinction is visible without being hidden.
 */
router.get('/me/bids', async (req, res, next) => {
  try {
    const scope = await scopeUccs(req);
    if (!scope.length) return res.json({ actor: whoAmI(req), bids: [], total: 0, margin: null });

    const limit = Math.min(Number(req.query.limit) || 10, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const all = String(req.query.all || '') === '1';         // the CSV wants everything

    /* The same filters the desk's bid book has, because it is the same screen.
     * Built as a fragment on a shared params array so the count and the page can
     * never disagree about what is being filtered - two hand-written WHERE clauses
     * is how a pager ends up claiming 40 rows and showing 12. */
    const p = [scope];
    let where = 'b.client_ucc = ANY($1)';
    // replace ALL the placeholders, not the first: the search clause uses the same
    // value twice, and String.replace with a string pattern only ever does one.
    const add = (sql, val) => { p.push(val); where += sql.split('$$').join('$' + p.length); };

    if (req.query.issue_id) add(' AND b.issue_id = $$::int', Number(req.query.issue_id));
    if (req.query.category) add(' AND b.category = $$', String(req.query.category));
    if (req.query.status) add(' AND b.status = $$', String(req.query.status));
    else if (String(req.query.include_cancelled || '') !== '1') {
      // Cancelled bids are not part of the book. They stay reachable, but a branch
      // reading a total that quietly includes them is reading the wrong number.
      where += " AND b.status <> 'Cancelled'";
    }
    if (req.query.placed_by) add(' AND b.placed_by = $$', String(req.query.placed_by));
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.as_on || ''))) {
      add(" AND (b.created_at AT TIME ZONE 'Asia/Kolkata')::date = $$::date", String(req.query.as_on));
    }
    if (String(req.query.q || '').trim()) {
      add(" AND (upper(b.client_ucc) LIKE $$ OR upper(b.ref) LIKE $$)",
        '%' + String(req.query.q).trim().toUpperCase() + '%');
    }

    const total = await one(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.ofs_bid b WHERE ${where}`, p);

    const b = await rows(
      `SELECT b.id, b.ref, b.issue_id, b.client_ucc, b.branch_code, b.placed_by, b.placed_by_id,
              b.category, b.qty, b.price, b.is_cutoff, b.value,
              b.status, b.reject_reason, b.otp_verified, b.created_at, b.updated_at,
              i.symbol, i.company, i.isin, i.exchange, i.floor_price, i.ret_close, i.hni_close
         FROM ${SCHEMA}.ofs_bid b
         LEFT JOIN ${SCHEMA}.ofs_issue i ON i.id = b.issue_id
        WHERE ${where}
        ORDER BY b.created_at DESC
        ${all ? '' : `LIMIT $${p.length + 1} OFFSET $${p.length + 2}`}`,
      all ? p : p.concat([limit, offset]));

    // Client names for a branch list; a branch reading a column of bare UCCs cannot
    // tell which of its clients is which.
    const withNames = req.portal.kind === 'client'
      ? b
      : maskPortalRows(req, await ld.enrich(b, 'client_ucc'));

    // Margin is a per-client fact, so it is only meaningful on a client session.
    let margin = null;
    if (req.portal.kind === 'client') {
      const m = await one(
        `SELECT COALESCE(available,0) AS available FROM ${SCHEMA}.ofs_margin WHERE client_ucc = $1`,
        [req.portal.ucc]);
      const used = await one(
        `SELECT COALESCE(sum(value),0) AS v FROM ${SCHEMA}.ofs_bid
          WHERE client_ucc = $1 AND status = 'Live'`, [req.portal.ucc]);
      const available = Number(m && m.available) || 0;
      const consumed = Number(used && used.v) || 0;
      margin = { available, used: consumed, free: available - consumed };
    }

    res.json({ actor: whoAmI(req), bids: withNames,
               total: (total && total.n) || 0, limit, offset, margin });
  } catch (e) { next(e); }
});

/** Allotment results for this client, once the desk has imported them. */
router.get('/me/allotments', async (req, res, next) => {
  try {
    const scope = await scopeUccs(req);
    if (!scope.length) return res.json({ actor: whoAmI(req), allotments: [] });
    const a = await rows(
      `SELECT a.client_ucc, a.allot_qty, a.allot_price, a.allot_value, a.allotted_at,
              i.symbol, i.company
         FROM ${SCHEMA}.ofs_allotment a
         LEFT JOIN ${SCHEMA}.ofs_issue i ON i.id = a.issue_id
        WHERE a.client_ucc = ANY($1)
        ORDER BY a.allotted_at DESC LIMIT 500`, [scope]);
    res.json({ actor: whoAmI(req), allotments: a });
  } catch (e) { next(e); }
});

/**
 * GET /client/api/me/clients — the clients this branch may act for.
 * Empty for a client session by design: a client is not a list of clients.
 */
router.get('/me/clients', async (req, res, next) => {
  try {
    if (req.portal.kind === 'client') return res.json({ actor: whoAmI(req), clients: [] });
    const scope = await scopeUccs(req);
    const map = await ld.findMany(scope);
    const q = String(req.query.q || '').trim().toUpperCase();
    let list = scope.map((u) => {
      const c = map.get(u) || {};
      return { ucc: u, name: c.name || null, category: c.category || null,
               branch: c.branch_id || null, active: c.is_active === true };
    });
    if (q) list = list.filter((c) => c.ucc.includes(q) || String(c.name || '').toUpperCase().includes(q));

    // Paged on the SERVER. 121 clients is already too many to scroll, and the AP
    // with the biggest book has several hundred — a screen that renders all of them
    // and lets the browser sort it out is the one that stops being usable first.
    const total = list.length;
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const all = String(req.query.all || '') === '1';        // the CSV wants everything
    const page = all ? list : list.slice(offset, offset + limit);
    res.json({ actor: whoAmI(req), clients: page, total, limit, offset, q: q || null });
  } catch (e) { next(e); }
});

/* ----------------------------------------------------------------- bidding --
 * A client places, modifies and cancels their OWN bid. Three things make this
 * safe to expose, and all three are enforced here rather than trusted:
 *
 *   the UCC is taken from the session, never from the body — a client cannot bid
 *   on another account by editing a request;
 *   every rule runs through lib/bidService, the same code the desk uses, so the
 *   margin gate, the SEBI retail cap, the floor and the cut-off cannot differ by
 *   which screen the bid came from;
 *   ownership is re-checked on the row itself before a modify or a cancel.
 *
 * placed_by records which of the two it was — the client themselves, or their AP
 * acting for them — because the bid book, the audit trail and the exchange file
 * all need to tell those apart.
 */
function placedBy(req) {
  return req.client.actorType === 'ap' ? 'ap' : 'client';
}
function placedById(req) {
  return req.client.actorType === 'ap' ? req.client.apId : req.client.ucc;
}

/**
 * The body a client may send. Their UCC is not in it — the session decides that.
 *
 * These routes are gated by requireSingleClient, so req.client is always present
 * here. A branch or AP session is refused with a clear message rather than falling
 * through to whatever happened to be in the column: bidding on a client's behalf
 * needs that client's own one-time confirmation, which is its own path.
 */
function clientBid(req) {
  return bids.normalise(Object.assign({}, req.body, {
    client_ucc: req.client.ucc,
    cp_code: null, custody_code: null, exch_order_no: null   // desk-only fields
  }));
}

/** POST /client/api/bids/validate — dry run, so the screen can show the verdict. */
router.post('/bids/validate', requireSingleClient, async (req, res, next) => {
  try {
    const b = clientBid(req);
    if (!b.issue_id) return res.status(400).json({ error: 'missing_field', field: 'issue_id' });
    const ctx = await bids.loadContext(b.issue_id, b.client_ucc, req.body.editingId || null);
    if (!ctx.issue) return res.status(404).json({ error: 'unknown_issue' });
    if (req.body.editingId) b.editingId = req.body.editingId;
    const errs = validateBid(ctx.issue, b, ctx);
    res.json({
      ok: errs.length === 0,
      errors: errs,
      value: bids.bidValue(ctx.issue, b.category, b.qty, b.price, b.is_cutoff),
      min_price: minPrice(ctx.issue, b.category),
      available_margin: ctx.availableMargin,
      free_margin: ctx.availableMargin - ctx.marginUsed
    });
  } catch (e) { next(e); }
});

/** POST /client/api/bids — place. */
router.post('/bids', requireSingleClient, async (req, res, next) => {
  try {
    const b = clientBid(req);
    if (!b.issue_id) return res.status(400).json({ error: 'missing_field', field: 'issue_id' });

    const ctx = await bids.loadContext(b.issue_id, b.client_ucc, null);
    if (!ctx.issue) return res.status(404).json({ error: 'unknown_issue' });
    // A client may only bid on an issue they can see: the same filter as /issues.
    if (ctx.issue.archived_at || ctx.issue.status !== 'Auto' || ctx.issue.needs_review) {
      return res.status(409).json({ error: 'issue_not_open',
        message: 'This offer is not open for bidding.' });
    }

    const errs = validateBid(ctx.issue, b, ctx);
    if (errs.length) return res.status(422).json({ error: 'validation_failed', errors: errs });

    const r = await bids.insertBid(b, ctx, placedBy(req), placedById(req), ctx.client.branch);
    await audit.log(req, 'place', 'ofs_bid', r.id, null, r);
    res.status(201).json({ bid: r });
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ error: 'duplicate_live_bid',
        message: 'You already have a live bid on this offer. Change that bid instead of placing another.' });
    }
    dbErr.send(res, next, e);
  }
});

/** The client's own bid, or 404 — never another account's, and never "403". */
async function ownBid(req) {
  return one(`SELECT * FROM ${SCHEMA}.ofs_bid WHERE id = $1 AND client_ucc = $2`,
    [req.params.id, req.client.ucc]);
}

/** PUT /client/api/bids/:id — modify, allowed until the cut-off. */
router.put('/bids/:id(\\d+)', requireSingleClient, async (req, res, next) => {
  try {
    const before = await ownBid(req);
    if (!before) return res.status(404).json({ error: 'not_found' });
    if (before.status === 'Cancelled') return res.status(409).json({ error: 'already_cancelled' });

    const b = bids.mergeForModify(before, req.body || {});
    const ctx = await bids.loadContext(b.issue_id, b.client_ucc, before.id);
    const errs = validateBid(ctx.issue, b, ctx);
    if (errs.length) return res.status(422).json({ error: 'validation_failed', errors: errs });

    const r = await bids.updateBid(before, b, ctx, null);
    await audit.log(req, 'modify', 'ofs_bid', r.id, before, r);
    res.json({ bid: r });
  } catch (e) { dbErr.send(res, next, e); }
});

/** DELETE /client/api/bids/:id — cancel. Never a hard delete: the row is the record. */
router.delete('/bids/:id(\\d+)', requireSingleClient, async (req, res, next) => {
  try {
    const before = await ownBid(req);
    if (!before) return res.status(404).json({ error: 'not_found' });
    if (before.status === 'Cancelled') return res.status(409).json({ error: 'already_cancelled' });

    // No force flag here. The desk may cancel after the cut-off with a reason on
    // record; a client may not.
    const blocked = await bids.cancelBlockedMessage();
    if (blocked) return res.status(422).json({ error: 'window_closed', message: blocked });

    const r = await bids.cancelBid(before, req.body && req.body.reason);
    await audit.log(req, 'cancel', 'ofs_bid', r.id, before, r);
    res.json({ bid: r });
  } catch (e) { next(e); }
});


/* ------------------------------------------------- bidding on a client's behalf --
 * An AP or a branch bids FOR a client, and the client confirms with a code sent to
 * their own registered mobile and email. The rule Ashika chose: a client acting
 * alone needs no code, anyone acting for them does.
 *
 * Two checks before a code is even sent, both against LD rather than the request:
 * the client must currently belong to this branch, and the branch must still be
 * allowed to sign in. A stale session must not outlive either.
 */
function branchActor(req) {
  const p = req.portal || {};
  return { kind: p.kind, code: p.branchCode, name: p.branchName };
}

async function requireOwnClient(req, res, ucc) {
  const a = branchActor(req);
  if (a.kind !== 'ap' && a.kind !== 'branch') {
    res.status(403).json({ error: 'not_a_branch' });
    return false;
  }
  const owned = await branches.branchHasClient(a.code, ucc);
  if (!owned) {
    // 404, not 403: confirming that a UCC exists but belongs to someone else tells
    // a branch something about another branch's book.
    res.status(404).json({ error: 'not_your_client',
      message: 'That client is not mapped to your branch, or is not active.' });
    return false;
  }
  return true;
}

/** POST /client/api/branch/bids/otp { issue_id, client_ucc, action, bid_id } */
router.post('/branch/bids/otp', async (req, res, next) => {
  try {
    const b = req.body || {};
    const ucc = String(b.client_ucc || '').trim().toUpperCase();
    if (!ucc || !b.issue_id) return res.status(400).json({ error: 'missing_field' });
    if (!(await requireOwnClient(req, res, ucc))) return;

    const issue = await one(`SELECT symbol, company FROM ${SCHEMA}.ofs_issue WHERE id = $1`, [b.issue_id]);
    if (!issue) return res.status(404).json({ error: 'unknown_issue' });

    const a = branchActor(req);
    const r = await bidOtp.create({
      clientUcc: ucc, issueId: b.issue_id, action: String(b.action || 'place'), bidId: b.bid_id,
      requestedBy: ba.actorLabel(a.kind) + ' ' + a.code + (a.name ? ' (' + a.name + ')' : ''),
      requestedByKind: a.kind,
      issueLabel: issue.symbol + (issue.company ? ' — ' + issue.company : ''),
      detail: b.detail, ip: req.ip, userAgent: req.headers['user-agent']
    });
    if (!r.ok) return res.status(r.reason === 'unknown_client' ? 404 : 422).json({
      error: r.reason, message: r.message || 'Could not send a confirmation code.' });

    await audit.log(req, 'bid_otp_sent', 'ofs_bid', b.bid_id || null, null,
      { ucc, issue_id: b.issue_id, action: b.action || 'place', sent_to: r.sent_to });
    res.json(r);
  } catch (e) { next(e); }
});

async function branchConfirm(req, res, { ucc, issueId, action, bidId }) {
  const body = req.body || {};
  if (!body.otp_ref || !body.otp) {
    res.status(428).json({ error: 'otp_required', action, client_ucc: ucc, issue_id: issueId,
      message: 'The client must confirm this. Send them a code, then enter it here.' });
    return false;
  }
  const v = await bidOtp.verify({ ref: body.otp_ref, code: String(body.otp).replace(/\D/g, ''),
    clientUcc: ucc, issueId, action, bidId });
  if (!v.ok) {
    res.status(401).json({ error: v.reason, message: bidOtp.message(v.reason),
      attempts_left: v.attemptsLeft });
    return false;
  }
  return true;
}

/** POST /client/api/branch/bids/validate — dry run, no code needed. */
router.post('/branch/bids/validate', async (req, res, next) => {
  try {
    const b = bids.normalise(Object.assign({}, req.body,
      { cp_code: null, custody_code: null, exch_order_no: null }));
    if (!b.issue_id || !b.client_ucc) return res.status(400).json({ error: 'missing_field' });
    if (!(await requireOwnClient(req, res, b.client_ucc))) return;

    const ctx = await bids.loadContext(b.issue_id, b.client_ucc, req.body.editingId || null);
    if (!ctx.issue) return res.status(404).json({ error: 'unknown_issue' });
    if (req.body.editingId) b.editingId = req.body.editingId;
    const errs = validateBid(ctx.issue, b, ctx);
    res.json({
      ok: errs.length === 0, errors: errs,
      value: bids.bidValue(ctx.issue, b.category, b.qty, b.price, b.is_cutoff),
      min_price: minPrice(ctx.issue, b.category),
      client_name: ctx.client.name || null,
      available_margin: ctx.availableMargin,
      free_margin: ctx.availableMargin - ctx.marginUsed
    });
  } catch (e) { next(e); }
});

/** POST /client/api/branch/bids — place for one of this branch's clients. */
router.post('/branch/bids', async (req, res, next) => {
  try {
    const b = bids.normalise(Object.assign({}, req.body,
      { cp_code: null, custody_code: null, exch_order_no: null }));
    if (!b.issue_id || !b.client_ucc) return res.status(400).json({ error: 'missing_field' });
    if (!(await requireOwnClient(req, res, b.client_ucc))) return;

    const ctx = await bids.loadContext(b.issue_id, b.client_ucc, null);
    if (!ctx.issue) return res.status(404).json({ error: 'unknown_issue' });
    if (ctx.issue.archived_at || ctx.issue.status !== 'Auto' || ctx.issue.needs_review) {
      return res.status(409).json({ error: 'issue_not_open', message: 'This offer is not open for bidding.' });
    }
    const errs = validateBid(ctx.issue, b, ctx);
    if (errs.length) return res.status(422).json({ error: 'validation_failed', errors: errs });

    if (!(await branchConfirm(req, res, { ucc: b.client_ucc, issueId: b.issue_id, action: 'place' }))) return;

    const a = branchActor(req);
    const r = await bids.insertBid(b, ctx, ba.placedByOf(a.kind), a.code, a.code);
    await query(`UPDATE ${SCHEMA}.ofs_bid SET otp_verified = true, otp_ref = $2 WHERE id = $1`,
      [r.id, String(req.body.otp_ref)]).catch(() => {});
    await audit.log(req, 'place', 'ofs_bid', r.id, null, r);
    res.status(201).json({ bid: r });
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ error: 'duplicate_live_bid',
        message: 'This client already has a live bid on this offer. Change that bid instead.' });
    }
    dbErr.send(res, next, e);
  }
});

/** The bid, only if it belongs to a client of this branch. */
async function branchBid(req) {
  const a = branchActor(req);
  if (!a.code) return null;
  const row = await one(`SELECT * FROM ${SCHEMA}.ofs_bid WHERE id = $1`, [req.params.id]);
  if (!row) return null;
  const owned = await branches.branchHasClient(a.code, row.client_ucc);
  return owned ? row : null;
}

/** PUT /client/api/branch/bids/:id */
router.put('/branch/bids/:id(\\d+)', async (req, res, next) => {
  try {
    const before = await branchBid(req);
    if (!before) return res.status(404).json({ error: 'not_found' });
    if (before.status === 'Cancelled') return res.status(409).json({ error: 'already_cancelled' });

    const b = bids.mergeForModify(before, req.body || {});
    const ctx = await bids.loadContext(b.issue_id, b.client_ucc, before.id);
    const errs = validateBid(ctx.issue, b, ctx);
    if (errs.length) return res.status(422).json({ error: 'validation_failed', errors: errs });

    if (!(await branchConfirm(req, res,
      { ucc: before.client_ucc, issueId: before.issue_id, action: 'modify', bidId: before.id }))) return;

    const r = await bids.updateBid(before, b, ctx, null);
    await query(`UPDATE ${SCHEMA}.ofs_bid SET otp_verified = true, otp_ref = $2 WHERE id = $1`,
      [r.id, String(req.body.otp_ref)]).catch(() => {});
    await audit.log(req, 'modify', 'ofs_bid', r.id, before, r);
    res.json({ bid: r });
  } catch (e) { dbErr.send(res, next, e); }
});

/** DELETE /client/api/branch/bids/:id */
router.delete('/branch/bids/:id(\\d+)', async (req, res, next) => {
  try {
    const before = await branchBid(req);
    if (!before) return res.status(404).json({ error: 'not_found' });
    if (before.status === 'Cancelled') return res.status(409).json({ error: 'already_cancelled' });

    const blocked = await bids.cancelBlockedMessage();
    if (blocked) return res.status(422).json({ error: 'window_closed', message: blocked });

    if (!(await branchConfirm(req, res,
      { ucc: before.client_ucc, issueId: before.issue_id, action: 'cancel', bidId: before.id }))) return;

    const r = await bids.cancelBid(before, req.body && req.body.reason);
    await audit.log(req, 'cancel', 'ofs_bid', r.id, before, r);
    res.json({ bid: r });
  } catch (e) { dbErr.send(res, next, e); }
});


/**
 * GET /client/api/me/clients/:ucc — one client and their margin.
 *
 * The Client & margin panel beside the bid form, answering with the same shape the
 * desk's /api/clients/:ucc does so the panel renders unchanged. Two differences,
 * both enforced here because the screen is the same screen:
 *
 *   the UCC must be one of THIS branch's clients - checked against LD on every
 *   call, not against a list the page sent us; and
 *   contact details are masked, because an AP is not the desk.
 *
 * A UCC outside the branch answers 404, not 403: "not found" and "not yours" are
 * the same answer to someone probing for which accounts exist.
 */
router.get('/me/clients/:ucc', async (req, res, next) => {
  try {
    const ucc = String(req.params.ucc || '').trim().toUpperCase();
    if (!ucc) return res.status(400).json({ error: 'invalid_input' });

    if (req.portal.kind === 'client') {
      if (ucc !== String(req.portal.ucc || '').toUpperCase()) return res.status(404).json({ error: 'not_found' });
    } else {
      const owned = await branches.branchHasClient(req.portal.branchCode, ucc);
      if (!owned) return res.status(404).json({ error: 'not_found' });
    }

    const el = await ld.eligibility(ucc);
    if (!el.found) return res.status(404).json({ error: 'not_found' });

    const m = await one(
      `SELECT COALESCE(available,0) AS available FROM ${SCHEMA}.ofs_margin WHERE client_ucc = $1`, [ucc]);
    const used = await one(
      `SELECT COALESCE(sum(value),0) AS v FROM ${SCHEMA}.ofs_bid
        WHERE client_ucc = $1 AND status = 'Live'`, [ucc]);
    const available = Number(m && m.available) || 0;
    const consumed = Number(used && used.v) || 0;

    const c = el.client || {};
    const [masked] = maskPortalRows(req, [{
      pan: c.pan || null, mobile: c.mobile || null, email: c.email || null
    }]);

    res.json({
      client: {
        ucc: ucc, name: c.name || null, category: c.category || null,
        pan: masked.pan, mobile: masked.mobile, email: masked.email,
        branch_id: c.branch_id || null, active: el.active === true,
        available_margin: available
      },
      free_margin: available - consumed,
      // The desk's panel prints this note when PII is masked; a branch is always
      // masked, so it always prints, and the AP is never left wondering whether a
      // dotted PAN is a data problem.
      pii_unmasked: false
    });
  } catch (e) { next(e); }
});

/**
 * GET /client/api/me — who is signed in, and what the shell may show them.
 *
 * The partner shell is the BACK-OFFICE shell, so it boots the same way: it asks who
 * it is talking to and hides what that answer does not include. Permissions are
 * synthesised rather than read from a role, because a branch is not a platform user
 * and holds no page grants - but the shape has to match what applyGrants() expects
 * or the sweep silently disables everything.
 *
 * ofs-desk only, deliberately. There is no ofs-masters here and there never should
 * be: masters, exchange files, settings, circulars and the audit trail are the
 * desk's, and an AP holding the module grant would have the whole of it.
 */
router.get('/me', async (req, res, next) => {
  try {
    const who = whoAmI(req);
    const scope = who.kind === 'client' ? [who.ucc] : await scopeUccs(req);
    res.json({
      actor: who,
      client_count: scope.length,
      user: { id: who.branch_code || who.ucc, email: req.portal.loginEmail,
              role: who.label, name: who.branch_name || null },
      // ofs-desk at view level: an AP places bids, and every write they make is
      // gated by the client's own one-time code rather than by a page grant.
      permissions: { pages: ['ofs-desk'], actions: [] }
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ MIS: dashboard --
 * The desk's dashboard, scoped to one branch's clients.
 *
 * Deliberately the SAME response shape as /api/dashboard, because the back-office
 * screen is the screen an AP gets: one renderer, one set of figures, one place to
 * fix a rounding bug. What differs is the WHERE clause, and it is applied once here
 * rather than trusted to the page.
 *
 * Every bid figure counts bids on this branch's clients whoever placed them - the
 * branch itself, the back office, or the client signing in and bidding for
 * themselves. An AP asking "how much has my book applied for" is not asking "how
 * much did I type in".
 */
router.get('/me/dashboard', async (req, res, next) => {
  try {
    const now = new Date();
    const s = await settings.all();
    const scope = await scopeUccs(req);
    const market = marketState(s, now);

    // as_on: one IST day, or the whole live book. Same contract as the desk's.
    const asOn = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.as_on || '')) ? String(req.query.as_on) : null;
    const all = String(req.query.scope || '') === 'all';
    const dayClause = (alias, params) => {
      if (all) return '';
      if (!asOn) {
        return ` AND (${alias}.created_at AT TIME ZONE 'Asia/Kolkata')::date`
             + ` = (now() AT TIME ZONE 'Asia/Kolkata')::date`;
      }
      params.push(asOn);
      return ` AND (${alias}.created_at AT TIME ZONE 'Asia/Kolkata')::date = $${params.length}::date`;
    };

    const empty = {
      server_time: now.toISOString(), scope: all ? 'all' : (asOn || 'today'), as_on: asOn,
      actor: whoAmI(req), settings: s,
      market: { open: market.open, reason: market.reason, opens: market.opens,
                closes: market.closes, effective_close: market.effectiveClose,
                cutoff_applies: market.cutoffApplies, minutes_left: market.minutesLeft,
                message: market.open ? null : closedMessage(market) },
      issues: [], totals: { bids: 0, qty: 0, value: 0, clients: 0 },
      all_live: { bids: 0, value: 0 }, recent: []
    };
    if (!scope.length) return res.json(empty);

    /* Issues, with this branch's own numbers on them. A LEFT JOIN so an issue with
     * no bids from this branch still appears - "nothing applied yet" is a fact the
     * screen has to be able to show, and an inner join would hide it. */
    const iParams = [scope];
    const iDay = dayClause('b', iParams);
    const issues = await rows(
      `SELECT i.*,
              COALESCE(x.bids, 0)      AS bid_count,
              COALESCE(x.clients, 0)   AS client_count,
              COALESCE(x.qty, 0)       AS total_qty,
              COALESCE(x.value, 0)     AS total_value,
              COALESCE(x.ret_value, 0) AS ret_value,
              COALESCE(x.hni_value, 0) AS hni_value,
              COALESCE(x.ret_qty, 0)   AS ret_qty,
              COALESCE(x.hni_qty, 0)   AS hni_qty,
              x.vwap
         FROM ${SCHEMA}.ofs_issue i
         LEFT JOIN (
           SELECT b.issue_id,
                  count(*)::int                        AS bids,
                  count(DISTINCT b.client_ucc)::int    AS clients,
                  sum(b.qty)                           AS qty,
                  sum(b.value)                         AS value,
                  sum(b.value) FILTER (WHERE b.category = 'Retail') AS ret_value,
                  sum(b.value) FILTER (WHERE b.category = 'HNI')    AS hni_value,
                  sum(b.qty)   FILTER (WHERE b.category = 'Retail') AS ret_qty,
                  sum(b.qty)   FILTER (WHERE b.category = 'HNI')    AS hni_qty,
                  CASE WHEN sum(b.qty) FILTER (WHERE NOT b.is_cutoff) > 0
                       THEN sum(b.qty * b.price) FILTER (WHERE NOT b.is_cutoff)
                          / sum(b.qty) FILTER (WHERE NOT b.is_cutoff) END AS vwap
             FROM ${SCHEMA}.ofs_bid b
            WHERE b.client_ucc = ANY($1) AND b.status = 'Live'${iDay}
            GROUP BY b.issue_id
         ) x ON x.issue_id = i.id
        WHERE i.archived_at IS NULL
        ORDER BY i.id DESC`, iParams);

    const onDay = all || !asOn ? null : asOn;
    const list = issues.map((i) => {
      const issueQty = Number(i.issue_qty) || 0;
      const retQty = Number(i.retail_qty) || 0;
      return Object.assign({}, i, {
        status_label: issueStatus(i, now),
        hni_status: catStatus(i, 'HNI', now),
        ret_status: catStatus(i, 'Retail', now),
        open_on_scope: onDay ? issueOpenOnDay(i, onDay) : null,
        ret_open_on_scope: onDay ? openOnDay(i, 'Retail', onDay) : null,
        hni_open_on_scope: onDay ? openOnDay(i, 'HNI', onDay) : null,
        min_price_retail: minPrice(i, 'Retail'),
        min_price_hni: minPrice(i, 'HNI'),
        // Subscription is against the WHOLE issue, not against this branch, so it
        // stays meaningless here and is sent as null rather than as a fraction of a
        // number nobody asked about.
        subscription_x: null,
        ret_subscription_x: null,
        hni_subscription_x: null,
        our_vwap: i.vwap == null ? null : Number(i.vwap)
      });
    });

    const tParams = [scope];
    const tDay = dayClause('ofs_bid', tParams);
    const totals = await one(
      `SELECT count(*)::int AS bids, COALESCE(sum(qty),0)::bigint AS qty,
              COALESCE(sum(value),0) AS value, count(DISTINCT client_ucc)::int AS clients
         FROM ${SCHEMA}.ofs_bid
        WHERE client_ucc = ANY($1) AND status = 'Live'${tDay}`, tParams);

    const allLive = await one(
      `SELECT count(*)::int AS bids, COALESCE(sum(value),0) AS value
         FROM ${SCHEMA}.ofs_bid WHERE client_ucc = ANY($1) AND status = 'Live'`, [scope]);

    const rParams = [scope];
    const rDay = dayClause('b', rParams);
    const recent = await rows(
      `SELECT b.id, b.ref, b.client_ucc, b.branch_code, b.placed_by, b.category, b.qty,
              b.price, b.is_cutoff, b.value, b.status, b.created_at, i.symbol
         FROM ${SCHEMA}.ofs_bid b
         LEFT JOIN ${SCHEMA}.ofs_issue i ON i.id = b.issue_id
        WHERE b.client_ucc = ANY($1)${rDay}
        ORDER BY b.created_at DESC LIMIT 15`, rParams);

    res.json(Object.assign({}, empty, {
      issues: list,
      totals: {
        bids: (totals && totals.bids) || 0,
        qty: Number((totals && totals.qty) || 0),
        value: Number((totals && totals.value) || 0),
        clients: (totals && totals.clients) || 0
      },
      all_live: { bids: (allLive && allLive.bids) || 0, value: Number((allLive && allLive.value) || 0) },
      recent: maskPortalRows(req, await ld.enrich(recent, 'client_ucc'))
    }));
  } catch (e) { next(e); }
});

module.exports = router;
