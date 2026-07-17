// GET /api/markets
//
// The live betting board. Reads each pinned prop off devnet and each fixture off TxLINE, and
// returns markets a visitor can actually take a side of, with the bet stated in plain English.

import { txline, json } from './_txline.js';
import { BOARD, DEVNET_RPCS, STATES, decodeProp, rpc, describe } from './_board.js';

export default async function handler(req, res) {
  try {
    // Fixtures once, for team names and kickoff times.
    const fr = await txline(`/api/fixtures/snapshot?startEpochDay=20648`);
    const fixtures = fr.ok ? await fr.json() : [];
    const byId = {};
    for (const f of Array.isArray(fixtures) ? fixtures : []) {
      byId[f.FixtureId] = { home: f.Participant1, away: f.Participant2, startTime: f.StartTime, finished: f.GameState === 3 };
    }

    const markets = await Promise.all(BOARD.map(async (addr) => {
      try {
        const acc = await rpc(DEVNET_RPCS, 'getAccountInfo', [addr, { encoding: 'base64', commitment: 'confirmed' }]);
        if (!acc?.value) return null;
        const p = decodeProp(Buffer.from(acc.value.data[0], 'base64'));
        const fx = byId[p.fixtureId] || { home: 'Home', away: 'Away', startTime: p.settleAfter * 1000, finished: false };
        const { yes, takerBet, team } = describe(p, fx.home, fx.away);
        return {
          prop: addr,
          fixtureId: p.fixtureId,
          home: fx.home,
          away: fx.away,
          kickoff: fx.startTime,
          state: STATES[p.state] ?? 'Unknown',
          stakeSol: p.stake / 1e9,
          potSol: (p.stake * 2) / 1e9,
          yes,            // what the maker is holding
          takerBet,       // what you would be backing
          team,
          settleAfter: p.settleAfter,
          yesWon: p.yesWon,
        };
      } catch { return null; }
    }));

    return json(res, 200, { asOf: new Date().toISOString(), markets: markets.filter(Boolean) }, 8);
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
}
