// Step 2: take the other side. The taker matches the stake and the pot is locked.
//
// From here nobody can pay it out by hand. The only thing that opens the escrow is a
// TxLINE Merkle proof that satisfies all three guards.

import { SystemProgram } from '@solana/web3.js';
import { connect, maker, taker, STAKE, loadMarket, explorerTx, line, rule, sol } from './market.js';
import { PublicKey } from '@solana/web3.js';

const mkt = loadMarket();
const t = taker();
const { conn, program } = connect(t);
const prop = new PublicKey(mkt.prop);

const balance = await conn.getBalance(t.publicKey);
if (balance < STAKE.toNumber() + 5_000_000) {
  line(`Taker ${t.publicKey.toBase58()} has ${sol(balance)} SOL, needs ~${sol(STAKE.toNumber() + 5_000_000)}.`);
  line(`Fund it from the maker: solana transfer ${t.publicKey.toBase58()} 0.1 --url ${mkt.cluster}`);
  process.exit(1);
}

rule();
line(`  TAKE THE OTHER SIDE · ${mkt.cluster}`);
rule();
line(`  taker      : ${t.publicKey.toBase58()}  takes NO`);
line(`  stake      : ${sol(STAKE.toNumber())} SOL`);
line('');

const sig = await program.methods
  .takeProp()
  .accounts({ taker: t.publicKey, prop, systemProgram: SystemProgram.programId })
  .signers([t])
  .rpc();

const p: any = await program.account.prop.fetch(prop);
line(`  OK  matched. ${sol(p.stake.toNumber() * 2)} SOL locked in ${prop.toBase58()}`);
line(`      ${explorerTx(sig)}`);
line('');
line('  The pot is now unspendable by either side. Next: npm run market:settle');
