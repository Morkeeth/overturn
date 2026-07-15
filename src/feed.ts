// TxLINE scores feed: types + parsing.
//
// Two things about this feed are not in the docs and are load-bearing here:
//   1. /api/scores/historical/{id} returns SSE framing ("data: {...}"), NOT a JSON array.
//   2. Events are published PROVISIONALLY (Confirmed:false), then either confirmed
//      (Confirmed:true) or silently retracted (action_discarded), and the Score payload
//      moves in BOTH directions. See data/replay-18237038-scores.sse @ 20:22:29.

/** A single score-feed record, as published. Note: PascalCase (odds/fixtures match; /scores/snapshot does not). */
export interface ScoreEvent {
  FixtureId: number;
  Action: string;
  /** undefined on lifecycle records (action_discarded, game_finalised) that carry no confirmation. */
  Confirmed?: boolean;
  Seq: number;
  Ts: number;
  StatusId?: number;
  Score?: ScorePayload;
}

export interface ScorePayload {
  Participant1?: ParticipantStats;
  Participant2?: ParticipantStats;
}

/** Keyed by period: H1 | HT | H2 | Total | ... Only `Total` is the settled figure. */
export type ParticipantStats = Record<string, PeriodStats | undefined>;

export interface PeriodStats {
  Goals?: number;
  YellowCards?: number;
  RedCards?: number;
  Corners?: number;
}

/** Actions that mean a previously published event is being withdrawn. */
export const RETRACTION_ACTIONS = new Set(['action_discarded']);
/** Actions that open/close a VAR review window. While open, nothing is trustworthy. */
export const VAR_OPEN_ACTIONS = new Set(['var']);
export const VAR_CLOSE_ACTIONS = new Set(['var_end']);
/** The only record that means the result is final. StatusId 100. */
export const FINAL_ACTION = 'game_finalised';

/** Parse the SSE framing TxLINE actually returns from /api/scores/historical/{fixtureId}. */
export function parseSse(raw: string): ScoreEvent[] {
  const out: ScoreEvent[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    try {
      out.push(JSON.parse(t.slice(5).trim()) as ScoreEvent);
    } catch {
      // heartbeats and malformed frames are expected; skip rather than throw.
    }
  }
  return out.sort((a, b) => a.Seq - b.Seq);
}

/** Read a stat from a Score payload. `Total` is the only period that settles a full-match prop. */
export function readStat(
  score: ScorePayload | undefined,
  participant: 'Participant1' | 'Participant2',
  stat: keyof PeriodStats,
  period = 'Total',
): number {
  return score?.[participant]?.[period]?.[stat] ?? 0;
}

export const fmt = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
