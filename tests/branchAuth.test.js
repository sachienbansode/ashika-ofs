'use strict';
/**
 * Who may sign in as a branch or AP, and what they may see.
 *
 * The access chain is three steps and all three are required: LD says the branch is
 * active and belongs to the firm, the desk has not disabled it, and the code goes to
 * the address on the LD record. These tests are what say so in one place when
 * someone asks at an audit how an AP reaches a client's bid.
 */
const test = require('node:test');
const assert = require('node:assert');
const ba = require('../lib/branchAuth');
const branches = require('../db/branchAdapter');

const AP    = { branch_code: 'RK67', branch_name: 'ASHISH PUJARI', firm: 'ASK-000001', active_flag: 'Y', branch_type: 'AP' };
const HO    = { branch_code: 'ONL2', branch_name: 'ONLINE CLIENTS', firm: 'ASK-000001', active_flag: 'Y', branch_type: 'SELF' };
const DEAD  = { branch_code: 'W171', branch_name: 'SANTOSH MONDAL', firm: 'ASK-000001', active_flag: 'N', branch_type: 'AP' };
const OTHER = { branch_code: 'X001', branch_name: 'OTHER FIRM',    firm: 'ASK-000002', active_flag: 'Y', branch_type: 'AP' };

test('an active branch of the firm may sign in; AP and non-AP alike', () => {
  assert.equal(ba.loginBlock(AP, new Set()), null);
  assert.equal(ba.loginBlock(HO, new Set()), null);
});

test('LD ACTIVE = N is refused, and so is another firm', () => {
  assert.equal(ba.loginBlock(DEAD, new Set()), 'branch_inactive');
  assert.equal(ba.loginBlock(OTHER, new Set()), 'wrong_firm');
});

test("the desk's override can take login away from an active branch", () => {
  assert.equal(ba.loginBlock(AP, new Set(['RK67'])), 'login_disabled');
});

test('the override can never grant login to an inactive branch', () => {
  // There is no "enable" path on purpose: a closed AP staying closed must not
  // depend on anyone remembering to remove a row.
  assert.equal(ba.loginBlock(DEAD, new Set()), 'branch_inactive');
  assert.equal(ba.loginBlock(DEAD, new Set(['NOPE'])), 'branch_inactive');
});

test('an unknown branch is refused, not treated as absent-therefore-fine', () => {
  assert.equal(ba.loginBlock(null, new Set()), 'unknown_branch');
  assert.equal(ba.loginBlock(undefined, new Set()), 'unknown_branch');
});

test('every block reason has a sentence, and none leaks whether a branch exists', () => {
  for (const r of Object.keys(ba.BLOCK_MESSAGE)) assert.ok(ba.blockMessage(r).length > 10);
  assert.equal(ba.blockMessage('unknown_branch'), ba.blockMessage('wrong_firm'),
    'an address of another firm must look exactly like an unregistered one');
});

test('BRANCHTYPE decides AP vs branch, and what placed_by records', () => {
  assert.equal(ba.actorTypeOf(AP), 'ap');
  assert.equal(ba.actorTypeOf(HO), 'branch');
  assert.equal(ba.actorTypeOf({ branch_type: ' ap ' }), 'ap');     // Oracle CHAR padding
  assert.equal(ba.placedByOf('ap'), 'ap');
  assert.equal(ba.placedByOf('branch'), 'branch');
  assert.equal(ba.placedByOf('client'), 'client');
});

test('branchho EMAIL is free text: split it, and keep only real addresses', () => {
  assert.deepEqual(branches.emailsOf('se***@ashikagroup.com;'), ['se***@ashikagroup.com']);
  assert.deepEqual(branches.emailsOf('a@x.com; b@y.com'), ['a@x.com', 'b@y.com']);
  assert.deepEqual(branches.emailsOf('a@x.com,b@y.com'), ['a@x.com', 'b@y.com']);
  assert.deepEqual(branches.emailsOf('  MiXeD@Case.COM  ;'), ['mixed@case.com']);
  // The row in the sample data whose address is cut off mid-domain.
  assert.deepEqual(branches.emailsOf('santoshmondal.634@rediffmail.c'), ['santoshmondal.634@rediffmail.c']);
  assert.deepEqual(branches.emailsOf('not-an-address; ;'), []);
  assert.deepEqual(branches.emailsOf(null), []);
});

/* ------------------------------------------------------------------ visibility */
const deskActor   = { kind: 'desk' };
const clientActor = { kind: 'client', ucc: 'S247683' };
const apActor     = { kind: 'ap', branchCode: 'RK67', uccs: ['S247683', 'A136386'] };

test('a client sees their own bids and nobody else\'s', () => {
  assert.equal(ba.canSeeBid(clientActor, { client_ucc: 'S247683' }), true);
  assert.equal(ba.canSeeBid(clientActor, { client_ucc: 'A136386' }), false);
});

test("an AP sees their clients' bids INCLUDING ones the client placed themselves", () => {
  // The whole point of the request. An AP who cannot see what their own client did
  // will place a duplicate, which the exchange then rejects.
  assert.equal(ba.canSeeBid(apActor, { client_ucc: 'S247683', branch_code: 'RK67', placed_by: 'client' }), true);
  assert.equal(ba.canSeeBid(apActor, { client_ucc: 'S247683', branch_code: 'RK67', placed_by: 'ap' }), true);
  assert.equal(ba.canSeeBid(apActor, { client_ucc: 'Z999', branch_code: 'W170' }), false);
});

test('a bid placed before branch stamping falls back to the branch client list', () => {
  assert.equal(ba.canSeeBid(apActor, { client_ucc: 'S247683' }), true);
  assert.equal(ba.canSeeBid(apActor, { client_ucc: 'NOT-MINE' }), false);
});

test('a branch session with no branch code sees nothing, not everything', () => {
  const broken = { kind: 'ap', branchCode: '', uccs: ['S247683'] };
  assert.equal(ba.canSeeBid(broken, { client_ucc: 'S247683' }), false);
});

test('the desk sees everything, and an unknown actor sees nothing', () => {
  assert.equal(ba.canSeeBid(deskActor, { client_ucc: 'anything' }), true);
  assert.equal(ba.canSeeBid(null, { client_ucc: 'x' }), false);
  assert.equal(ba.canSeeBid({ kind: 'nonsense' }, { client_ucc: 'x' }), false);
});
