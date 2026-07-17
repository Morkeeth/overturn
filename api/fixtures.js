// GET /api/fixtures
//
// The World Cup fixtures TxLINE knows about, split into played and upcoming. Used by the
// market page to show what the escrow could be pointed at next, and to prove the feed is
// live rather than a screenshot of last week.

import { txline, json } from './_txline.js';

const EPOCH_DAY = 20648; // 2026-07-14, the semi-final. The snapshot returns the window around it.

export default async function handler(req, res) {
  try {
    const r = await txline(`/api/fixtures/snapshot?startEpochDay=${EPOCH_DAY}`);
    if (!r.ok) return json(res, 502, { error: `TxLINE fixtures ${r.status}` });

    const all = await r.json();
    const now = Date.now();

    const cup = (Array.isArray(all) ? all : [])
      .filter((f) => f.Competition === 'World Cup')
      .map((f) => ({
        fixtureId: f.FixtureId,
        home: f.Participant1,
        away: f.Participant2,
        startTime: f.StartTime,
        kickoff: new Date(f.StartTime).toISOString(),
        // GameState 3 is finished. Anything else has not produced a final proof yet.
        finished: f.GameState === 3,
        upcoming: f.StartTime > now,
      }))
      .sort((a, b) => a.startTime - b.startTime);

    return json(res, 200, { asOf: new Date().toISOString(), fixtures: cup }, 60);
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
}
