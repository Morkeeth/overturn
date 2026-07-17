// Step 4: the winner collects. This is the money actually moving.
//
// claim() takes the winner's signature and pays the whole pot. Settling only records
// who won; a settlement nobody can collect is not a settlement.

import { PublicKey } from '@solana/web3.js';
import { connect, maker, taker, loadMarket, explorerTx, line, rule, sol } from './market.js';

const mkt = loadMarket();
const prop = new PublicKey(mkt.prop);

// Read the state first with any wallet, then sign as whoever actually won.
const { program: reader } = connect(maker());
const p: any = await reader.account.prop.fetch(prop);
const state = Object.keys(p.state)[0];

if (state !== 'settled') {
  line(`Prop is ${state}, not settled. Nothing to claim yet. Run: npm run market:settle`);
  process.exit(1);
}

const winnerKp = p.yesWon ? maker() : taker();
const { conn, program } = connect(winnerKp);

rule();
line(`  CLAIM · ${mkt.cluster}`);
rule();
line(`  chain says : "Spain total goals > 2" = ${String(p.yesWon).toUpperCase()}`);
line(`  winner     : ${p.yesWon ? 'MAKER (YES)' : 'TAKER (NO)'}  ${winnerKp.publicKey.toBase58()}`);
line('');

const before = await conn.getBalance(winnerKp.publicKey);
const sig = await program.methods
  .claim()
  .accounts({ winner: winnerKp.publicKey, prop })
  .signers([winnerKp])
  .rpc();
const after = await conn.getBalance(winnerKp.publicKey);

line(`  OK  paid. +${sol(after - before)} SOL`);
line(`      ${explorerTx(sig)}`);
line('');
line('  Spain scored 2. The prop was false. The NO side was paid, on a Merkle proof,');
line('  by a program with no admin key and nobody to appeal to.');
