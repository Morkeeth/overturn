// GET /api/play?step=create|take|settle|claim[&prop=<pubkey>]
//
// Play mode: the app drives a real market end-to-end on devnet, no wallet. The browser calls
// these four steps in order and streams each result; the server signs with two devnet-only burner
// keys (a maker and a taker — the escrow forbids self-take). One tx per call, so it fits any
// serverless timeout. Devnet only, worthless test SOL: these burners never touch mainnet.

import anchor from '@coral-xyz/anchor';
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { txline, json } from './_txline.js';
import idl from '../idl/overturn_escrow.json' with { type: 'json' };

const { BN } = anchor;
const RPC = 'https://api.devnet.solana.com';
const ORACLE = new PublicKey('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J');
const FIXTURE = 18237038, FINAL_SEQ = 1026, SPAIN_GOALS_KEY = 2, FULL_TIME_PERIOD = 100, FINAL_WHISTLE = 1784063054;
const STAKE = new BN(Number(process.env.PLAY_STAKE_SOL ?? 0.01) * 1e9);
const b58 = bs58.default || bs58;

// Burners: env for prod (Vercel), local file for dev. Never the mainnet key.
function burners() {
  if (process.env.PLAY_MAKER_SECRET && process.env.PLAY_TAKER_SECRET) {
    return { maker: Keypair.fromSecretKey(b58.decode(process.env.PLAY_MAKER_SECRET)),
             taker: Keypair.fromSecretKey(b58.decode(process.env.PLAY_TAKER_SECRET)) };
  }
  const f = JSON.parse(readFileSync(new URL('../.play-burners.json', import.meta.url), 'utf8'));
  return { maker: Keypair.fromSecretKey(b58.decode(f.maker)), taker: Keypair.fromSecretKey(b58.decode(f.taker)) };
}

const programFor = (conn, kp) =>
  new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' }));

const propPda = (makerKey, nonce, pid) =>
  PublicKey.findProgramAddressSync([Buffer.from('prop'), makerKey.toBuffer(), nonce.toArrayLike(Buffer, 'le', 8)], pid)[0];

const mapProof = (a) => a.map((n) => ({ hash: Array.from(n.hash), isRightSibling: n.isRightSibling }));
const toPayload = (v) => ({
  ts: new BN(v.summary.updateStats.minTimestamp),
  fixtureSummary: { fixtureId: new BN(v.summary.fixtureId),
    updateStats: { updateCount: v.summary.updateStats.updateCount, minTimestamp: new BN(v.summary.updateStats.minTimestamp), maxTimestamp: new BN(v.summary.updateStats.maxTimestamp) },
    eventsSubTreeRoot: Array.from(v.summary.eventStatsSubTreeRoot) },
  fixtureProof: mapProof(v.subTreeProof), mainTreeProof: mapProof(v.mainTreeProof),
  eventStatRoot: Array.from(v.eventStatRoot),
  stats: v.statsToProve.map((stat, i) => ({ stat, statProof: mapProof(v.statProofs[i]) })),
});
const strategyFor = (t) => ({ geometricTargets: [], distancePredicate: null, discretePredicates: [{ single: { index: 0, predicate: { threshold: t, comparison: { greaterThan: {} } } } }] });
const dailyScoresPda = (v, pid) => PublicKey.findProgramAddressSync([Buffer.from('daily_scores_roots'), new BN(Math.floor(v.summary.updateStats.minTimestamp / 86_400_000)).toBuffer('le', 2)], pid)[0];

export default async function handler(req, res) {
  const step = String(req.query.step || '');
  try {
    const conn = new Connection(RPC, 'confirmed');
    const { maker, taker } = burners();
    const mp = programFor(conn, maker);

    if (step === 'create') {
      const nonce = new BN(Date.now());
      const prop = propPda(maker.publicKey, nonce, mp.programId);
      const sig = await mp.methods
        .createProp(nonce, new BN(FIXTURE), SPAIN_GOALS_KEY, FULL_TIME_PERIOD, 2, { greaterThan: {} }, STAKE, new BN(FINAL_WHISTLE))
        .accounts({ maker: maker.publicKey, prop, oracle: ORACLE, systemProgram: SystemProgram.programId }).rpc();
      return json(res, 200, { step, sig, prop: prop.toBase58(), label: 'Market created — question frozen: "Spain total goals > 2"' });
    }

    const prop = new PublicKey(String(req.query.prop));

    if (step === 'take') {
      const tp = programFor(conn, taker);
      const sig = await tp.methods.takeProp().accounts({ taker: taker.publicKey, prop, systemProgram: SystemProgram.programId }).rpc();
      return json(res, 200, { step, sig, label: `Matched — ${(STAKE.toNumber() * 2 / 1e9).toFixed(2)} SOL locked, no admin can touch it` });
    }

    if (step === 'settle') {
      const r = await txline(`/api/scores/stat-validation?fixtureId=${FIXTURE}&seq=${FINAL_SEQ}&statKeys=${SPAIN_GOALS_KEY}`);
      if (!r.ok) throw new Error(`TxLINE proof: ${r.status}`);
      const val = await r.json();
      const sig = await mp.methods.settle(toPayload(val), strategyFor(2))
        .accounts({ settler: maker.publicKey, prop, oracle: ORACLE, dailyScoresMerkleRoots: dailyScoresPda(val, ORACLE) })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]).rpc();
      const p = await mp.account.prop.fetch(prop);
      return json(res, 200, { step, sig, yesWon: p.yesWon, label: `Settled by proof — "Spain total goals > 2" = ${String(p.yesWon).toUpperCase()} · ${p.yesWon ? 'YES' : 'NO'} side wins` });
    }

    if (step === 'claim') {
      const p = await mp.account.prop.fetch(prop);
      const winnerKp = p.yesWon ? maker : taker;
      const wp = programFor(conn, winnerKp);
      const before = await conn.getBalance(winnerKp.publicKey);
      const sig = await wp.methods.claim().accounts({ winner: winnerKp.publicKey, prop }).rpc();
      const paid = (await conn.getBalance(winnerKp.publicKey) - before) / 1e9;
      return json(res, 200, { step, sig, paid, label: `Paid — +${paid.toFixed(3)} SOL to the ${p.yesWon ? 'YES' : 'NO'} side. No appeal.` });
    }

    return json(res, 400, { error: 'step must be create, take, settle or claim' });
  } catch (e) {
    return json(res, 500, { error: String(e.message || e).split('\n')[0] });
  }
}
