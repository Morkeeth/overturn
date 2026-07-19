# Overturn — architecture

Three views, in the order a judge should read them: **what moves money** (the guarded
settle path), **the prop's life** (its states), and **the why** (the whole thesis on one
page). Everything below is enforced in
[`overturn_escrow/programs/overturn_escrow/src/lib.rs`](overturn_escrow/programs/overturn_escrow/src/lib.rs).

## 1 · The two lanes — a stream that can only light a UI, and a proof that can move money

The feed is never trusted with funds. The only path to money is a Merkle proof that clears
three guards **before** the oracle is ever asked, checked against a prop frozen before kickoff.

```mermaid
flowchart TB
    FROZEN["Prop frozen at create_prop<br/>fixture · stat · threshold · comparison<br/>oracle · settle_after<br/>(pinned before anyone knows the result)"]

    subgraph OFF["OFF-CHAIN — never moves money"]
        direction TB
        SSE["TxLINE SSE stream<br/>(live scores, provisional)"]
        GATE["gate.ts state machine<br/>PENDING → PROVISIONAL → RETRACTED"]
        UI["Web UI · /story · /market"]
        SSE --> GATE --> UI
    end

    subgraph ON["ON-CHAIN — the only path to money"]
        direction TB
        PROOF["TxLINE Merkle proof<br/>(stat-validation endpoint)"]
        subgraph ESC["overturn_escrow::settle — permissionless, no keeper, no admin over settlement"]
            direction TB
            G1{"GUARD 1<br/>fixture binding"}
            G2{"GUARD 2<br/>finality"}
            G3{"GUARD 3<br/>predicate binding"}
        end
        CPI["CPI → txoracle::validate_stat_v2<br/>(verifies proof against the anchored root)"]
        MONEY["Funds released to the winner"]

        PROOF --> G1
        G1 -->|"proof from another match"| R1["REJECT · no money"]
        G1 -->|pass| G2
        G2 -->|"non-final / half-time proof"| R2["REJECT · no money"]
        G2 -->|pass| G3
        G3 -->|"settler swapped the question"| R3["REJECT · no money"]
        G3 -->|pass| CPI
        CPI -->|"oracle verdict: true / false"| MONEY
    end

    FROZEN -.->|checked against| G1
    FROZEN -.-> G2
    FROZEN -.-> G3

    classDef reject fill:#f8d7da,stroke:#c0392b,color:#111;
    classDef money fill:#d4edda,stroke:#218c53,color:#111;
    classDef frozen fill:#e7e0f7,stroke:#6c5ce7,color:#111;
    class R1,R2,R3 reject;
    class MONEY money;
    class FROZEN frozen;
```

The three guards are the difference between *"we verified a proof"* and *"we settled
correctly."* A valid proof still answers whatever question you ask it, about whatever match
you hand it. Guards 1–3 run on plaintext that was frozen before kickoff, so the caller has
no discretion left by the time the oracle is asked.

## 2 · The prop's life — nothing exits `Matched` except a proof

```mermaid
stateDiagram-v2
    [*] --> Open: create_prop<br/>maker funds YES, freezes the question
    Open --> Matched: take_prop<br/>taker funds NO, pot now unspendable by hand
    Open --> Cancelled: cancel<br/>no taker → maker refunded
    Matched --> Settled: settle<br/>proof clears guards 1/2/3 + oracle verdict
    Settled --> [*]: claim<br/>winner withdraws the pot
    note right of Matched
        No keeper. No admin.
        The only way out is a
        proof that clears the guards.
    end note
```

## 3 · The whole thesis on one page

```mermaid
mindmap
  root((Overturn))
    The problem
      Jul 14 semi-final France v Spain
      feed published Spain's 3rd goal
      Confirmed false, VAR review
      retracted 26 seconds later
      final record Spain scored 2
      published is not the same as true
      naive escrow pays the wrong side, irreversibly
    The insight
      verifying a proof is necessary
      but nowhere near sufficient
      a valid proof answers whatever you ask it
    The three guards
      1 fixture binding
        blocks a real proof from another match
      2 finality
        blocks a half-time proof settling early
      3 predicate binding
        blocks the settler swapping the question
    The design
      no keeper and no admin over settlement
      stream drives the UI, proof drives the money
      permissionless settle, zero caller discretion
      CPI into txoracle validate_stat_v2
    Proven
      live on mainnet-beta and devnet
      0.1 SOL settled the correct side
      every transaction on the explorer
```

## Where each piece lives

| Concern | File |
|---|---|
| Escrow, the three guards, the CPI | `overturn_escrow/programs/overturn_escrow/src/lib.rs` |
| Stream → UI state machine (never money) | `src/gate.ts` |
| Naive-vs-guarded replay on the real semi-final | `src/replay.ts` |
| Ask the real mainnet oracle about the phantom | `src/verify.ts` |
| One-instruction-at-a-time escrow driver | `src/market-*.ts` |
