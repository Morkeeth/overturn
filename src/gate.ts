// The settlement gate.
//
// The problem it exists to solve, observed in real World Cup data:
//   TxLINE's SSE stream published a Spain 3rd goal at 20:22:29 (Confirmed:false).
//   VAR reviewed it at 20:22:41 and it was retracted at 20:22:55. The final record
//   at 21:04:14 confirms Spain scored 2. For 26 seconds the stream said 0-3.
//
// The hackathon's own suggested architecture is to "use the SSE Stream to dynamically
// trigger prediction resolutions". Doing that pays out on a goal that never happened,
// irreversibly, because on-chain settlement cannot be undone.
//
// This gate is the difference between "the stream said so" and "the chain agrees".
// Stream drives the UI. Proof drives the money. Nothing reaches SETTLED without both.

import {
  FINAL_ACTION,
  RETRACTION_ACTIONS,
  VAR_CLOSE_ACTIONS,
  VAR_OPEN_ACTIONS,
  readStat,
  type PeriodStats,
  type ScoreEvent,
  type ScorePayload,
} from './feed.js';

/** Mirrors the on-chain `StatTerm` so a Predicate maps 1:1 onto the validate_stat CPI. */
export interface StatTerm {
  participant: 'Participant1' | 'Participant2';
  stat: keyof PeriodStats;
  period?: string;
}

/** Mirrors on-chain `stat_a [op stat_b] <cmp> value` (TraderPredicate + BinaryExpression). */
export interface Predicate {
  a: StatTerm;
  op?: '+' | '-';
  b?: StatTerm;
  cmp: '>' | '>=' | '<' | '<=' | '==';
  value: number;
  label: string;
}

export type GateState = 'PENDING' | 'PROVISIONAL' | 'SETTLED' | 'RETRACTED';

export interface Decision {
  ts: number;
  seq: number;
  state: GateState;
  /** Why the gate did what it did. This is the audit trail; the refusals are the product. */
  reason: string;
  predicateTrue: boolean;
}

/** Pure: evaluate a predicate against a score payload. No side effects, no clock, no network. */
export function evaluate(p: Predicate, score: ScorePayload | undefined): boolean {
  const av = readStat(score, p.a.participant, p.a.stat, p.a.period ?? 'Total');
  const bv = p.b ? readStat(score, p.b.participant, p.b.stat, p.b.period ?? 'Total') : 0;
  const lhs = p.op === '+' ? av + bv : p.op === '-' ? av - bv : av;
  switch (p.cmp) {
    case '>': return lhs > p.value;
    case '>=': return lhs >= p.value;
    case '<': return lhs < p.value;
    case '<=': return lhs <= p.value;
    case '==': return lhs === p.value;
  }
}

/**
 * NAIVE settler: exactly what the docs steer you toward. Trigger resolution off the
 * stream the moment the predicate reads true. Included so the replay can show what
 * every unguarded escrow in this field would do.
 */
export function naiveSettle(events: ScoreEvent[], p: Predicate): Decision | null {
  for (const e of events) {
    if (!e.Score) continue;
    if (evaluate(p, e.Score)) {
      return {
        ts: e.Ts, seq: e.Seq, state: 'SETTLED', predicateTrue: true,
        reason: `stream says "${p.label}" is true (action=${e.Action}) -> PAY OUT`,
      };
    }
  }
  return null;
}

export interface GateResult {
  state: GateState;
  decisions: Decision[];
  settledAt: number | null;
  finalPredicateTrue: boolean;
}

/**
 * GUARDED settler. Rules, in order of authority:
 *   1. While a VAR review is open, nothing may promote. The feed is explicitly in doubt.
 *   2. A provisional event (Confirmed:false) may light the UI but may never move money.
 *   3. A retraction (action_discarded) demotes any provisional state and re-reads the score,
 *      because the Score payload itself reverts.
 *   4. Only `game_finalised` (StatusId 100) makes a full-match prop final. That record holds
 *      "regardless of whether the match ended after regulation, extra time, penalties or
 *      abandonment", so it is the one honest settlement trigger.
 *   5. `requireProof` gates the final promotion on the Merkle proof verifying on-chain.
 *      The proof is batch-scoped and lags the stream by minutes; that latency is the price
 *      of being right, and it is why this is a state machine and not an if-statement.
 */
export function guardedSettle(
  events: ScoreEvent[],
  p: Predicate,
  opts: { requireProof?: (e: ScoreEvent) => boolean } = {},
): GateResult {
  let state: GateState = 'PENDING';
  let varOpen = false;
  const decisions: Decision[] = [];
  let settledAt: number | null = null;
  let lastScore: ScorePayload | undefined;

  const log = (e: ScoreEvent, s: GateState, reason: string, predicateTrue: boolean) => {
    state = s;
    decisions.push({ ts: e.Ts, seq: e.Seq, state: s, reason, predicateTrue });
  };

  for (const e of events) {
    if (e.Score) lastScore = e.Score;
    const isTrue = evaluate(p, lastScore);

    if (VAR_OPEN_ACTIONS.has(e.Action)) {
      // Blocking must NOT demote: a provisional claim stays provisional through the review,
      // otherwise the retraction that follows has nothing to cancel and the save goes unrecorded.
      if (!varOpen) varOpen = true;
      else continue; // the feed emits `var` twice (unconfirmed then confirmed); log once.
      log(e, state, 'VAR review OPEN -> gate BLOCKED, no promotion possible', isTrue);
      continue;
    }
    if (VAR_CLOSE_ACTIONS.has(e.Action)) {
      varOpen = false;
      log(e, state, 'VAR review closed -> gate re-armed (awaiting the corrected score)', isTrue);
      continue;
    }
    if (RETRACTION_ACTIONS.has(e.Action)) {
      if (state === 'PROVISIONAL') {
        log(e, 'RETRACTED', `RETRACTION: the event backing "${p.label}" was withdrawn. Score reverts. No payout.`, isTrue);
      }
      // A retraction with nothing provisional riding on it is routine feed hygiene, not a decision.
      continue;
    }

    if (varOpen) continue; // rule 1: authority over everything below.

    if (isTrue && state !== 'SETTLED') {
      if (e.Confirmed === false) {
        log(e, 'PROVISIONAL', `"${p.label}" reads true but event is PROVISIONAL (Confirmed:false) -> UI only, money HELD`, true);
        continue;
      }
      if (e.Action === FINAL_ACTION || e.StatusId === 100) {
        if (opts.requireProof && !opts.requireProof(e)) {
          log(e, 'PROVISIONAL', 'final whistle, but Merkle proof not yet verifiable on-chain -> money HELD', true);
          continue;
        }
        settledAt = e.Ts;
        log(e, 'SETTLED', `game_finalised + proof verified -> "${p.label}" TRUE. Release funds.`, true);
        continue;
      }
      log(e, 'PROVISIONAL', `"${p.label}" true and confirmed, but match is live; a goal can still be VAR'd off -> money HELD`, true);
    }

    if (e.Action === FINAL_ACTION || e.StatusId === 100) {
      if (!isTrue) {
        log(e, 'RETRACTED', `game_finalised -> "${p.label}" is FALSE on the final record. Refund.`, false);
      }
    }
  }

  return { state, decisions, settledAt, finalPredicateTrue: evaluate(p, lastScore) };
}
