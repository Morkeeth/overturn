// Live: watch tonight's World Cup semi-final through the gate, in real time.
//
//   England v Argentina, fixture 18241006, kickoff 2026-07-15 19:00:00 UTC.
//
// Two jobs:
//   1. Prove the gate works on a match nobody has seen yet (the Jul 14 replay is history;
//      this is not). Every decision is printed as it happens and persisted for the video.
//   2. Capture the raw SSE stream to disk. The scores/historical endpoint only serves a
//      two-week-to-six-hour window, so by judging time this match's history will have aged
//      out. If we don't record it now, the demo silently empties.
//
// Service level 12 (verified free + real-time on-chain), so this is the live feed, not the
// 60-second-delayed one.

import { appendFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fmt, type ScoreEvent } from './feed.js';
import { evaluate, type Predicate, type GateState } from './gate.js';

const API = 'https://txline.txodds.com';
const FIXTURE = Number(process.env.FIXTURE ?? 18241006);
const RAW = `data/live-${FIXTURE}-scores.sse`;

const kc = (s: string) =>
  execFileSync('security', ['find-generic-password', '-a', 'worldcup-agent', '-s', s, '-w'], { encoding: 'utf8' }).trim();

// Props we track live. Chosen so at least one is likely to be decided tonight.
const PROPS: Predicate[] = [
  { a: { participant: 'Participant1', stat: 'Goals' }, cmp: '>', value: 0, label: 'England score at all' },
  { a: { participant: 'Participant2', stat: 'Goals' }, cmp: '>', value: 0, label: 'Argentina score at all' },
  {
    a: { participant: 'Participant1', stat: 'Goals' },
    op: '+',
    b: { participant: 'Participant2', stat: 'Goals' },
    cmp: '>',
    value: 2,
    label: 'total goals > 2 (over 2.5)',
  },
  { a: { participant: 'Participant1', stat: 'Corners' }, op: '+', b: { participant: 'Participant2', stat: 'Corners' }, cmp: '>', value: 9, label: 'total corners > 9' },
];

const state = new Map<string, GateState>(PROPS.map((p) => [p.label, 'PENDING']));
let varOpen = false;
let lastScore: any;
let events = 0;

writeFileSync(RAW, '');
console.log(`watching fixture ${FIXTURE} on the live SSE stream (service level 12)`);
console.log(`raw capture -> ${RAW}`);
console.log('-'.repeat(90));

const note = (ts: number, tag: string, msg: string) => {
  const line = `${fmt(ts)}  ${tag.padEnd(12)} ${msg}`;
  console.log(line);
  appendFileSync('data/live-decisions.log', line + '\n');
};

const res = await fetch(`${API}/api/scores/stream`, {
  headers: {
    Authorization: `Bearer ${kc('WC_JWT')}`,
    'X-Api-Token': kc('WC_API_TOKEN'),
    Accept: 'text/event-stream',
  },
});
if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status} ${await res.text()}`);

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';

for (;;) {
  const { done, value } = await reader.read();
  if (done) {
    console.log('\nstream closed by server');
    break;
  }
  buf += dec.decode(value, { stream: true });
  const frames = buf.split('\n');
  buf = frames.pop() ?? '';

  for (const raw of frames) {
    const t = raw.trim();
    if (!t.startsWith('data:')) continue;
    let e: ScoreEvent;
    try {
      e = JSON.parse(t.slice(5).trim());
    } catch {
      continue; // heartbeat or partial frame
    }
    if (e.FixtureId !== FIXTURE) continue;

    appendFileSync(RAW, raw + '\n'); // record everything for this fixture, verbatim
    events++;
    if (e.Score) lastScore = e.Score;

    // Mirror the gate's rules, live. Same authority order as gate.ts.
    if (e.Action === 'var') {
      if (!varOpen) { varOpen = true; note(e.Ts, 'VAR-OPEN', 'review open -> gate BLOCKED, nothing may settle'); }
      continue;
    }
    if (e.Action === 'var_end') { varOpen = false; note(e.Ts, 'VAR-CLOSED', 'review closed -> re-armed'); continue; }
    if (e.Action === 'action_discarded') {
      const held = [...state].filter(([, s]) => s === 'PROVISIONAL').map(([l]) => l);
      note(e.Ts, 'RETRACTION', held.length ? `event withdrawn. HELD (not paid): ${held.join(', ')}` : 'event withdrawn (nothing riding on it)');
      for (const [l, s] of state) if (s === 'PROVISIONAL') state.set(l, 'PENDING');
      continue;
    }
    if (e.Action === 'goal') {
      note(e.Ts, e.Confirmed === false ? 'GOAL?' : 'GOAL', e.Confirmed === false ? 'PROVISIONAL goal -> UI only, money HELD' : 'goal confirmed');
    }
    if (e.Action === 'game_finalised') {
      note(e.Ts, 'FINAL', 'game_finalised -> settlement now provable (root anchors ~90s from now)');
      for (const p of PROPS) note(e.Ts, 'RESULT', `${p.label} = ${evaluate(p, lastScore) ? 'TRUE' : 'FALSE'}`);
      console.log(`\ncaptured ${events} events -> ${RAW}`);
      break;
    }
    if (varOpen) continue;

    for (const p of PROPS) {
      const isTrue = evaluate(p, lastScore);
      const cur = state.get(p.label)!;
      if (isTrue && cur === 'PENDING') {
        state.set(p.label, 'PROVISIONAL');
        note(e.Ts, 'PROVISIONAL', `"${p.label}" now reads true -> money HELD until the final proof`);
      }
    }
  }
}
