// The curated betting board: props opened by the maker and left OPEN for a taker.
//
// These are real devnet markets on real upcoming World Cup fixtures. The maker has staked the
// YES side of each; a visitor takes the NO side with their own wallet. After the match, anyone
// settles it from a TxLINE proof and the winner collects. Nothing here is simulated.
//
// The addresses are pinned; everything describing them (teams, the bet in words, state) is read
// live, so a label can never drift from what the chain actually holds.

export const BOARD = [
  // The Spain v Argentina final (Sun) first: the biggest match, a mix of lines.
  'MQyVX77jPXQRCfHnpTfeMAXhtou3YK2TqD65VkKTMQ6', // Spain > 1  -> back: Spain score 1 or fewer
  '7MBPXFrSRSCpgCkBF6BnnFPzdAifyeRxMY9FjkY7zpUK', // Argentina > 1 -> back: Argentina score 1 or fewer
  'A9pGPykmsM18oeoFo7y1o6CTJX3X1jyW3qDGYM4uXdGY', // Spain > 2 -> back: Spain score 2 or fewer (the favourite)
  '6GZYsCDFNpi27rJx6VPMbFq467z86KWP23yutwM9ud94', // Spain > 0 -> back: Spain fail to score (the longshot)
  // France v England (Sat).
  '4d84rM1mv5tVjk28JSVjZz8HjyCoWvXpwefDLrf27wAy', // France > 1 -> back: France score 1 or fewer
  '9yHVpBHyQicpeFzxJeqCyX3mB37NJeDaKCuLj5HjR2oy', // England > 0 -> back: England fail to score
  'FUxBj8qs6YX9efCZtqvjP2wyeDH1T7UFqE2sTQ7U5rPk', // France > 0 -> back: France fail to score
  'HUHWtQsSuMy7MV2v3gzh9znDDpJwLAhyuFYNTxbf1crN', // England > 1 -> back: England score 1 or fewer (already matched)
];

export const DEVNET_RPCS = ['https://api.devnet.solana.com', 'https://solana-rpc.publicnode.com'];
export const STATES = ['Open', 'Matched', 'Settled', 'Cancelled'];
export const CMP = ['>', '<', '='];

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58enc(bytes) {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let s = '';
  for (const b of bytes) { if (b === 0) s += '1'; else break; }
  for (let i = digits.length - 1; i >= 0; i--) s += B58[digits[i]];
  return s;
}

/** Prop, as laid out in overturn_escrow/src/lib.rs, after Anchor's 8-byte discriminator. */
export function decodeProp(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 8;
  const key = () => { const s = b58enc(buf.subarray(o, o + 32)); o += 32; return s; };
  const maker = key(), taker = key(), oracle = key();
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

export async function rpc(urls, method, params) {
  let last;
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}

/**
 * The two sides of a prop, in plain football English, derived from the real fields.
 * The maker holds YES (stat > threshold). The taker holds NO (stat <= threshold).
 * statKey 1 is the home team's goals, 2 is the away team's.
 */
export function describe(p, home, away) {
  const team = p.statKey === 1 ? home : p.statKey === 2 ? away : `stat ${p.statKey}`;
  const yes = `${team} ${CMP[p.comparison]} ${p.threshold} goals`;
  // The taker's bet, phrased as the thing they are backing.
  let takerBet;
  if (p.comparison === 0) {
    // maker: team > threshold. taker: team <= threshold.
    takerBet = p.threshold === 0 ? `${team} fail to score` : `${team} score ${p.threshold} or fewer`;
  } else {
    takerBet = `not (${yes})`;
  }
  return { yes, takerBet, team };
}
