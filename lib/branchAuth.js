'use strict';
/**
 * Who may sign in as a branch or an Authorised Partner, and what they may reach.
 *
 * No database import: the rules that decide access are the ones most worth being
 * able to test without a connection, and the ones most worth reading in one place
 * when someone asks at an audit "how does an AP get to a client's bid?".
 *
 * The chain, in order, all three required:
 *   1. LD says the branch exists, belongs to FIRMNUMBER ASK-000001, and ACTIVE='Y'
 *   2. the desk has not disabled it in ofs.ofs_branch_setting
 *   3. the address typed at sign-in is one of the addresses on that branch's own
 *      LD record — the code goes to the record, never to what was typed
 *
 * Step 2 can only ever subtract. There is deliberately no way to enable a branch LD
 * calls inactive: a closed AP staying closed must not depend on someone remembering
 * to remove a row here.
 */

/** The firm whose branches may sign in. */
const FIRM = () => String(process.env.OFS_BRANCH_FIRM || 'ASK-000001').trim();

/** branchho BRANCHTYPE 'AP' is an Authorised Partner; everything else is a branch. */
function actorTypeOf(branch) {
  return String((branch && branch.branch_type) || '').trim().toUpperCase() === 'AP' ? 'ap' : 'branch';
}

/** What goes in ofs_bid.placed_by for a bid this actor places. */
function placedByOf(actorType) {
  return actorType === 'ap' ? 'ap' : actorType === 'branch' ? 'branch' : 'client';
}

/** How the desk and the audit trail name this actor. */
function actorLabel(actorType) {
  return actorType === 'ap' ? 'Authorised Partner' : actorType === 'branch' ? 'Branch' : 'Client';
}

/**
 * May this branch sign in? Returns null when it may, or a reason code.
 * `blocked` is a Set of upper-case branch codes the desk has disabled.
 */
function loginBlock(branch, blocked) {
  if (!branch) return 'unknown_branch';
  if (String(branch.firm || '').trim() !== FIRM()) return 'wrong_firm';
  if (String(branch.active_flag || '').trim().toUpperCase() !== 'Y') return 'branch_inactive';
  if (blocked && blocked.has(String(branch.branch_code || '').trim().toUpperCase())) return 'login_disabled';
  return null;
}

/** Only the reasons safe to show. Anything else becomes the generic message. */
const BLOCK_MESSAGE = {
  unknown_branch: 'No active branch or Authorised Partner is registered against that email address.',
  wrong_firm: 'No active branch or Authorised Partner is registered against that email address.',
  branch_inactive: 'That branch is not active.',
  login_disabled: 'Sign-in has been disabled for that branch. Please contact the OFS desk.'
};

function blockMessage(reason) {
  return BLOCK_MESSAGE[reason] || 'Sign-in is not available for that account.';
}

/**
 * The branches an email may sign in as, after the desk's override is applied.
 * An address appearing against several branchcodes is normal — a regional
 * manager's does — so this returns a list and the caller asks which.
 */
function eligibleBranches(branches, blocked) {
  return (branches || []).filter((b) => loginBlock(b, blocked) === null);
}

/**
 * Can this actor see this bid? The rule the bid book, the exports and every
 * client-facing list must agree on.
 *
 *   desk    — everything
 *   ap/branch — every bid for a client of that branch, INCLUDING bids the client
 *               placed themselves. An AP who cannot see what their own client did
 *               cannot advise them, and would place a duplicate.
 *   client  — their own bids only
 */
function canSeeBid(actor, bid) {
  if (!actor) return false;
  if (actor.kind === 'desk') return true;
  if (actor.kind === 'client') {
    return String(bid.client_ucc || '').toUpperCase() === String(actor.ucc || '').toUpperCase();
  }
  if (actor.kind === 'ap' || actor.kind === 'branch') {
    const code = String(actor.branchCode || '').toUpperCase();
    if (!code) return false;                       // scoped to nothing is not scoped to everything
    const onBid = String(bid.branch_code || '').toUpperCase();
    if (onBid) return onBid === code;
    // Older bids predate the stamped branch, so fall back to the client's list.
    return Array.isArray(actor.uccs) &&
      actor.uccs.indexOf(String(bid.client_ucc || '').toUpperCase()) >= 0;
  }
  return false;
}

module.exports = { FIRM, actorTypeOf, placedByOf, actorLabel, loginBlock, blockMessage,
                   eligibleBranches, canSeeBid, BLOCK_MESSAGE };
