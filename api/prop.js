// GET /api/prop?cluster=mainnet|devnet
//
// Reads the escrow's Prop account off Solana and decodes it. Server-side because
// api.mainnet-beta.solana.com answers a server fine but returns 403 to a browser origin,
// so doing this in the page means depending on whichever third-party node is up today.

import { json } from './_txline.js';

const PROGRAM = 'HhqbLLnNujBFmzRM97xEHM2zKfrqefcbAsXbgoLnxzdv';

const CLUSTERS = {
  mainnet: {
    rpcs: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'],
    prop: '9bifQAHTDMR5o5nLkdVoCXh3pmKApxkfBbu2QaeB94r9',
    oracle: '9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA',
    explorer: '',
  },
  devnet: {
    rpcs: ['https://api.devnet.solana.com'],
    prop: '38LzLkoyk6xMaFEFJ1jKyWNCLoe6qcUNrtvsQW3j4bUc',
    oracle: '6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J',
    explorer: '?cluster=devnet',
  },
};

const STATES = ['Open', 'Matched', 'Settled', 'Cancelled'];
const CMP = ['>', '<', '='];
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58enc(bytes) {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let s = '';
  for (const b of bytes) {
    if (b === 0) s += '1';
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i--) s += B58[digits[i]];
  return s;
}

/** Prop, as laid out in overturn_escrow/src/lib.rs, after Anchor's 8-byte discriminator. */
function decodeProp(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 8;
  const key = () => {
    const s = b58enc(buf.subarray(o, o + 32));
    o += 32;
    return s;
  };
  const maker = key();
  const taker = key();
  const oracle = key();
  const fixtureId = Number(dv.getBigInt64(o, true)); o += 8;
  const statKey = dv.getUint32(o, true); o += 4;
  const statPeriod = dv.getInt32(o, true); o += 4;
  const threshold = dv.getInt32(o, true); o += 4;
  const comparison = dv.getUint8(o); o += 1;
  const stake = Number(dv.getBigUint64(o, true)); o += 8;
  const settleAfter = Number(dv.getBigInt64(o, true)); o += 8;
  const state = dv.getUint8(o); o += 1;
  const yesWon = dv.getUint8(o) === 1;
  return { maker, taker, oracle, fixtureId, statKey, statPeriod, threshold, comparison, stake, settleAfter, state, yesWon };
}

async function rpc(urls, params) {
  let last;
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

export default async function handler(req, res) {
  const name = String(req.query.cluster || 'mainnet');
  const c = CLUSTERS[name];
  if (!c) return json(res, 400, { error: 'cluster must be mainnet or devnet' });

  try {
    const result = await rpc(c.rpcs, [c.prop, { encoding: 'base64', commitment: 'confirmed' }]);
    if (!result?.value) return json(res, 404, { error: 'prop account not found', cluster: name, prop: c.prop });

    const raw = Buffer.from(result.value.data[0], 'base64');
    const p = decodeProp(raw);
    const pot = p.stake * 2;

    return json(
      res,
      200,
      {
        cluster: name,
        program: PROGRAM,
        prop: c.prop,
        explorerSuffix: c.explorer,
        asOf: new Date().toISOString(),
        // Raw account fields first: `state` and `comparison` stay the integers the chain
        // stores, because the page decodes them the same way whether it reads us or the RPC
        // directly. Labels are additive, never a replacement (spreading p after the labels
        // silently overwrote them with the ints).
        ...p,
        stateLabel: STATES[p.state] ?? 'Unknown',
        comparisonLabel: CMP[p.comparison] ?? '?',
        pot,
        heldLamports: result.value.lamports,
        // The PDA keeps its own rent forever, so holding lamports is not holding the pot.
        potClaimed: result.value.lamports < pot,
      },
      10,
    );
  } catch (e) {
    return json(res, 502, { error: String(e.message || e), cluster: name });
  }
}
