# Overturn

**A prop-bet escrow that cannot pay out on a goal that didn't happen.**

TxODDS x Solana World Cup Hackathon · Prediction Markets & Settlement track

**Live page:** https://morkeeth.github.io/overturn/ (no wallet, no install)
**Program:** [`HhqbLLnNujBFmzRM97xEHM2zKfrqefcbAsXbgoLnxzdv`](https://explorer.solana.com/address/HhqbLLnNujBFmzRM97xEHM2zKfrqefcbAsXbgoLnxzdv?cluster=devnet) on Solana devnet

---

## The problem

On 2026-07-14, in the World Cup semi-final France v Spain, TxLINE's live score feed published
Spain's third goal at **20:22:29** with `Confirmed:false`. The scoreline moved to 0-3. VAR reviewed
it. At **20:22:55** the event was `action_discarded` and **the score reverted**. The `game_finalised`
record at 21:04:14 confirms Spain scored **two**.

**For 26 seconds, the feed asserted a scoreline that never existed.**

The hackathon brief suggests using *"the SSE Stream to dynamically trigger prediction resolutions"*,
and labels the proof layer *"Optional"*. An escrow built that way releases funds during those 26
seconds, on a goal that does not exist, and on-chain that cannot be undone.

This is not a hypothetical. It is in the data, and this repo replays it.

```
20:22:29  goal              Confirmed: false   Spain 3   <- published
20:22:41  var                                  Spain 3   <- under review, still standing
20:22:55  action_discarded                     Spain 2   <- withdrawn, score reverts
21:04:14  game_finalised                       Spain 2   <- final. It was never 3.
```

## Verifying the proof is necessary and nowhere near sufficient

TxODDS built the proof layer correctly: Merkle roots are anchored from *corrected* data, so the
phantom is not provable on-chain. We checked, against mainnet:

```
mainnet says: FALSE  <-  Spain goals > 2   (the phantom third goal: did it happen?)
mainnet says: TRUE   <-  Spain goals > 1   (control: they really did score 2)
```

So the danger was never the cryptography. It is everything around it:

**1 · The keeper.** Most escrows will have a backend listening to SSE that calls `settle()`. That
keeper is the vulnerability. `overturn_escrow` has **no keeper and no admin key**. The only path to
moving money is a Merkle proof verified on-chain by CPI into `validate_stat_v2`.

**2 · The question.** A valid proof answers *whatever question you ask it*. Our prop is
"Spain goals > 2" is false, so the NO side wins. An attacker holding YES submits **the same honest,
valid, final proof**, with the strategy changed to "Spain goals > 1", which is true. The oracle answers
honestly. The attacker takes the pot. **No forgery, no phantom.** Any escrow that forwards a
caller-supplied strategy to the oracle is drainable this way.

**3 · The batch.** TxLINE proofs are batch-scoped (e.g. 20:21:18 → 20:24:59). A half-time proof
proves the half-time score, honestly, and would settle a full-match prop before the winning goal
exists.

## The three guards

`settle()` is permissionless: anyone may call it, because the caller has no discretion:

| Guard | Blocks | Error |
|---|---|---|
| **1 · Fixture binding** | a valid proof from a different match | `FixtureMismatch` |
| **2 · Finality** | an honest half-time proof settling a full-match prop early | `ProofNotFinal` |
| **3 · Predicate binding** | the settler swapping the question to one they win | `PredicateMismatch` |

Every input is checked against state frozen at creation, before anyone knew the answer. The verdict
comes from the oracle, not the caller.

## Run it

```bash
npm install

npm run replay   # the Jul-14 semi through a naive settler and the guarded gate
npm run verify   # ask TxLINE's real mainnet oracle whether the phantom goal happened
npm run demo     # the escrow: three attacks with genuine proofs, one honest settlement
```

`replay` needs nothing. `verify` and `demo` need a TxLINE subscription (see below).

Demo output, against the live devnet program. One attack per guard, attack N fires guard N:

```
ATTACK 1  real final proof from the OTHER semi-final (England v Argentina)
     -> REJECTED: GUARD 1: proof is for a different fixture
ATTACK 2  half-time proof (Spain had 1 goal at HT) to settle early
     -> REJECTED: GUARD 2: proof batch does not cover the end of the match
ATTACK 3  honest final proof, but asks "Spain > 1" instead of "> 2"
     -> REJECTED: GUARD 3: submitted strategy does not match the predicate this prop was created with
SETTLE    final proof (period 100), predicate "Spain > 2"
     -> SETTLED

chain says: "Spain total goals > 2" = FALSE
winner    : TAKER (NO)      correct: Spain scored 2, the prop was false
```

Attack 1 is the one worth pausing on. That proof is real, unforged, and shaped exactly like the one
that settles: same stat key, same period, batch running past the final whistle. It clears guards 2
and 3. It is rejected only because England v Argentina is not this match. Delete guard 1 and it
settles a France v Spain prop on Argentina's scoreline.

None of the three rejections reach the oracle. The guards run before the CPI, so the escrow refuses
to verify a proof it has no business verifying. Only the settlement asks TxLINE anything.

## Judges: no wallet needed

**Live page: https://morkeeth.github.io/overturn/**

TxLINE's free tier requires an on-chain subscribe transaction, so reproducing this from scratch would
otherwise cost you a wallet and a subscription. It doesn't. The page is **self-contained**: the data
was fetched once with our subscription and frozen into it. No server, no key, no wallet, no install.
Open the link.

It is also insurance: `/api/scores/historical` serves only a two-week window, so this match ages out
of the API around 28 July, the day before judging.

## Deployed

`overturn_escrow` is live on **Solana devnet**. Nothing here asks you to take that on trust.

| | |
|---|---|
| Program ID | `HhqbLLnNujBFmzRM97xEHM2zKfrqefcbAsXbgoLnxzdv` |
| Cluster | devnet |
| Explorer | https://explorer.solana.com/address/HhqbLLnNujBFmzRM97xEHM2zKfrqefcbAsXbgoLnxzdv?cluster=devnet |
| Deploy tx | `5woQBTBwb8FogJBSqLFD56w1NGAig4kbxDYkD7aYmFsyUANnRJisuBi7xnd7hcFgMuzav3JycUo4LvtUwurbbRW3` |
| Upgrade authority | `9Fw49bq19uVFHHHubNSpdn3ZQGy9nFSaJeLEdDbSDK1s` |

Verify the deployed address is the one the source claims:

```
solana program show HhqbLLnNujBFmzRM97xEHM2zKfrqefcbAsXbgoLnxzdv --url devnet
grep declare_id overturn_escrow/programs/overturn_escrow/src/lib.rs
```

Both print `HhqbLLnNujBFmzRM97xEHM2zKfrqefcbAsXbgoLnxzdv`, and the on-chain account reports
`Executable: true` at `207712` bytes. A deploy log proves we published a program. The check above
proves it is *this* program. That distinction is the whole project.

## TxLINE endpoints used

| Endpoint | Use |
|---|---|
| `POST /auth/guest/start` | guest JWT (30-day expiry, pins client IP) |
| `POST /api/token/activate` | API token after the on-chain subscribe (returns `text/plain`, not JSON) |
| `GET /api/scores/historical/{fixtureId}` | the 1,027-event replay of the semi-final |
| `GET /api/scores/stream` | live SSE watcher |
| `GET /api/scores/stat-validation` | Merkle proofs (`fixtureId`, `seq`, `statKeys`) |
| `GET /api/odds/snapshot/{fixtureId}?asOf=` | historical demargined odds (used to measure the market blackout) |
| `GET /api/fixtures/snapshot?startEpochDay=` | fixture discovery |
| on-chain `txoracle::validate_stat_v2` | CPI'd by `overturn_escrow::settle` |
| on-chain `txoracle::subscribe` | service level 12, 4 weeks, free tier |

## Notes for TxODDS (things we found the hard way)

Offered as genuine feedback, not complaint. The data layer is good; the docs are behind it.

- **`/api/scores/historical/{id}` returns SSE framing** (`data: {...}`), not the JSON array the
  docs imply. Silently breaks `JSON.parse`.
- **`var` records ship a `Score` payload with no `Goals` key.** Read naively, a match reads 0-0
  mid-review. Worth documenting, since anyone rendering a live scoreboard will hit it.
- **Service level 12 is free *and* real-time** (price 0, sampling 0 in the on-chain PricingMatrix),
  but the official example `subscription_free_tier.ts` uses level 1, which is 60s-delayed. Most
  people will ship the delayed feed without knowing a free real-time tier exists.
- `llms.txt` is served from `txline-docs.txodds.com`, not `txline.txodds.com` (404 there), though
  every page's own banner points at the latter.
- The odds overview says *"generate an API key instantly"* and *"access is entirely permissionless"*.
  There is no path to a key without an on-chain subscribe tx. That sentence cost us time.
- `/api-reference/odds` (linked from the odds page) is a 404.
- `POST /api/guest/purchase/quote` returns **500** on an invalid pubkey where the spec documents 400.
- **The listing and the T&C contradict each other** on AI agents (§5) and on winning multiple prizes
  (FAQ vs §8). Worth reconciling before judging.

## Architecture

```
TxLINE SSE stream ──> gate.ts (state machine) ──> UI only. Never money.
                                                   PENDING -> PROVISIONAL -> RETRACTED
TxLINE Merkle proof ──> overturn_escrow::settle ──CPI──> txoracle::validate_stat_v2 -> bool
                              │                                                        │
                              └── guards 1/2/3 ───────────────────────────────────────┘
                                     │
                                     └──> funds released, or not
```

| File | Role |
|---|---|
| `programs/overturn_escrow/src/lib.rs` | the escrow + the three guards + the CPI |
| `src/gate.ts` | the settlement state machine (stream drives UI, proof drives money) |
| `src/feed.ts` | TxLINE score-feed types + SSE parsing |
| `src/replay.ts` | naive vs guarded, on the real semi-final |
| `src/verify.ts` | asks the real mainnet oracle about the phantom |
| `src/demo.ts` | escrow lifecycle: create, take, two attacks, settle |
| `src/live.ts` | live SSE watcher |
| `web/index.html` | judge-facing page, self-contained, no wallet |

## Reference

- Mainnet oracle `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` · devnet `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`
- `daily_scores_roots` PDA = `["daily_scores_roots", epochDay as u16 LE]`; Jul 14 = epochDay 20648
- Root anchoring lag measured at **1.4 min** after the final whistle
- `period 100` = full time. Stat keys: 1 = P1 goals, 2 = P2 goals, 7/8 = corners
- `validate_stat_v2` needs a 1.4M compute-unit budget

## Licence

MIT
