// The watcher. Sits on the open prop, follows the live feed, and settles the moment the
// match is actually over.
//
//   npm run market:watch
//
// This is the part that makes it a market rather than a replay. Every other run in this repo
// settles a match whose result was already known. Point this at a fixture that has not been
// played and the outcome is genuinely unknown at the time the money goes in.
//
// It settles on `game_finalised`, not on a clock and not on the scoreline looking right. That
// is the whole thesis applied to our own tooling: the feed asserting a scoreline is not the
// match being over, and we refuse to act on the assertion.

import { PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import {
  connect, maker, taker, ORACLE, fetchProof, toPayload, strategyFor, dailyScoresPda,
  loadMarket, explorerTx, history, line, rule, sol,
} from './market.js';

const POLL_MS = Number(process.env.POLL_MS ?? 20_000);
const mkt = loadMarket();
const prop = new PublicKey(mkt.prop);
const m = maker();
const { conn, program } = connect(m);

const p0: any = await program.account.prop.fetch(prop);
const fixtureId = mkt.fixtureId ?? Number(p0.fixtureId);
const statKey = mkt.statKey ?? p0.statKey;
const threshold = mkt.threshold ?? p0.threshold;

rule();
line(`  WATCHING · ${mkt.cluster}`);
rule();
line(`  prop      : ${prop.toBase58()}`);
line(`  fixture   : ${fixtureId}`);
line(`  question  : stat ${statKey} > ${threshold}, period 100 (full time)`);
line(`  state     : ${Object.keys(p0.state)[0].toUpperCase()}`);
line(`  poll      : every ${POLL_MS / 1000}s until game_finalised`);
line('');

if (Object.keys(p0.state)[0] !== 'matched') {
  line(`  Prop is ${Object.keys(p0.state)[0]}, not matched. Nothing to settle.`);
  line('  Run npm run market:take first, or npm run market:status to look at it.');
  process.exit(1);
}

const score = (e: any) => (e?.Stats ? `${e.Stats['1'] ?? 0}-${e.Stats['2'] ?? 0}` : '?');
let lastPrinted = '';

async function settleAndClaim(finalSeq: number) {
  line('');
  rule();
  line('  FULL TIME. Settling from the proof.');
  rule();

  const val = await fetchProof(finalSeq, fixtureId);
  const stat = val.statsToProve?.[0];
  line(`  proof     : seq ${finalSeq}, period ${stat?.period}, value ${stat?.value}`);

  if (stat?.period !== 100) {
    line(`  REFUSING: proof is period ${stat?.period}, not 100. The match is not finalised in the`);
    line('  data yet, whatever the clock says. Nothing settled. Re-run when it is.');
    process.exit(1);
  }

  const sig = await program.methods
    .settle(toPayload(val), strategyFor(threshold))
    .accounts({ settler: m.publicKey, prop, oracle: ORACLE, dailyScoresMerkleRoots: dailyScoresPda(val, ORACLE) })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
    .signers([m])
    .rpc();

  const p: any = await program.account.prop.fetch(prop);
  line(`  OK  SETTLED. "stat ${statKey} > ${threshold}" = ${String(p.yesWon).toUpperCase()}`);
  line(`      winner: ${p.yesWon ? 'MAKER (YES)' : 'TAKER (NO)'}`);
  line(`      ${explorerTx(sig)}`);

  const winnerKp = p.yesWon ? m : taker();
  const { conn: c2, program: prog2 } = connect(winnerKp);
  const before = await c2.getBalance(winnerKp.publicKey);
  const claimSig = await prog2.methods
    .claim().accounts({ winner: winnerKp.publicKey, prop }).signers([winnerKp]).rpc();
  const after = await c2.getBalance(winnerKp.publicKey);

  line('');
  line(`  OK  PAID. +${sol(after - before)} SOL to the ${p.yesWon ? 'YES' : 'NO'} side`);
  line(`      ${explorerTx(claimSig)}`);
  line('');
  line('  Nobody decided that. The proof did.');
  process.exit(0);
}

for (;;) {
  try {
    const events = await history(fixtureId);
    const scored = events.filter((e) => e.Stats);
    const last = scored[scored.length - 1];
    const finalised = events.filter((e) => e.Action === 'game_finalised').pop();
    const varOpen = events.filter((e) => String(e.Action || '').includes('var_review')).slice(-1)[0]?.Action === 'var_review_opened';

    if (finalised) {
      line(`  ${new Date().toISOString().slice(11, 19)}  game_finalised at ${new Date(finalised.Ts).toISOString().slice(11, 19)}  ${score(finalised)}`);
      await settleAndClaim(finalised.Seq);
    }

    // Only print when something changed, so a long match does not scroll for two hours.
    const now = `${score(last)}${last?.Confirmed === false ? ' (provisional)' : ''}${varOpen ? ' VAR OPEN' : ''}`;
    if (now !== lastPrinted) {
      line(`  ${new Date().toISOString().slice(11, 19)}  ${events.length} events  score ${now}`);
      lastPrinted = now;
    }
  } catch (e: any) {
    // A feed hiccup is not a reason to stop watching a match.
    line(`  ${new Date().toISOString().slice(11, 19)}  feed error: ${String(e.message || e).slice(0, 70)}`);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
