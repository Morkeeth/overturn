// Server-side TxLINE access.
//
// The whole reason this app has a backend: TxLINE's free tier is gated by an API token that
// was activated with an on-chain subscribe transaction. That token cannot go in a static page,
// because anyone reading the source could spend our quota. So the token lives in Vercel's env
// and only ever leaves this file as an answer.
//
// The guest JWT is short-lived and cheap to mint (POST /auth/guest/start, no credentials), and
// despite carrying a `maybeClientIp` claim it is not pinned to an IP: a token minted here, in a
// datacentre, reads fixtures fine. So we mint one on demand and cache it in module scope for as
// long as the lambda instance lives.

const API = 'https://txline.txodds.com';

let cached = { token: null, exp: 0 };

async function jwt() {
  const now = Date.now() / 1000;
  if (cached.token && cached.exp > now + 60) return cached.token;

  const r = await fetch(`${API}/auth/guest/start`, { method: 'POST' });
  if (!r.ok) throw new Error(`auth/guest/start ${r.status}`);
  const { token } = await r.json();
  if (!token) throw new Error('auth/guest/start returned no token');

  let exp = now + 600;
  try {
    exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp ?? exp;
  } catch {
    /* keep the conservative default */
  }
  cached = { token, exp };
  return token;
}

/** GET a TxLINE path with our credentials attached. Returns the raw Response. */
export async function txline(path) {
  const token = await jwt();
  const apiToken = process.env.WC_API_TOKEN;
  if (!apiToken) throw new Error('WC_API_TOKEN is not set on this deployment');
  return fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Api-Token': apiToken },
  });
}

/** TxLINE streams history as SSE text, even from the historical endpoint. */
export function parseSSE(text) {
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => {
      try {
        return JSON.parse(l.slice(6));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export const json = (res, status, body, cacheSeconds = 0) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Cache at the edge. Public nodes and TxLINE both rate-limit, and a judge refreshing
  // should not be able to exhaust either.
  res.setHeader(
    'Cache-Control',
    cacheSeconds ? `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 4}` : 'no-store',
  );
  res.status(status).send(JSON.stringify(body));
};
