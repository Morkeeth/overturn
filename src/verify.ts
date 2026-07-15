// On-chain verification: ask TxLINE's mainnet program what actually happened.
//
// This is the load-bearing claim of the whole project, so it is checked against mainnet
// rather than asserted:
//
//   At 20:22:29 on 2026-07-14 the SSE stream published Spain's 3rd goal (Confirmed:false).
//   VAR retracted it 26s later. The stream therefore said "Spain total goals = 3".
//   The Merkle proof, anchored on Solana, says 2.
//
// If the chain answers "Spain goals > 2" = false, then the chain is honest, the stream is
// not, and any settlement driven by the stream is unsafe. That is the product.

import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const { BN } = anchor;
const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const API = 'https://txline.txodds.com';

const kc = (s: string) =>
  execFileSync('security', ['find-generic-password', '-a', 'worldcup-agent', '-s', s, '-w'], { encoding: 'utf8' }).trim();

type ProofNodeRaw = { hash: number[]; isRightSibling: boolean };
const mapProof = (arr: ProofNodeRaw[]) => arr.map((n) => ({ hash: Array.from(n.hash), isRightSibling: n.isRightSibling }));

/** Fetch the Merkle proof for a stat at a given feed sequence. */
async function fetchProof(fixtureId: number, seq: number, statKeys: string) {
  const res = await fetch(`${API}/api/scores/stat-validation?fixtureId=${fixtureId}&seq=${seq}&statKeys=${statKeys}`, {
    headers: { Authorization: `Bearer ${kc('WC_JWT')}`, 'X-Api-Token': kc('WC_API_TOKEN') },
  });
  if (!res.ok) throw new Error(`proof fetch failed: ${res.status} ${await res.text()}`);
  return res.json() as any;
}

/** Ask the mainnet program: does `stat <cmp> threshold` hold, given this proof? Read-only. */
async function validateOnChain(val: any, threshold: number, comparison: 'greaterThan' | 'lessThan' | 'equalTo') {
  const user = Keypair.fromSecretKey(bs58.decode(kc('WC_WALLET_SECRET')));
  const conn = new Connection(RPC, 'confirmed');
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(user), { commitment: 'confirmed' });
  const idl = JSON.parse(fs.readFileSync('./idl.json', 'utf8'));
  const program = new anchor.Program(idl, provider);

  const targetTs = val.summary.updateStats.minTimestamp;
  const epochDay = Math.floor(targetTs / 86_400_000);
  const [dailyScoresPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('daily_scores_roots'), new BN(epochDay).toBuffer('le', 2)],
    program.programId,
  );

  const payload = {
    ts: new BN(targetTs),
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
  };

  const strategy = {
    geometricTargets: [],
    distancePredicate: null,
    discretePredicates: [{ single: { index: 0, predicate: { threshold, comparison: { [comparison]: {} } } } }],
  };

  return (await program.methods
    .validateStatV2(payload, strategy)
    .accounts({ dailyScoresMerkleRoots: dailyScoresPda })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
    .view()) as boolean;
}

const FIXTURE = 18237038; // France v Spain, semi-final
const PHANTOM_SEQ = 638;  // the goal that was published, then erased by VAR

const val = await fetchProof(FIXTURE, PHANTOM_SEQ, '2'); // key 2 = Participant2 (Spain) goals

console.log('='.repeat(74));
console.log('  ON-CHAIN TRUTH vs THE STREAM   (fixture 18237038, seq 638)');
console.log('='.repeat(74));
console.log(`  SSE stream said at 20:22:29 :  Spain Total Goals = 3   (Confirmed:false)`);
console.log(`  Merkle proof says           :  Spain goals = ${val.statsToProve[0].value}`);
console.log(`  batch window                :  ${new Date(val.summary.updateStats.minTimestamp).toISOString().slice(11, 19)} -> ${new Date(val.summary.updateStats.maxTimestamp).toISOString().slice(11, 19)} (${val.summary.updateStats.updateCount} updates)`);
console.log('');

for (const [threshold, cmp, question] of [
  [2, 'greaterThan', 'Spain goals > 2   (the phantom 3rd goal: did it happen?)'],
  [1, 'greaterThan', 'Spain goals > 1   (control: they really did score 2)'],
] as const) {
  const ok = await validateOnChain(val, threshold, cmp);
  console.log(`  mainnet says: ${String(ok).toUpperCase().padEnd(5)}  <-  ${question}`);
}
console.log('='.repeat(74));
