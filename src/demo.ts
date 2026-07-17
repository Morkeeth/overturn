// The demo: three attacks and one honest settlement, against a real World Cup semi-final.
// One attack per guard, in order. Attack N fires guard N.
//
// Prop under test:  "Spain total goals > 2"  (an over-2.5 market)
// Ground truth:     Spain scored 2. The prop is FALSE. The NO side must win.
//
// Every attack below uses a REAL, VALID, cryptographically sound TxLINE proof. None of them
// forge anything. They are all defeated by binding, not by cryptography, which is the point:
// verifying the proof is necessary and nowhere near sufficient.

import anchor from '@coral-xyz/anchor';
import { ComputeBudgetProgram, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  connect, maker as makerKeypair, taker as takerKeypair, propPdaFor,
  ORACLE, STAKE, FIXTURE, FINAL_WHISTLE, SPAIN_GOALS_KEY, FULL_TIME_PERIOD,
  fetchProof, toPayload, strategyFor, dailyScoresPda, line, rule,
} from './market.js';

const { BN } = anchor;

// Same wiring the step commands use (src/market.ts). The maker is the YES side and lives
// in the Keychain; the taker is the NO side and is persisted, because it wins this prop and
// claim() needs its signature.
const maker = makerKeypair();
const taker = takerKeypair();
const { conn, program } = connect(maker);

const nonce = new BN(Date.now());
const propPda = propPdaFor(maker.publicKey, nonce, program.programId);

line('='.repeat(76));
line('  OVERTURN ESCROW · France v Spain, World Cup semi-final, 2026-07-14');
line(`  PROP: "Spain total goals > 2"   (maker = YES, taker = NO, ${STAKE.toNumber() / LAMPORTS_PER_SOL} SOL/side)`);
line('  TRUTH: Spain scored 2. The prop is FALSE. NO must win.');
line('='.repeat(76));

// fund the taker
await conn.confirmTransaction(
  await conn.requestAirdrop(taker.publicKey, 0.2 * LAMPORTS_PER_SOL).catch(async () => {
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({ fromPubkey: maker.publicKey, toPubkey: taker.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL }),
    );
    return anchor.web3.sendAndConfirmTransaction(conn, tx, [maker]);
  }),
  'confirmed',
);

await program.methods
  .createProp(nonce, new BN(FIXTURE), SPAIN_GOALS_KEY, FULL_TIME_PERIOD, 2, { greaterThan: {} }, STAKE, new BN(FINAL_WHISTLE))
  .accounts({ maker: maker.publicKey, prop: propPda, oracle: ORACLE, systemProgram: SystemProgram.programId })
  .signers([maker])
  .rpc();
line(`\n  prop created @ ${propPda.toBase58()}`);

await program.methods
  .takeProp()
  .accounts({ taker: taker.publicKey, prop: propPda, systemProgram: SystemProgram.programId })
  .signers([taker])
  .rpc();
line('  prop matched. 0.1 SOL in escrow.\n');

const finalProof = await fetchProof(1026); // batch 21:04:14, period 100, value 2
const halfProof = await fetchProof(478);   // batch 19:50:07 -> 19:54:36, period 3, value 1

// The other semi-final, England v Argentina, played the next night. Its final proof is real,
// valid, and shaped exactly like ours: same stat key (2), same period (100), batch running past
// the final whistle. It clears the finality guard and the predicate guard. The only thing wrong
// with it is that it is a different match. Strip guard 1 and this proof settles a France v Spain
// prop using Argentina's scoreline.
const OTHER_SEMI = 18241006;      // England v Argentina, 2026-07-15
const OTHER_SEMI_FINAL_SEQ = 962; // game_finalised, 21:14:24 UTC
const foreignProof = await fetchProof(OTHER_SEMI_FINAL_SEQ, OTHER_SEMI);

const attempt = async (label: string, val: any, threshold: number, expect: 'REJECT' | 'ACCEPT') => {
  const payload = toPayload(val);
  try {
    await program.methods
      .settle(payload, strategyFor(threshold))
      .accounts({
        settler: maker.publicKey,
        prop: propPda,
        oracle: ORACLE,
        dailyScoresMerkleRoots: dailyScoresPda(val, ORACLE),
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
      .signers([maker])
      .rpc();
    line(`  ${expect === 'ACCEPT' ? 'OK  ' : 'FAIL'} ${label}`);
    line(`       -> SETTLED${expect === 'REJECT' ? '  <-- THE ESCROW WAS DRAINED' : ''}`);
    return true;
  } catch (e: any) {
    const m = String(e?.error?.errorMessage ?? e?.message ?? e).split('\n')[0];
    line(`  ${expect === 'REJECT' ? 'OK  ' : 'FAIL'} ${label}`);
    line(`       -> REJECTED: ${m.slice(0, 100)}`);
    return false;
  }
};

rule();
line('  ATTACKS: every one uses a genuine, valid, unforged TxLINE proof');
rule();

await attempt('ATTACK 1  real final proof from the OTHER semi-final (England v Argentina)', foreignProof, 2, 'REJECT');
await attempt('ATTACK 2  half-time proof (Spain had 1 goal at HT) to settle early', halfProof, 2, 'REJECT');
await attempt('ATTACK 3  honest final proof, but asks "Spain > 1" instead of "> 2"', finalProof, 1, 'REJECT');

rule();
line('  HONEST SETTLEMENT: final proof, the question the prop actually asked');
rule();
const settled = await attempt('SETTLE    final proof (period 100), predicate "Spain > 2"', finalProof, 2, 'ACCEPT');

const p: any = await program.account.prop.fetch(propPda);
const state = Object.keys(p.state)[0];

// Never infer a result from an unsettled account: `yesWon` defaults to false, which would
// read as "NO wins" and accidentally look correct. Assert the state, or say it failed.
line('');
if (!settled || state !== 'settled') {
  line(`  RESULT: NOT SETTLED (state=${state}). No winner. The demo did not prove anything.`);
  line('='.repeat(76));
  process.exit(1);
}

const winner = p.yesWon ? 'MAKER (YES)' : 'TAKER (NO)';
line(`  chain says: "Spain total goals > 2" = ${String(p.yesWon).toUpperCase()}`);
line(`  winner    : ${winner}`);
line(`  correct   : ${!p.yesWon ? 'YES, Spain scored 2, the prop was false' : 'NO, something is wrong'}`);
line('');

// Settling only records who won. claim() is what actually moves the money, and it wants
// the winner's signature. Run it: a settlement nobody can collect is not a settlement.
rule();
line('  PAYOUT: the winner collects. This is the money actually moving.');
rule();
const winnerKp = p.yesWon ? maker : taker;
const before = await conn.getBalance(winnerKp.publicKey);
try {
  const sig = await program.methods
    .claim()
    .accounts({ winner: winnerKp.publicKey, prop: propPda })
    .signers([winnerKp])
    .rpc();
  const after = await conn.getBalance(winnerKp.publicKey);
  const delta = (after - before) / LAMPORTS_PER_SOL;
  line(`  OK   CLAIM     ${winner} collected the pot`);
  line(`       -> +${delta.toFixed(4)} SOL to ${winnerKp.publicKey.toBase58()}`);
  line(`       -> ${sig}`);
} catch (e: any) {
  line(`  FAIL CLAIM     ${String(e?.error?.errorMessage ?? e?.message ?? e).split('\n')[0].slice(0, 100)}`);
}
line('');
line('  Nothing above trusted the stream. Every proof was genuine, and genuineness was');
line('  never the question: all three rejections happened BEFORE the oracle was asked.');
line('  The escrow refused to verify a proof it had no business verifying. Only the');
line('  settlement reached the CPI, and its verdict came from TxLINE, not from us.');
line('='.repeat(76));
process.exit(p.yesWon ? 1 : 0);
