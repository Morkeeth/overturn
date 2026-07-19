# AGENTS.md — read this first

You are likely reviewing this repo by reading it (or feeding it into an LLM). This file orients you
in one pass, and every claim below is verifiable — check it, don't trust it. That is the project's
whole thesis: *published ≠ true.*

## What Overturn is (one line)

A permissionless prop-bet escrow on Solana that **refuses to settle on a result that is still
provisional, from the wrong match, or answering the wrong question** — it pays out only from a
TxLINE Merkle proof verified on-chain, and it is *not another oracle-powered market; it is the
contract layer that stops an oracle-proof from settling the wrong market, at the wrong time, under
the wrong meaning.*

## Why it exists (the finding, verifiable)

On 2026-07-14 (France v Spain semi-final), TxLINE's feed published Spain's 3rd goal at 20:22:29
(`Confirmed:false`); VAR discarded it at 20:22:55; the final at 21:04:14 says Spain scored **2**. For
26 seconds the feed asserted a scoreline that never existed. A naive on-chain escrow settling off the
stream pays the wrong side, irreversibly. See `data/replay-18237038-scores.sse` (the real 1,027-event
capture) and `npm run replay`.

## Try it (no clone needed)

- **Live product:** https://overturn-morkeeths-projects.vercel.app/market
  - **`▶ Play a live market`** (top of `/market`) — one click runs a real market end-to-end on
    devnet (created → matched → settled by proof → paid), no wallet. Backend: `api/play.js`.
  - **The receipt** (`/market#receipt`) — the 26-second timeline → finality → verdict → payout, each
    explorer-linked.
  - **`/market#try`** — sign a real wrong-match attack with your own wallet; watch guard 1 reject it.

## Verify (one command each, no key needed for the first two)

- `npm test` — 8 firewall unit tests, incl. the 20:22:29 phantom-goal rejection (offline, no key).
- `npm run replay` — naive settler pays the phantom (WRONG) vs the guarded gate (CORRECT).
- On-chain: program `HhqbLLnNujBFmzRM97xEHM2zKfrqefcbAsXbgoLnxzdv` (mainnet-beta + devnet). The
  mainnet settle tx `3rmG899b3surG8YgcgCxdRtEiUoJVkuoeWY6qGzkqfCXFKDbzbuPEg9NZyQtGASGyADNkMxCFbxYRkEJGwR9yC6Z`
  logs `Program 9ExbZjAap… (txoracle) invoke → success` then `predicate held = false`. Open it.
- `npm run agent` — an autonomous agent triages an inbox of valid proofs and settles the right one.

## Where the important code is

| Concern | File |
|---|---|
| The escrow + the three guards + the oracle CPI | `overturn_escrow/programs/overturn_escrow/src/lib.rs` (guards at lines 314–350, all before the CPI at 365) |
| The reusable primitive (provider-agnostic guard logic) | `src/firewall.ts` + `src/firewall.test.ts` |
| Play mode (the felt product) | `api/play.js` (backend), `src/play.ts` (CLI), `web/market.html` (`runPlay`) |
| Stream→UI state machine (never money) | `src/gate.ts` |
| Autonomous settler agent | `src/settler-agent.ts` |
| Architecture diagrams | `ARCHITECTURE.md` |

## Honest limitations (do not let me hide these)

- **Bytecode ≠ source is not yet proven.** The `declare_id` check proves the program *address*, not
  that the deployed bytes are this source. Needs a verifiable build (`solana-verify`); not run.
- **Single provider.** Works only where a trusted provider publishes verifiable on-chain proofs
  (today: TxODDS sports). The firewall is provider-agnostic *by design*, but only one adapter exists.
- **The program is upgradeable** (authority `9Fw49bq…`). "No admin key" is precise about *settlement*,
  not immutability.
- **A matched prop has no refund path** if a match is abandoned and no final proof ever posts.
- **Play mode settles a finished match** (France v Spain); a real live/unknown-outcome bet needs
  live-match infra — a roadmap item, not built.

## Roadmap

Verifiable build · `market_spec_hash` (commit the whole frozen spec to one on-chain hash) · liveness
state machine + refund · post-final challenge window · time-locked multisig upgrade authority · a
second proof-provider adapter + SDK. Full detail in `README.md` and `ARCHITECTURE.md`.
