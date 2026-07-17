// Where is the money right now? Reads the prop straight from the chain.
// Read-only: no signature, no wallet needed to run it.

import { PublicKey } from '@solana/web3.js';
import { connect, maker, taker, loadMarket, cluster, line, rule, sol } from './market.js';

const mkt = loadMarket();
const prop = new PublicKey(mkt.prop);
const { conn, program } = connect(maker());

const p: any = await program.account.prop.fetch(prop);
const state = Object.keys(p.state)[0];
const held = await conn.getBalance(prop);

const CMP: Record<string, string> = { greaterThan: '>', lessThan: '<', equalTo: '=' };
const cmp = CMP[Object.keys(p.comparison)[0]] ?? '?';

rule();
line(`  MARKET STATUS · ${cluster()}`);
rule();
line(`  prop       : ${prop.toBase58()}`);
line(`  question   : stat ${p.statKey} (period ${p.statPeriod}) ${cmp} ${p.threshold}  on fixture ${p.fixtureId}`);
line(`  state      : ${state.toUpperCase()}`);
line(`  stake/side : ${sol(p.stake.toNumber())} SOL`);
line(`  held by PDA: ${sol(held)} SOL`);
line(`  maker (YES): ${p.maker.toBase58()}`);
line(`  taker (NO) : ${p.taker.equals(PublicKey.default) ? '(nobody yet)' : p.taker.toBase58()}`);
line(`  oracle     : ${p.oracle.toBase58()}`);
line(`  settles    : not before ${new Date(p.settleAfter.toNumber() * 1000).toISOString().slice(11, 19)} UTC`);

if (state === 'settled') {
  line('');
  line(`  RESULT     : prop is ${String(p.yesWon).toUpperCase()} -> ${p.yesWon ? 'MAKER (YES)' : 'TAKER (NO)'} wins`);
  line(`  ${held > 0 ? 'pot is still unclaimed. Run: npm run market:claim' : 'pot has been claimed. Nothing left to collect.'}`);
} else if (state === 'open') {
  line('');
  line('  Nobody has taken the other side. Run: npm run market:take');
} else if (state === 'matched') {
  line('');
  line('  Locked. Only a valid TxLINE proof opens it. Run: npm run market:settle');
}
