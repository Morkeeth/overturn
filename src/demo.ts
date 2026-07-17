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
import { Connection, Keypair, PublicKey, ComputeBudgetProgram, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const { BN } = anchor;

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const ORACLE = new PublicKey(process.env.ORACLE ?? '6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J'); // devnet txoracle
const API = 'https://txline.txodds.com';

const FIXTURE = 18237038;          // France v Spain, semi-final, 2026-07-14
const FINAL_WHISTLE = 1784063054;  // game_finalised, 21:04:14 UTC (unix seconds)
const SPAIN_GOALS_KEY = 2;
const FULL_TIME_PERIOD = 100;

const kc = (s: string) =>
  execFileSync('security', ['find-generic-password', '-a', 'worldcup-agent', '-s', s, '-w'], { encoding: 'utf8' }).trim();

const mapProof = (a: any[]) => a.map((n) => ({ hash: Array.from(n.hash as number[]), isRightSibling: n.isRightSibling }));

async function fetchProof(seq: number, fixtureId: number = FIXTURE) {
  const r = await fetch(`${API}/api/scores/stat-validation?fixtureId=${fixtureId}&seq=${seq}&statKeys=${SPAIN_GOALS_KEY}`, {
    headers: { Authorization: `Bearer ${kc('WC_JWT')}`, 'X-Api-Token': kc('WC_API_TOKEN') },
  });
  if (!r.ok) throw new Error(`proof ${fixtureId}/${seq}: ${r.status}`);
  return r.json() as any;
}

const toPayload = (val: any) => ({
  ts: new BN(val.summary.updateStats.minTimestamp),
  fixtureSummary: {
    fixtureId: new BN(val.summary.fixtureId),
    updateStats: {
      updateCount: val.summary.updateStats.updateCount,
      minTimestamp: new BN(val.summary.updateStats.minTimestamp),
      maxTimestamp: new BN(val.summary.updateStats.maxTimestamp),
    },
    eventsSubTreeRoot: Array.from(val.summary.eventStatsSubTreeRoot as number[]),
  },
  fixtureProof: mapProof(val.subTreeProof),
  mainTreeProof: mapProof(val.mainTreeProof),
  eventStatRoot: Array.from(val.eventStatRoot as number[]),
  stats: val.statsToProve.map((stat: any, i: number) => ({ stat, statProof: mapProof(val.statProofs[i]) })),
});

const strategyFor = (threshold: number) => ({
  geometricTargets: [],
  distancePredicate: null,
  discretePredicates: [{ single: { index: 0, predicate: { threshold, comparison: { greaterThan: {} } } } }],
});

const dailyScoresPda = (val: any, programId: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('daily_scores_roots'), new BN(Math.floor(val.summary.updateStats.minTimestamp / 86_400_000)).toBuffer('le', 2)],
    programId,
  )[0];

// ---------------------------------------------------------------------------

const maker = Keypair.fromSecretKey(bs58.decode(kc('WC_WALLET_SECRET'))); // YES side
// The NO side, persisted to disk. It used to be Keypair.generate(). On devnet that is
// free money and nobody notices; on mainnet the taker WINS this prop (Spain scored 2, so
// the prop is false), and claim() requires the winner's signature. An ephemeral taker
// would take the private key to the pot to its grave, every run.
const TAKER_PATH = 'taker-keypair.json';
const taker = fs.existsSync(TAKER_PATH)
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(TAKER_PATH, 'utf8'))))
  : (() => {
      const kp = Keypair.generate();
      fs.writeFileSync(TAKER_PATH, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
      return kp;
    })();
const conn = new Connection(RPC, 'confirmed');
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(maker), { commitment: 'confirmed' });
anchor.setProvider(provider);

const idl = JSON.parse(fs.readFileSync('./overturn_escrow/target/idl/overturn_escrow.json', 'utf8'));
const program = new anchor.Program(idl, provider);

const nonce = new BN(Date.now());
const [propPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('prop'), maker.publicKey.toBuffer(), nonce.toArrayLike(Buffer, 'le', 8)],
  program.programId,
);

const STAKE = new BN(0.05 * LAMPORTS_PER_SOL);
const line = (s = '') => console.log(s);
const rule = () => line('-'.repeat(76));

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
