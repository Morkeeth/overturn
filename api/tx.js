// GET /api/tx?action=settle|attack|take|claim&prop=<pubkey>&signer=<pubkey>
//
// Builds an unsigned transaction and hands it back base64. The browser signs it with the
// judge's own wallet and sends it. We never see a private key and we cannot move anyone's
// money: the signature is theirs, so the transaction is theirs.
//
// This split exists because settling needs two things that live in different places. The
// TxLINE proof needs our subscription token, which must stay on the server. The signature
// needs a wallet, which must stay with the user. So the server assembles, the wallet
// authorises, and neither side has to trust the other with what it is holding.
//
// Everything here is devnet-only. Settling is permissionless by design, so anyone may call
// it; letting the internet do that to a mainnet escrow holding real money would be a
// different decision, and not one to make on a Friday.

import anchor from '@coral-xyz/anchor';
import { Connection, PublicKey, ComputeBudgetProgram, SystemProgram, Transaction } from '@solana/web3.js';
import { txline, json } from './_txline.js';
import idl from '../idl/overturn_escrow.json' with { type: 'json' };

const { BN } = anchor;

const RPC = 'https://api.devnet.solana.com';
const ORACLE = new PublicKey('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J');

const FIXTURE = 18237038;        // France v Spain, the semi-final this prop is about
const FINAL_SEQ = 1026;          // its full-time batch, period 100
const OTHER_SEMI = 18241006;     // England v Argentina
const OTHER_SEMI_SEQ = 962;      // ITS full-time batch. Real, valid, and the wrong match.
const SPAIN_GOALS_KEY = 2;

const mapProof = (a) => a.map((n) => ({ hash: Array.from(n.hash), isRightSibling: n.isRightSibling }));

const toPayload = (val) => ({
  ts: new BN(val.summary.updateStats.minTimestamp),
  fixtureSummary: {
    fixtureId: new BN(val.summary.fixtureId),
    updateStats: {
      updateCount: val.summary.updateStats.updateCount,
      minTimestamp: new BN(val.summary.updateStats.minTimestamp),
      maxTimestamp: new BN(val.summary.updateStats.maxTimestamp),
    },
    eventsSubTreeRoot: Array.from(val.summary.eventStatsSubTreeRoot),
  },
  fixtureProof: mapProof(val.subTreeProof),
  mainTreeProof: mapProof(val.mainTreeProof),
  eventStatRoot: Array.from(val.eventStatRoot),
  stats: val.statsToProve.map((stat, i) => ({ stat, statProof: mapProof(val.statProofs[i]) })),
});

const strategyFor = (threshold) => ({
  geometricTargets: [],
  distancePredicate: null,
  discretePredicates: [{ single: { index: 0, predicate: { threshold, comparison: { greaterThan: {} } } } }],
});

const dailyScoresPda = (val, programId) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('daily_scores_roots'), new BN(Math.floor(val.summary.updateStats.minTimestamp / 86_400_000)).toBuffer('le', 2)],
    programId,
  )[0];

async function proof(seq, fixtureId) {
  const r = await txline(`/api/scores/stat-validation?fixtureId=${fixtureId}&seq=${seq}&statKeys=${SPAIN_GOALS_KEY}`);
  if (!r.ok) throw new Error(`TxLINE proof ${fixtureId}/${seq}: ${r.status}`);
  return r.json();
}

// A read-only wallet. Anchor wants one to build instructions; it never signs here, and the
// transaction leaves unsigned on purpose.
const readOnlyWallet = (pk) => ({
  publicKey: pk,
  signTransaction: async (t) => t,
  signAllTransactions: async (t) => t,
});

export default async function handler(req, res) {
  const action = String(req.query.action || '');
  const propStr = String(req.query.prop || '');
  const signerStr = String(req.query.signer || '');

  let prop, signer;
  try {
    prop = new PublicKey(propStr);
    signer = new PublicKey(signerStr);
  } catch {
    return json(res, 400, { error: 'prop and signer must be base58 pubkeys' });
  }

  try {
    const conn = new Connection(RPC, 'confirmed');
    const provider = new anchor.AnchorProvider(conn, readOnlyWallet(signer), { commitment: 'confirmed' });
    const program = new anchor.Program(idl, provider);

    let ix;
    let note;

    if (action === 'take') {
      ix = await program.methods
        .takeProp()
        .accounts({ taker: signer, prop, systemProgram: SystemProgram.programId })
        .instruction();
      note = 'Match the stake and lock the pot. From here nobody can pay it out by hand.';
    } else if (action === 'claim') {
      ix = await program.methods.claim().accounts({ winner: signer, prop }).instruction();
      note = 'Collect the pot. Only the winning side can.';
    } else if (action === 'settle' || action === 'attack') {
      const isAttack = action === 'attack';
      const val = isAttack ? await proof(OTHER_SEMI_SEQ, OTHER_SEMI) : await proof(FINAL_SEQ, FIXTURE);
      ix = await program.methods
        .settle(toPayload(val), strategyFor(2))
        .accounts({ settler: signer, prop, oracle: ORACLE, dailyScoresMerkleRoots: dailyScoresPda(val, ORACLE) })
        .instruction();
      note = isAttack
        ? 'A real, valid, unforged proof from the OTHER semi-final. Guard 1 should reject it.'
        : 'The real full-time proof for this match. The oracle decides, not you.';
    } else {
      return json(res, 400, { error: 'action must be take, settle, attack or claim' });
    }

    const tx = new Transaction();
    if (action === 'settle' || action === 'attack') {
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    }
    tx.add(ix);
    tx.feePayer = signer;
    tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;

    const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

    return json(res, 200, {
      action,
      cluster: 'devnet',
      note,
      tx: wire.toString('base64'),
    });
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
}
