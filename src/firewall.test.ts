// Unit tests for the settlement firewall — the guard logic the escrow enforces on-chain.
//
// Pure and offline: no key, no network, no chain. Run with `npm test`. These encode, as
// executable assertions, the exact failure class the project exists to stop — a proof that is
// cryptographically valid but settles the wrong market, at the wrong moment, or the wrong
// question. The headline case (the 20:22:29 France-Spain phantom goal) is a named test below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firewall, type FrozenQuestion, type ProofClaim } from './firewall.js';

// Times taken from the real fixture. Final whistle 21:04:14 UTC = 1784063054 (see src/market.ts).
const WHISTLE = 1784063054;
const WHISTLE_MS = WHISTLE * 1000;
// The phantom goal was published at 20:22:29 and discarded at 20:22:55; its batch (20:21:18 ->
// 20:24:59) never reaches full time. 20:24:59 = whistle - 2355s.
const PHANTOM_BATCH_MAX_MS = (WHISTLE - 2355) * 1000;

// "Spain total goals > 2" on France v Spain, full time. The question frozen at market creation.
const FROZEN: FrozenQuestion = {
  subjectId: 18237038,
  statKey: 2,
  period: 100,
  threshold: 2,
  comparison: 'greaterThan',
  settleAfterMs: WHISTLE_MS,
  label: 'Spain total goals > 2',
};

const claim = (over: Partial<ProofClaim>): ProofClaim => ({
  source: 'test',
  subjectId: 18237038,
  statKey: 2,
  period: 100,
  batchMaxTimestampMs: WHISTLE_MS, // by default a valid, full-time batch
  label: 'claim',
  ...over,
});

test('admits the honest full-time proof for this exact market', () => {
  const r = firewall(claim({}), FROZEN);
  assert.equal(r.admit, true);
  assert.equal(r.refusedBy, null);
  assert.ok(r.verdicts.every((v) => v.pass));
});

test('GUARD 1 — refuses a valid proof from a different match', () => {
  const r = firewall(claim({ subjectId: 18241006 }), FROZEN); // England v Argentina
  assert.equal(r.admit, false);
  assert.match(r.refusedBy!, /subject binding/);
});

test('GUARD 2 — refuses the 20:22:29 phantom-goal batch (published, then VAR-reverted)', () => {
  // The phantom goal was a real feed event. Its batch never reaches full time, so even if a
  // proof existed it could not settle a full-match prop early. This is the headline case.
  const r = firewall(claim({ batchMaxTimestampMs: PHANTOM_BATCH_MAX_MS }), FROZEN);
  assert.equal(r.admit, false);
  assert.match(r.refusedBy!, /finality/);
});

test('GUARD 2 — refuses an honest half-time proof (batch before full time)', () => {
  const r = firewall(claim({ batchMaxTimestampMs: WHISTLE_MS - 1 }), FROZEN);
  assert.equal(r.admit, false);
  assert.match(r.refusedBy!, /finality/);
});

test('GUARD 2 — admits exactly at the finality bar (boundary)', () => {
  const r = firewall(claim({ batchMaxTimestampMs: WHISTLE_MS }), FROZEN);
  assert.equal(r.admit, true);
});

test('GUARD 3 — refuses a proof for a different period (in-play, not full time)', () => {
  const r = firewall(claim({ period: 3 }), FROZEN);
  assert.equal(r.admit, false);
  assert.match(r.refusedBy!, /stat\/predicate binding/);
});

test('GUARD 3 — refuses a proof for a different stat key', () => {
  const r = firewall(claim({ statKey: 7 }), FROZEN); // corners, not goals
  assert.equal(r.admit, false);
  assert.match(r.refusedBy!, /stat\/predicate binding/);
});

test('every verdict carries a human-readable reason (the refusal is the product)', () => {
  const r = firewall(claim({ subjectId: 999 }), FROZEN);
  assert.ok(r.verdicts.every((v) => typeof v.detail === 'string' && v.detail.length > 0));
});
