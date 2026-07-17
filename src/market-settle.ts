// Step 3: settle. Permissionless: anyone may call this, because the caller has no
// discretion. They hand over a TxLINE proof; the guards and the oracle decide.
//
// Pass --attack to send the proof from the OTHER semi-final instead (England v Argentina).
// It is real, valid and unforged, it clears the finality and predicate guards, and it is
// still rejected, because it is not this match.

import { PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import {
  connect, maker, ORACLE, fetchProof, toPayload, strategyFor, dailyScoresPda,
  loadMarket, explorerTx, line, rule,
} from './market.js';

const ATTACK = process.argv.includes('--attack');
const OTHER_SEMI = 18241006;
const OTHER_SEMI_FINAL_SEQ = 962;
const FINAL_SEQ = 1026;

const mkt = loadMarket();
const m = maker();
const { program } = connect(m);
const prop = new PublicKey(mkt.prop);

const val = ATTACK ? await fetchProof(OTHER_SEMI_FINAL_SEQ, OTHER_SEMI) : await fetchProof(FINAL_SEQ);

rule();
line(`  SETTLE · ${mkt.cluster}`);
rule();
if (ATTACK) {
  line('  proof      : England v Argentina, the OTHER semi-final (fixture 18241006)');
  line('  shape      : same stat key, same period, batch runs past the whistle');
  line('  expect     : REJECTED by guard 1. The proof is real. It is the wrong match.');
} else {
  line('  proof      : France v Spain final batch, period 100 (fixture 18237038)');
  line('  predicate  : "Spain > 2", the question the prop was opened with');
}
line('');

try {
  const sig = await program.methods
    .settle(toPayload(val), strategyFor(2))
    .accounts({ settler: m.publicKey, prop, oracle: ORACLE, dailyScoresMerkleRoots: dailyScoresPda(val, ORACLE) })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
    .signers([m])
    .rpc();
  const p: any = await program.account.prop.fetch(prop);
  line(`  ${ATTACK ? 'FAIL' : 'OK  '} SETTLED. "Spain total goals > 2" = ${String(p.yesWon).toUpperCase()}`);
  line(`      winner: ${p.yesWon ? 'MAKER (YES)' : 'TAKER (NO)'}${ATTACK ? '  <-- THE ESCROW WAS DRAINED' : ''}`);
  line(`      ${explorerTx(sig)}`);
  line('');
  if (!ATTACK) line('  Next: npm run market:claim');
} catch (e: any) {
  const msg = String(e?.error?.errorMessage ?? e?.message ?? e).split('\n')[0];
  line(`  ${ATTACK ? 'OK  ' : 'FAIL'} REJECTED: ${msg.slice(0, 110)}`);
  if (ATTACK) {
    line('');
    line('  The money did not move. Nothing was verified: the escrow refused before');
    line('  it ever asked the oracle. Try the real proof: npm run market:settle');
  }
}
