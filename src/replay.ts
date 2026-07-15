// Replay: run a real World Cup semi-final through a naive settler and the guarded gate.
//
// Data: TxLINE /api/scores/historical/18237038 (France v Spain, 2026-07-14), captured live.
// This is the eval. If the naive settler does not pay out on the phantom goal, there is no
// product and we should know that before building the escrow around it.

import { readFileSync } from 'node:fs';
import { fmt, parseSse } from './feed.js';
import { evaluate, guardedSettle, naiveSettle, type Predicate } from './gate.js';

const events = parseSse(readFileSync('data/replay-18237038-scores.sse', 'utf8'));

// "Spain to score 3 or more" == an over-2.5 prop on Participant2 goals.
// Chosen because the phantom goal at 20:22:29 crosses exactly this threshold.
const PROP: Predicate = {
  a: { participant: 'Participant2', stat: 'Goals', period: 'Total' },
  cmp: '>',
  value: 2,
  label: 'Spain total goals > 2',
};

console.log('='.repeat(78));
console.log('  REPLAY: France v Spain, World Cup semi-final, 2026-07-14');
console.log(`  PROP:   "${PROP.label}"   (a real market shape: over 2.5 goals)`);
console.log(`  EVENTS: ${events.length} from the live TxLINE feed`);
console.log('='.repeat(78));

// --- what the docs tell you to build -----------------------------------------
const naive = naiveSettle(events, PROP);
console.log('\n[ NAIVE SETTLER ]  "trigger resolution off the SSE stream"');
if (naive) {
  console.log(`  ${fmt(naive.ts)}  seq ${naive.seq}  ${naive.state}`);
  console.log(`             ${naive.reason}`);
} else {
  console.log('  never settled');
}

// --- what we build ------------------------------------------------------------
const guarded = guardedSettle(events, PROP);
console.log('\n[ GUARDED GATE ]  stream for the UI, proof for the money');
for (const d of guarded.decisions) {
  console.log(`  ${fmt(d.ts)}  seq ${String(d.seq).padStart(4)}  ${d.state.padEnd(11)} ${d.reason}`);
}

// --- ground truth -------------------------------------------------------------
const final = events.find((e) => e.Action === 'game_finalised');
const truth = evaluate(PROP, final?.Score);
console.log('\n[ GROUND TRUTH ]');
console.log(`  ${fmt(final!.Ts)}  game_finalised  ->  "${PROP.label}" = ${truth ? 'TRUE' : 'FALSE'}`);
console.log(`  Spain final goals: ${final?.Score?.Participant2?.Total?.Goals}`);

console.log('\n' + '='.repeat(78));
const naivePaid = naive?.state === 'SETTLED';
const naiveWrong = naivePaid && !truth;
console.log(`  NAIVE   : ${naivePaid ? `PAID OUT at ${fmt(naive!.ts)}` : 'held'}  ->  ${naiveWrong ? 'WRONG. Funds gone, irreversibly.' : 'correct'}`);
console.log(`  GUARDED : ${guarded.state}  ->  ${(guarded.state === 'SETTLED') === truth ? 'CORRECT' : 'WRONG'}`);
console.log('='.repeat(78));

process.exit(naiveWrong && guarded.state !== 'SETTLED' ? 0 : 1);
