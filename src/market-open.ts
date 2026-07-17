// Step 1: open a market. The maker takes YES and locks a stake.
//
// Everything that decides the outcome is frozen here, before anyone knows the answer:
// which fixture, which stat, which period, the threshold, the comparison, the oracle,
// and the earliest time it may settle. settle() checks the proof against these, so the
// question can never be edited after the fact by whoever shows up to settle it.

import anchor from '@coral-xyz/anchor';
import { SystemProgram } from '@solana/web3.js';
import {
  connect, maker, ORACLE, STAKE, FIXTURE, FINAL_WHISTLE, SPAIN_GOALS_KEY, FULL_TIME_PERIOD,
  propPdaFor, saveMarket, cluster, explorerTx, line, rule, sol,
} from './market.js';

const { BN } = anchor;

const m = maker();
const { conn, program } = connect(m);

const balance = await conn.getBalance(m.publicKey);
if (balance < STAKE.toNumber() + 5_000_000) {
  line(`Maker ${m.publicKey.toBase58()} has ${sol(balance)} SOL on ${cluster()}, needs ~${sol(STAKE.toNumber() + 5_000_000)}.`);
  process.exit(1);
}

const nonce = new BN(Date.now());
const prop = propPdaFor(m.publicKey, nonce, program.programId);

rule();
line(`  OPEN MARKET · ${cluster()}`);
rule();
line(`  question   : "Spain total goals > 2"   (over 2.5, full time)`);
line(`  fixture    : ${FIXTURE}  France v Spain, World Cup semi-final`);
line(`  maker      : ${m.publicKey.toBase58()}  takes YES`);
line(`  stake      : ${sol(STAKE.toNumber())} SOL`);
line(`  settles    : not before ${new Date(FINAL_WHISTLE * 1000).toISOString().slice(11, 19)} UTC (the final whistle)`);
line('');

const sig = await program.methods
  .createProp(
    nonce,
    new BN(FIXTURE),
    SPAIN_GOALS_KEY,
    FULL_TIME_PERIOD,
    2,
    { greaterThan: {} },
    STAKE,
    new BN(FINAL_WHISTLE),
  )
  .accounts({ maker: m.publicKey, prop, oracle: ORACLE, systemProgram: SystemProgram.programId })
  .signers([m])
  .rpc();

saveMarket({ nonce: nonce.toString(), prop: prop.toBase58(), cluster: cluster(), opened: new Date().toISOString() });

line(`  OK  prop open @ ${prop.toBase58()}`);
line(`      ${explorerTx(sig)}`);
line('');
line('  Next: npm run market:take');
