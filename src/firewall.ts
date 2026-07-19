// The settlement firewall.
//
// The reusable primitive, extracted from the escrow: given a proof and the question a market
// FROZE at creation, decide whether that proof is ALLOWED to settle it — before any oracle
// value is trusted. "Published != true, and true-about-something-else != true-about-this."
//
// It is deliberately provider-agnostic. The guards operate on an abstract `ProofClaim`, not on
// any one feed's wire format. TxODDS is the first adapter (see `txoddsClaim` below); any
// provider that can produce a ProofClaim — a price oracle, an insurance attestor, an auditor —
// plugs into the same three guards. Tonight there is exactly one adapter, wired to real
// TxODDS sports proofs on mainnet. The generalization is the architecture, not a claim that
// other providers are integrated yet.
//
// The on-chain escrow (overturn_escrow::settle) enforces the same three checks. This module is
// the same discipline as a standalone, importable gate — so an autonomous agent can refuse a
// bad proof BEFORE it spends gas submitting a transaction the chain would reject anyway.

export type Comparison = 'greaterThan' | 'lessThan' | 'equalTo';

/** The question a market froze at creation. The firewall holds every proof to exactly this. */
export interface FrozenQuestion {
  subjectId: number;      // which match/event — the subject the proof must be about
  statKey: number;        // which stat
  period: number;         // which period (100 = full time)
  threshold: number;      // the predicate
  comparison: Comparison;
  settleAfterMs: number;  // the finality bar: the proof's batch must reach at least here
  label: string;
}

/** What any proof provider must produce for the firewall to judge it. Provider-agnostic. */
export interface ProofClaim {
  source: string;              // which adapter produced this (e.g. "txodds")
  subjectId: number;           // the match/event this proof is about
  statKey: number;
  period: number;
  batchMaxTimestampMs: number; // the end of the window this proof's batch covers
  label: string;
}

export interface GuardVerdict { guard: string; pass: boolean; detail: string; }
export interface FirewallResult { admit: boolean; verdicts: GuardVerdict[]; refusedBy: string | null; }

const iso = (ms: number) => new Date(ms).toISOString().slice(11, 19) + ' UTC';

/**
 * Run every guard. `admit` is true only if all pass. The verdicts are the audit trail: the
 * reason a proof was refused is the product, so it is always spelled out, never a bare boolean.
 */
export function firewall(claim: ProofClaim, q: FrozenQuestion): FirewallResult {
  const verdicts: GuardVerdict[] = [
    {
      guard: 'GUARD 1 · subject binding',
      pass: claim.subjectId === q.subjectId,
      detail: claim.subjectId === q.subjectId
        ? `proof is for subject ${claim.subjectId} — the one frozen`
        : `proof is for subject ${claim.subjectId}, not ${q.subjectId} — a valid proof, wrong match`,
    },
    {
      guard: 'GUARD 2 · finality',
      pass: claim.batchMaxTimestampMs >= q.settleAfterMs,
      detail: claim.batchMaxTimestampMs >= q.settleAfterMs
        ? `batch reaches ${iso(claim.batchMaxTimestampMs)}, at or past the frozen settle bar`
        : `batch ends ${iso(claim.batchMaxTimestampMs)}, before full time — honest but premature`,
    },
    {
      guard: 'GUARD 3 · stat/predicate binding',
      pass: claim.statKey === q.statKey && claim.period === q.period,
      detail: claim.statKey === q.statKey && claim.period === q.period
        ? `stat ${claim.statKey} period ${claim.period} matches the frozen question`
        : `stat ${claim.statKey}/${claim.period} answers a different question than ${q.statKey}/${q.period}`,
    },
  ];
  const refused = verdicts.find((v) => !v.pass) ?? null;
  return { admit: !refused, verdicts, refusedBy: refused ? refused.guard : null };
}

// ---------------------------------------------------------------------------
// adapters/txodds — turn a real TxLINE stat-validation proof into a ProofClaim.
// This is the ONLY provider-specific code. A second provider is a second function this shape.
// ---------------------------------------------------------------------------
export function txoddsClaim(val: any, label: string): ProofClaim {
  const stat = val.statsToProve?.[0] ?? {};
  return {
    source: 'txodds',
    subjectId: Number(val.summary.fixtureId),
    statKey: Number(stat.key),
    period: Number(stat.period),
    batchMaxTimestampMs: Number(val.summary.updateStats.maxTimestamp),
    label,
  };
}
