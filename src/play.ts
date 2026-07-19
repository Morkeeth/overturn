// Play mode — the frictionless round-trip.
//
// The felt product in one command: a fresh market is created, matched, settled, and paid, live on
// devnet, with real transactions — and NO wallet. The app drives it with two funded burner keys
// (the escrow forbids self-take, so we need a maker AND a taker). A human "brings their own wallet"
// only if they want to sign the attack themselves (that path lives on /market).
//
// This is the reusable engine: `npm run play` runs it in the terminal; the play endpoint + UI call
// the same lifecycle and stream each STEP line to the browser. Every line ends in a real sig.

import anchor from '@coral-xyz/anchor';
import { ComputeBudgetProgram, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  connect, maker as makerKeypair, taker as takerKeypair, propPdaFor,
  ORACLE, FIXTURE, FINAL_WHISTLE, SPAIN_GOALS_KEY, FULL_TIME_PERIOD,
  fetchProof, toPayload, strategyFor, dailyScoresPda, cluster, explorerTx, line, rule,
} from './market.js';

const { BN } = anchor;

const maker = makerKeypair();
const taker = takerKeypair();
const { conn, program } = connect(maker);

// Small stake so one funded burner covers many plays. The point is the round-trip, not the amount.
const STAKE = new BN(Number(process.env.PLAY_STAKE_SOL ?? 0.01) * LAMPORTS_PER_SOL);

/** Emit one step as a human line AND a machine line (JSON) the browser/endpoint can parse. */
const step = (n: number, label: string, data: Record<string, unknown> = {}) => {
  line(`  [${n}/4] ${label}`);
  if (data.sig) line(`        ${explorerTx(String(data.sig))}`);
  console.log(`__STEP__ ${JSON.stringify({ n, label, ...data })}`);
};

rule();
line(`  OVERTURN · PLAY MODE — a full market, no wallet, live on ${cluster()}`);
line(`  "Spain total goals > 2" · France v Spain semi-final · ${STAKE.toNumber() / LAMPORTS_PER_SOL} SOL/side`);
rule();

// keep the taker able to cover its own stake (fund only the shortfall from the maker; no airdrops)
const takerNeeds = STAKE.toNumber() + Math.floor(0.002 * LAMPORTS_PER_SOL);
if ((await conn.getBalance(taker.publicKey)) < takerNeeds) {
  const shortfall = takerNeeds - (await conn.getBalance(taker.publicKey));
  await anchor.web3.sendAndConfirmTransaction(conn,
    new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: maker.publicKey, toPubkey: taker.publicKey, lamports: shortfall })),
    [maker]);
}

const nonce = new BN(Date.now());
const prop = propPdaFor(maker.publicKey, nonce, program.programId);

// 1 · CREATE — the maker opens a market and freezes the question, before anyone knows the answer.
let sig = await program.methods
  .createProp(nonce, new BN(FIXTURE), SPAIN_GOALS_KEY, FULL_TIME_PERIOD, 2, { greaterThan: {} }, STAKE, new BN(FINAL_WHISTLE))
  .accounts({ maker: maker.publicKey, prop, oracle: ORACLE, systemProgram: SystemProgram.programId })
  .signers([maker]).rpc();
step(1, 'Market created — question frozen: "Spain total goals > 2"', { sig, prop: prop.toBase58() });

// 2 · TAKE — the other side is matched. The pot is now unspendable by hand.
sig = await program.methods
  .takeProp().accounts({ taker: taker.publicKey, prop, systemProgram: SystemProgram.programId }).signers([taker]).rpc();
step(2, `Matched — ${(STAKE.toNumber() * 2 / LAMPORTS_PER_SOL).toFixed(2)} SOL locked, no admin can touch it`, { sig });

// 3 · SETTLE — only a real final proof, verified on-chain, decides it.
const proof = await fetchProof(1026); // France v Spain, full time, Spain scored 2
sig = await program.methods
  .settle(toPayload(proof), strategyFor(2))
  .accounts({ settler: maker.publicKey, prop, oracle: ORACLE, dailyScoresMerkleRoots: dailyScoresPda(proof, ORACLE) })
  .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]).signers([maker]).rpc();
const p: any = await program.account.prop.fetch(prop);
step(3, `Settled by proof — "Spain total goals > 2" = ${String(p.yesWon).toUpperCase()} · ${p.yesWon ? 'YES' : 'NO'} side wins`, { sig, yesWon: p.yesWon });

// 4 · CLAIM — the winner collects. The money actually moves.
const winner = p.yesWon ? maker : taker;
const before = await conn.getBalance(winner.publicKey);
sig = await program.methods.claim().accounts({ winner: winner.publicKey, prop }).signers([winner]).rpc();
const delta = (await conn.getBalance(winner.publicKey) - before) / LAMPORTS_PER_SOL;
step(4, `Paid — +${delta.toFixed(3)} SOL to the ${p.yesWon ? 'YES' : 'NO'} side. No appeal.`, { sig, paid: delta });

rule();
line('  A full market: created, matched, settled by proof, paid — no wallet, real devnet money.');
rule();
console.log(`__DONE__ ${JSON.stringify({ prop: prop.toBase58(), winner: p.yesWon ? 'YES' : 'NO' })}`);
