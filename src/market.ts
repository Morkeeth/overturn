// Shared wiring for the escrow, used by `npm run demo` and by the step commands
// (market:open / take / settle / claim / status).
//
// The demo tells the whole story in one shot. The step commands are the same escrow
// driven one instruction at a time, which is what a human actually does: open a market,
// let someone take the other side, settle it when the match ends, collect.
//
// Cluster comes from RPC_URL, oracle from ORACLE. Defaults are devnet. Nothing here is
// cluster-specific, so the identical flow runs on mainnet by pointing both at mainnet.

import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const { BN } = anchor;

export const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
export const ORACLE = new PublicKey(process.env.ORACLE ?? '6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J');
export const API = 'https://txline.txodds.com';

export const FIXTURE = 18237038; // France v Spain, semi-final, 2026-07-14
export const FINAL_WHISTLE = 1784063054; // game_finalised, 21:04:14 UTC
export const SPAIN_GOALS_KEY = 2;
export const FULL_TIME_PERIOD = 100;
export const STAKE = new BN(0.05 * LAMPORTS_PER_SOL);

/** Which chain are we pointed at? Used for labels and explorer links, never for logic. */
export const cluster = () => (RPC.includes('devnet') ? 'devnet' : RPC.includes('mainnet') ? 'mainnet-beta' : 'custom');
export const explorerTx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}${cluster() === 'devnet' ? '?cluster=devnet' : ''}`;

export const kc = (s: string) =>
  execFileSync('security', ['find-generic-password', '-a', 'worldcup-agent', '-s', s, '-w'], { encoding: 'utf8' }).trim();

const mapProof = (a: any[]) => a.map((n) => ({ hash: Array.from(n.hash as number[]), isRightSibling: n.isRightSibling }));

export async function fetchProof(seq: number, fixtureId: number = FIXTURE) {
  const r = await fetch(`${API}/api/scores/stat-validation?fixtureId=${fixtureId}&seq=${seq}&statKeys=${SPAIN_GOALS_KEY}`, {
    headers: { Authorization: `Bearer ${kc('WC_JWT')}`, 'X-Api-Token': kc('WC_API_TOKEN') },
  });
  if (!r.ok) throw new Error(`proof ${fixtureId}/${seq}: ${r.status}`);
  return r.json() as any;
}

export const toPayload = (val: any) => ({
  ts: new BN(val.summary.updateStats.minTimestamp),
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
});

export const strategyFor = (threshold: number) => ({
  geometricTargets: [],
  distancePredicate: null,
  discretePredicates: [{ single: { index: 0, predicate: { threshold, comparison: { greaterThan: {} } } } }],
});

export const dailyScoresPda = (val: any, programId: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('daily_scores_roots'), new BN(Math.floor(val.summary.updateStats.minTimestamp / 86_400_000)).toBuffer('le', 2)],
    programId,
  )[0];

/** The YES side. Lives in the macOS Keychain, never on disk. */
export const maker = () => Keypair.fromSecretKey(bs58.decode(kc('WC_WALLET_SECRET')));

/**
 * The NO side, persisted to disk.
 *
 * This used to be Keypair.generate(). On devnet nobody notices. On mainnet the taker WINS
 * this prop (Spain scored 2, so "Spain > 2" is false) and claim() requires the winner's
 * signature, so an ephemeral taker takes the private key to the pot to its grave.
 */
const TAKER_PATH = 'taker-keypair.json';
export const taker = () => {
  if (fs.existsSync(TAKER_PATH)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(TAKER_PATH, 'utf8'))));
  const kp = Keypair.generate();
  fs.writeFileSync(TAKER_PATH, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
};

export function connect(wallet = maker()) {
  const conn = new Connection(RPC, 'confirmed');
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(wallet), { commitment: 'confirmed' });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync('./overturn_escrow/target/idl/overturn_escrow.json', 'utf8'));
  return { conn, provider, program: new anchor.Program(idl, provider) };
}

export const propPdaFor = (makerKey: PublicKey, nonce: InstanceType<typeof BN>, programId: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('prop'), makerKey.toBuffer(), nonce.toArrayLike(Buffer, 'le', 8)],
    programId,
  )[0];

// The step commands are separate processes, so the open command writes down which prop it
// made and the rest read it. Gitignored: it is local scratch, not state anyone else needs.
const MARKET_PATH = '.overturn-market.json';
export type Market = {
  nonce: string; prop: string; cluster: string; opened: string;
  // Which question this prop was opened on. The chain is authoritative; these are here so the
  // step commands and the watcher know what to fetch without asking the user twice.
  fixtureId?: number; statKey?: number; threshold?: number;
};

export const saveMarket = (m: Market) => fs.writeFileSync(MARKET_PATH, JSON.stringify(m, null, 2));
export const loadMarket = (): Market => {
  if (!fs.existsSync(MARKET_PATH)) {
    console.error('No open market. Run `npm run market:open` first.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(MARKET_PATH, 'utf8'));
};

/** Every World Cup fixture TxLINE knows about, soonest first. */
export async function fixtures() {
  const r = await txlineGet(`/api/fixtures/snapshot?startEpochDay=20648`);
  if (!r.ok) throw new Error(`fixtures ${r.status}`);
  const all = await r.json();
  return (Array.isArray(all) ? all : [])
    .filter((f: any) => f.Competition === 'World Cup')
    .map((f: any) => ({
      fixtureId: f.FixtureId,
      home: f.Participant1,
      away: f.Participant2,
      startTime: f.StartTime,
      finished: f.GameState === 3,
    }))
    .sort((a: any, b: any) => a.startTime - b.startTime);
}

export async function fixture(id: number) {
  const f = (await fixtures()).find((x: any) => x.fixtureId === id);
  if (!f) throw new Error(`fixture ${id} not found in the TxLINE snapshot`);
  return f;
}

/** The full event history for a fixture, newest last. TxLINE serves it as SSE text. */
export async function history(fixtureId: number) {
  const r = await txlineGet(`/api/scores/historical/${fixtureId}`);
  if (!r.ok) throw new Error(`history ${fixtureId}: ${r.status}`);
  const text = await r.text();
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .filter(Boolean) as any[];
}

export const txlineGet = (path: string) =>
  fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${kc('WC_JWT')}`, 'X-Api-Token': kc('WC_API_TOKEN') } });

export const line = (s = '') => console.log(s);
export const rule = () => line('-'.repeat(76));
export const sol = (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(4);
