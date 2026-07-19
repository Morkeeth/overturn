// The Settler Agent.
//
// An autonomous settlement agent. No human tells it which proof is the right one. It is handed
// an inbox of cryptographically valid TxLINE proofs — some from the wrong match, some from
// before full time — and it decides, entirely on its own, which one is allowed to settle the
// market, using the provider-agnostic settlement firewall (src/firewall.ts).
//
// This is the "why now" of the whole project: a human catches a phantom goal — they watch the
// VAR replay and refuse to pay. An autonomous agent has no such instinct; it would settle on
// whatever the feed asserts, at machine speed, irreversibly. The three guards are the machine's
// substitute for human skepticism: the encoded reasons a valid-looking proof lies — wrong
// match, wrong moment, wrong question.
//
// Runs on devnet against a real prop and real proofs. Never touches the mainnet program.

import anchor from '@coral-xyz/anchor';
import { ComputeBudgetProgram, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  connect, maker as makerKeypair, taker as takerKeypair, propPdaFor,
  ORACLE, STAKE, FIXTURE, FINAL_WHISTLE, SPAIN_GOALS_KEY, FULL_TIME_PERIOD,
  fetchProof, toPayload, strategyFor, dailyScoresPda, cluster, explorerTx, line, rule,
} from './market.js';
import { firewall, txoddsClaim, type FrozenQuestion } from './firewall.js';

const { BN } = anchor;

const maker = makerKeypair();
const taker = takerKeypair();
const { conn, program } = connect(maker);

// Devnet-friendly stake so the agent runs even on a nearly-empty faucet wallet. The decision
// is the demo, not the amount; the real 0.1 SOL settlement is on mainnet. Override with
// AGENT_STAKE_SOL once you have devnet SOL (faucet.solana.com).
const STAKE_SM = new BN(Number(process.env.AGENT_STAKE_SOL ?? 0.001) * LAMPORTS_PER_SOL);
const FUND_TAKER = Math.max(0.003, Number(process.env.AGENT_STAKE_SOL ?? 0.001) * 2 + 0.001);

// The question this market freezes at creation. The agent holds every proof to exactly this.
const FROZEN: FrozenQuestion = {
  subjectId: FIXTURE,
  statKey: SPAIN_GOALS_KEY,
  period: FULL_TIME_PERIOD,
  threshold: 2,
  comparison: 'greaterThan',
  settleAfterMs: FINAL_WHISTLE * 1000,
  label: 'Spain total goals > 2',
};

line('='.repeat(76));
line('  SETTLER AGENT · autonomous, no human in the loop');
line(`  MARKET: "${FROZEN.label}" · France v Spain semi-final · ${cluster()}`);
line('  The agent is handed an inbox of valid proofs. It decides which may settle. Alone.');
line('='.repeat(76));

// --- set up a real, matched market on devnet ---------------------------------
const nonce = new BN(Date.now());
const propPda = propPdaFor(maker.publicKey, nonce, program.programId);

// Fund the taker from the maker only if it can't cover its stake. Devnet airdrops are
// rate-limited to uselessness, so we top up directly — no airdrop, no 429 retry spam on screen.
const takerNeeds = STAKE_SM.toNumber() + Math.floor(0.002 * LAMPORTS_PER_SOL);
const takerBal = await conn.getBalance(taker.publicKey);
if (takerBal < takerNeeds) {
  const fund = new anchor.web3.Transaction().add(
    SystemProgram.transfer({ fromPubkey: maker.publicKey, toPubkey: taker.publicKey, lamports: takerNeeds - takerBal }),
  );
  await anchor.web3.sendAndConfirmTransaction(conn, fund, [maker]);
}

await program.methods
  .createProp(nonce, new BN(FIXTURE), SPAIN_GOALS_KEY, FULL_TIME_PERIOD, 2, { greaterThan: {} }, STAKE_SM, new BN(FINAL_WHISTLE))
  .accounts({ maker: maker.publicKey, prop: propPda, oracle: ORACLE, systemProgram: SystemProgram.programId })
  .signers([maker]).rpc();
await program.methods
  .takeProp()
  .accounts({ taker: taker.publicKey, prop: propPda, systemProgram: SystemProgram.programId })
  .signers([taker]).rpc();
line(`\n  market open + matched @ ${propPda.toBase58()}  ·  ${(STAKE_SM.toNumber() * 2 / LAMPORTS_PER_SOL).toFixed(3)} SOL escrowed\n`);

// --- the inbox: three valid proofs arrive from the feed ----------------------
// The agent does NOT know which is correct. Each is genuine and unforged.
const OTHER_SEMI = 18241006; // England v Argentina — a real, valid, but wrong-match proof
const inbox = [
  { val: await fetchProof(962, OTHER_SEMI), note: 'a final proof — from another match' },
  { val: await fetchProof(478),            note: 'a half-time proof — Spain led 1-0 at the break' },
  { val: await fetchProof(1026),           note: 'a full-time proof for this match' },
];

rule();
line('  AGENT TRIAGE — the firewall decides, not a human. Three valid proofs, one market.');
rule();

// --- autonomous decision: run the firewall on every proof in the inbox -------
const admitted: any[] = [];
for (let i = 0; i < inbox.length; i++) {
  const { val, note } = inbox[i];
  const claim = txoddsClaim(val, note);
  const result = firewall(claim, FROZEN);

  line(`\n  [${i + 1}] inbox proof · ${note}`);
  line(`      source=${claim.source} subject=${claim.subjectId} stat=${claim.statKey}/${claim.period}`);
  for (const v of result.verdicts) {
    line(`      ${v.pass ? 'pass' : 'STOP'}  ${v.guard.padEnd(30)} ${v.detail}`);
  }
  if (result.admit) {
    line(`      => ADMIT. This proof answers the exact question the market froze.`);
    admitted.push({ val, note });
  } else {
    line(`      => REFUSE (${result.refusedBy}). The agent will not spend gas on a proof the chain would reject.`);
  }
}

line('');
rule();
line(`  DECISION: agent admitted ${admitted.length} of ${inbox.length} proofs — with zero human input.`);
rule();

if (admitted.length !== 1) {
  line(`\n  The agent did not converge on exactly one proof (${admitted.length}). Refusing to settle.`);
  process.exit(1);
}

// --- defense in depth: prove the refusal is not just the agent's opinion -----
// Submit one refused proof (wrong match) on-chain while the prop is still matched. The escrow
// enforces the SAME guards, so a careless agent — or an attacker — cannot get it through either.
line('\n  Proof-of-refusal: submitting the wrong-match proof on-chain, to show the escrow');
line('  enforces what the agent decided off-chain...');
try {
  await program.methods
    .settle(toPayload(inbox[0].val), strategyFor(FROZEN.threshold))
    .accounts({ settler: maker.publicKey, prop: propPda, oracle: ORACLE, dailyScoresMerkleRoots: dailyScoresPda(inbox[0].val, ORACLE) })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
    .signers([maker]).rpc();
  line('  UNEXPECTED: the chain accepted a wrong-match proof. This must never happen.');
  process.exit(1);
} catch (e: any) {
  const m = String(e?.error?.errorMessage ?? e?.message ?? e).split('\n')[0];
  line(`  chain REJECTED it: ${m.slice(0, 90)}`);
  line('  Agent and chain agree. The firewall is the decision; the chain is the enforcement.');
}

// --- settle the one admitted proof, autonomously -----------------------------
line('\n  Settling with the one admitted proof...');
const good = admitted[0].val;
const sig = await program.methods
  .settle(toPayload(good), strategyFor(FROZEN.threshold))
  .accounts({ settler: maker.publicKey, prop: propPda, oracle: ORACLE, dailyScoresMerkleRoots: dailyScoresPda(good, ORACLE) })
  .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
  .signers([maker]).rpc();

const p: any = await program.account.prop.fetch(propPda);
const state = Object.keys(p.state)[0];
if (state !== 'settled') {
  line(`  Settlement did not stick (state=${state}).`);
  process.exit(1);
}
const winner = p.yesWon ? 'MAKER (YES)' : 'TAKER (NO)';
line(`  SETTLED · "${FROZEN.label}" = ${String(p.yesWon).toUpperCase()} · ${winner} wins`);
line(`  ${explorerTx(sig)}`);

// --- pay the winner ----------------------------------------------------------
const winnerKp = p.yesWon ? maker : taker;
const before = await conn.getBalance(winnerKp.publicKey);
const claimSig = await program.methods
  .claim().accounts({ winner: winnerKp.publicKey, prop: propPda }).signers([winnerKp]).rpc();
const delta = (await conn.getBalance(winnerKp.publicKey) - before) / LAMPORTS_PER_SOL;
line(`  PAID · +${delta.toFixed(4)} SOL to ${winner}`);
line(`  ${explorerTx(claimSig)}`);

line('');
line('='.repeat(76));
line('  No human decided which proof was correct. The agent refused two valid proofs —');
line('  one from the wrong match, one from before full time — and settled the third.');
line('  That refusal is the machine\'s substitute for a human who saw the goal get reversed.');
line('='.repeat(76));
process.exit(p.yesWon ? 1 : 0);
