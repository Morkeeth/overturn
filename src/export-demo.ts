// Bake the demo's data into a static JSON.
//
// Hard requirement (hackathon T&C §5): judges must be able to review the submission
// "without incurring any fee, charge or expense" and TxODDS "shall not be required to ...
// establish any blockchain wallet". TxLINE's free tier needs an on-chain subscribe tx, so a
// judge cannot fetch this data themselves. Therefore we fetch it once, with our subscription,
// and ship the result. The page they open needs no wallet, no key, no install.
//
// Second reason this file exists: /api/scores/historical only serves a two-week window.
// The Jul 14 semi-final ages out ~Jul 28. Judging is Jul 29. If we don't freeze it now, the
// demo is empty on the day it's marked.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseSse, readStat, type ScoreEvent } from './feed.js';
import { evaluate, guardedSettle, naiveSettle, type Predicate } from './gate.js';

const events = parseSse(readFileSync('data/replay-18237038-scores.sse', 'utf8'));

const PROP: Predicate = {
  a: { participant: 'Participant2', stat: 'Goals', period: 'Total' },
  cmp: '>',
  value: 2,
  label: 'Spain total goals > 2',
};

const KEY_ACTIONS = new Set(['goal', 'var', 'var_end', 'action_discarded', 'game_finalised']);

// Not every record carries a full Score. The `var` records in particular ship a Score object
// with no Goals key at all, so reading them naively yields 0-0 and makes it look like the
// scoreline collapsed mid-review. Carry the last complete score forward; only move it when a
// record actually asserts one. (The phantom's revert IS such an assertion, so it still shows.)
const hasScore = (e: ScoreEvent) =>
  e.Score?.Participant1?.Total !== undefined || e.Score?.Participant2?.Total !== undefined;

// Single pass. filter().map() would be wrong here: filter runs to completion first, so every
// inherited row would receive the FINAL score instead of the score standing at its own moment.
// During the VAR review the feed's live state was 0-3 (the phantom still standing) — showing
// 0-2 there would quietly rewrite the story we are telling.
let carried: ScoreEvent['Score'];
const timeline: any[] = [];
for (const e of events) {
  const inherited = !hasScore(e);
  if (!inherited) carried = e.Score;
  if (!KEY_ACTIONS.has(e.Action)) continue;
  const score = inherited ? carried : e.Score;
  timeline.push({
    ts: e.Ts,
    time: new Date(e.Ts).toISOString().slice(11, 19),
    action: e.Action,
    confirmed: e.Confirmed ?? null,
    seq: e.Seq,
    scoreCarried: inherited, // honest: this row inherited its score, it did not assert one
    spain: readStat(score, 'Participant2', 'Goals'),
    france: readStat(score, 'Participant1', 'Goals'),
    propTrue: evaluate(PROP, score),
  });
}

const naive = naiveSettle(events, PROP);
const guarded = guardedSettle(events, PROP);
const final = events.find((e) => e.Action === 'game_finalised')!;

const out = {
  generatedFrom: 'TxLINE /api/scores/historical/18237038 (captured live 2026-07-15)',
  fixture: { id: 18237038, name: 'France v Spain', stage: 'World Cup semi-final', date: '2026-07-14' },
  prop: { label: PROP.label, market: 'over 2.5 Spain goals', statKey: 2, period: 100, threshold: 2 },
  eventCount: events.length,
  timeline,
  phantom: {
    // The 26 seconds the feed asserted a scoreline that never existed.
    publishedAt: '20:22:29',
    discardedAt: '20:22:55',
    durationSeconds: 26,
    scoreDuring: '0-3',
    scoreActual: '0-2',
  },
  naive: naive && { time: new Date(naive.ts).toISOString().slice(11, 19), state: naive.state, reason: naive.reason },
  guarded: {
    state: guarded.state,
    decisions: guarded.decisions.map((d) => ({ time: new Date(d.ts).toISOString().slice(11, 19), state: d.state, reason: d.reason })),
  },
  truth: {
    finalisedAt: new Date(final.Ts).toISOString().slice(11, 19),
    spainGoals: readStat(final.Score, 'Participant2', 'Goals'),
    franceGoals: readStat(final.Score, 'Participant1', 'Goals'),
    propTrue: evaluate(PROP, final.Score),
  },
  // Verified against the real programs on 2026-07-15. See src/verify.ts to reproduce.
  onchain: {
    mainnetOracle: '9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA',
    devnetOracle: '6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J',
    scoresRoot: 'CA9P9cpaaHLML54f7HpDjJPtknyTAbaKs8uaoZruuAfs',
    epochDay: 20648,
    anchoringLagMinutes: 1.4,
    verdicts: [
      { question: 'Spain goals > 2  (the phantom 3rd goal)', answer: false },
      { question: 'Spain goals > 1  (control: they scored 2)', answer: true },
    ],
  },
  guards: [
    { n: 1, name: 'Fixture binding', blocks: 'a valid proof from a different match', error: 'FixtureMismatch' },
    { n: 2, name: 'Finality', blocks: 'an honest half-time proof settling a full-match prop early', error: 'ProofNotFinal' },
    { n: 3, name: 'Predicate binding', blocks: 'the settler swapping the question to one they win', error: 'PredicateMismatch' },
  ],
};

writeFileSync('web/demo-data.json', JSON.stringify(out, null, 2));
console.log(`web/demo-data.json written: ${timeline.length} key events, ${events.length} total`);
console.log(`  naive   -> ${out.naive?.state} at ${out.naive?.time}`);
console.log(`  guarded -> ${out.guarded.state}`);
console.log(`  truth   -> Spain ${out.truth.spainGoals}, prop = ${out.truth.propTrue}`);
