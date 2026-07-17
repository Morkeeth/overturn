// Step 1: open a market. The maker takes YES and locks a stake.
//
//   npm run market:open                                        the July-14 semi-final
//   npm run market:open -- --fixture 18257739 --stat 1 --threshold 1
//
// Everything that decides the outcome is frozen here, before anyone knows the answer: which
// fixture, which stat, which period, the threshold, the comparison, the oracle, and the
// earliest time it may settle. settle() checks a proof against these, so the question cannot
// be edited afterwards by whoever turns up to settle it.
//
// On settle_after for a match that has not been played yet: it is a unix timestamp and nobody
// knows the real final whistle in advance, so it is derived as kickoff + 105 minutes. That is
// safe even if the match runs to extra time, because it is not the only finality check. The
// prop is bound to stat period 100 (full time), and TxLINE only ever emits a period-100 stat
// once the match is finalised: in-play batches are period 3 and 4. So a proof taken during
// extra time cannot settle this prop no matter what the clock says, and a genuine full-time
// proof always carries a batch that runs past kickoff + 105.

import anchor from '@coral-xyz/anchor';
import { SystemProgram } from '@solana/web3.js';
import {
  connect, maker, ORACLE, STAKE, FIXTURE, FINAL_WHISTLE, SPAIN_GOALS_KEY, FULL_TIME_PERIOD,
  propPdaFor, saveMarket, cluster, explorerTx, fixture, line, rule, sol,
} from './market.js';

const { BN } = anchor;

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const fixtureId = Number(arg('fixture') ?? FIXTURE);
const statKey = Number(arg('stat') ?? SPAIN_GOALS_KEY);
const threshold = Number(arg('threshold') ?? 2);

const m = maker();
const { conn, program } = connect(m);

const balance = await conn.getBalance(m.publicKey);
if (balance < STAKE.toNumber() + 5_000_000) {
  line(`Maker ${m.publicKey.toBase58()} has ${sol(balance)} SOL on ${cluster()}, needs ~${sol(STAKE.toNumber() + 5_000_000)}.`);
  process.exit(1);
}

// The semi-final is played and its whistle is known exactly. Anything else is derived.
let settleAfter = FINAL_WHISTLE;
let label = 'France v Spain, World Cup semi-final';
let subject = 'Spain total goals';

if (fixtureId !== FIXTURE) {
  const f = await fixture(fixtureId);
  settleAfter = Math.floor((f.startTime + 105 * 60_000) / 1000);
  label = `${f.home} v ${f.away}`;
  subject = `${statKey === 1 ? f.home : statKey === 2 ? f.away : `stat ${statKey}`} total goals`;
  if (f.finished) line(`  note: fixture ${fixtureId} is already finished. The outcome is known.\n`);
}

const nonce = new BN(Date.now());
const prop = propPdaFor(m.publicKey, nonce, program.programId);

rule();
line(`  OPEN MARKET · ${cluster()}`);
rule();
line(`  question   : "${subject} > ${threshold}"`);
line(`  fixture    : ${fixtureId}  ${label}`);
line(`  maker      : ${m.publicKey.toBase58()}  takes YES`);
line(`  stake      : ${sol(STAKE.toNumber())} SOL`);
line(`  settles    : not before ${new Date(settleAfter * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC`);
line(`  bound to   : stat ${statKey}, period ${FULL_TIME_PERIOD} (full time)`);
line('');

const sig = await program.methods
  .createProp(
    nonce,
    new BN(fixtureId),
    statKey,
    FULL_TIME_PERIOD,
    threshold,
    { greaterThan: {} },
    STAKE,
    new BN(settleAfter),
  )
  .accounts({ maker: m.publicKey, prop, oracle: ORACLE, systemProgram: SystemProgram.programId })
  .signers([m])
  .rpc();

saveMarket({
  nonce: nonce.toString(),
  prop: prop.toBase58(),
  cluster: cluster(),
  opened: new Date().toISOString(),
  fixtureId,
  statKey,
  threshold,
});

line(`  OK  prop open @ ${prop.toBase58()}`);
line(`      ${explorerTx(sig)}`);
line('');
line('  Next: npm run market:take');
