// GET /api/feed?fixtureId=18237038
//
// The live TxLINE score feed for one fixture, read server-side with our subscription and
// handed to the browser without the token. This is the part a static page cannot do.
//
// It deliberately reports both numbers: what the feed asserts RIGHT NOW (which may be
// provisional and may be withdrawn) and what has actually been confirmed. The gap between
// those two is the entire product.

import { txline, parseSSE, json } from './_txline.js';

const GOALS_HOME = '1';
const GOALS_AWAY = '2';

export default async function handler(req, res) {
  const fixtureId = Number(req.query.fixtureId);
  if (!Number.isFinite(fixtureId)) return json(res, 400, { error: 'fixtureId required' });

  try {
    const r = await txline(`/api/scores/historical/${fixtureId}`);
    if (!r.ok) return json(res, 502, { error: `TxLINE scores ${r.status}` });

    const events = parseSSE(await r.text());
    if (!events.length) return json(res, 200, { fixtureId, events: 0, note: 'no events yet' }, 15);

    const scored = events.filter((e) => e.Stats);
    const last = scored[scored.length - 1];
    const finalised = events.filter((e) => e.Action === 'game_finalised').pop();

    // The last event whose goal was actually confirmed, ignoring anything still provisional.
    const confirmed = scored.filter((e) => e.Confirmed !== false).pop();

    const scoreOf = (e) => (e && e.Stats ? { home: e.Stats[GOALS_HOME] ?? 0, away: e.Stats[GOALS_AWAY] ?? 0 } : null);

    return json(
      res,
      200,
      {
        fixtureId,
        asOf: new Date().toISOString(),
        events: events.length,
        lastSeq: last?.Seq ?? null,
        lastUpdate: last ? new Date(last.Ts).toISOString() : null,
        // What the stream says at this instant. Not necessarily true yet.
        asserted: scoreOf(last),
        assertedProvisional: last?.Confirmed === false,
        // What has survived confirmation.
        confirmed: scoreOf(confirmed),
        finalised: !!finalised,
        finalisedAt: finalised ? new Date(finalised.Ts).toISOString() : null,
        finalScore: finalised ? scoreOf(finalised) : null,
        // A live match has an open VAR review only while one is running.
        varOpen: events.filter((e) => String(e.Action || '').includes('var_review')).slice(-1)[0]?.Action === 'var_review_opened',
      },
      15,
    );
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
}
