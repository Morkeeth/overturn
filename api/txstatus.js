// GET /api/txstatus?sig=<signature>
//
// Confirms a devnet transaction server-side and returns its result. The browser used to poll
// api.devnet.solana.com's getSignatureStatuses up to 30 times, and from a browser IP that public
// node rate-limits hard, so the sandbox just spun on "Waiting for the cluster…". One call to this
// endpoint instead: the server polls (where it isn't throttled the same way) and returns the
// verdict — including which guard rejected it, decoded from the program's custom error code.

import { json } from './_txline.js';

const RPC = 'https://api.devnet.solana.com';

// The program's custom errors, verbatim from the IDL (kept in sync with web/market.html ERRORS).
const ERRORS = {
  6000: 'prop is not open for taking',
  6001: 'prop is not matched',
  6002: 'maker cannot take their own prop',
  6003: 'too early: the match is not over yet',
  6004: 'GUARD 1: proof is for a different fixture',
  6005: 'GUARD 2: proof batch does not cover the end of the match',
  6006: 'GUARD 3: submitted strategy does not match the predicate this prop was created with',
  6007: 'proof is for a different stat than this prop',
  6008: 'oracle account does not match the one this prop was bound to',
  6009: 'oracle returned no data',
  6010: 'prop is not settled',
  6011: 'caller is not the winner',
};

async function statusOnce(sig) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses',
      params: [[sig], { searchTransactionHistory: true }],
    }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return j?.result?.value?.[0] ?? null;
}

export default async function handler(req, res) {
  const sig = String(req.query.sig || '');
  if (!sig) return json(res, 400, { error: 'sig required' });

  for (let i = 0; i < 8; i++) {
    let st = null;
    try { st = await statusOnce(sig); } catch { /* keep polling */ }
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
      const code = st.err?.InstructionError?.[1]?.Custom ?? null;
      return json(res, 200, {
        found: true,
        ok: !st.err,
        reason: st.err ? (ERRORS[code] ?? (code != null ? 'error ' + code : 'the transaction failed')) : null,
      });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return json(res, 200, { found: false });
}
