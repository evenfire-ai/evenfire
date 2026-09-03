/**
 * Guardrail engine — lane-neutral core contracts.
 *
 * Spec: docs/features/mcp-host-guardrails/mcp-host-guardrails-spec.md §2–§4.
 * Phase 1 scaffold: these contracts are stable; several implementations are
 * marked TODO(phase1) in sibling files.
 */

/** The four-valued decision (spec §3). Strictness: deny > ask > allow > no_decision. */
export type Decision = 'deny' | 'ask' | 'allow' | 'no_decision'

/** Phase of a contributor (spec §2.1). */
export type ContributorPhase = 'pre' | 'post'

/** Where a contribution came from (spec §2.1). `current` = the existing approval path. */
export type ContributorSource = 'admin_rule' | 'host_rule' | 'hook' | 'validator' | 'current'

/** Admin-granted hook capabilities (spec §4.3). */
export type Capability = 'may_deny' | 'may_rewrite' | 'may_substitute_result' | 'may_add_context'

/**
 * Bounded, redacted audit payload carried by a contribution (spec §2.1).
 * Fields serve different surfaces and MUST NOT be copied across surfaces
 * without explicit redaction (spec §12.4 / F14).
 */
export interface ContributorAudit {
  modelReason?: string
  userReason?: string
  details?: Record<string, unknown>
}

/**
 * The unit every guardrail source produces (spec §2.1). Generic over the lane's
 * `Input` (e.g. tool arguments) and `Result` (e.g. the tool result).
 */
export interface Contributor<Input, Result> {
  phase: ContributorPhase
  source: ContributorSource
  /** Stable configured id. */
  sourceId: string
  decision: Decision
  /** Bounded per-lane reason-code enum (spec §9). */
  reasonCode: string
  /** Full replacement of the input (pre only). Honored only with `may_rewrite`. */
  rewrite?: Input
  /** Caller-visible result substitute. Honored only with `may_substitute_result`. */
  substitute?: Result
  audit?: ContributorAudit
}

/** Outcome of aggregating contributions over one boundary pass (spec §3). */
export interface AggregateOutcome<Input, Result> {
  decision: Decision
  /** The presentation reason code (tie-break for display only — spec §3). */
  reasonCode: string
  /** The effective input after any honored rewrites (spec §4.1). */
  effectiveInput: Input
  /** A gated substitute result, if any (spec §4.3). */
  substitute?: Result
  /** All contributions, retained for audit (spec §3). */
  contributions: Array<Contributor<Input, Result>>
}

/**
 * A source of pre/post contributions for a boundary (rules, hooks, validators).
 * The tool lane supplies a rules-backed implementation (spec §6); Phase 2 adds
 * installed hooks (spec §8).
 */
export interface Contributors<Input, Result, Identity> {
  pre(input: Input, identity: Identity): Promise<Array<Contributor<Input, Result>>>
  post(result: Result, identity: Identity): Promise<Array<Contributor<Input, Result>>>
}

/** What a boundary returns to its caller. */
export type BoundaryOutcome<Result> =
  | { kind: 'executed'; result: Result }
  | { kind: 'denied'; reasonCode: string }
  | { kind: 'ask'; reasonCode: string }

/**
 * The lane-neutral guardrail boundary (spec §2). A lane specializes it over its
 * own `Input`/`Result`/`Identity` types. `execute` runs the guarded call
 * at-most-once (spec §4.2) only when the aggregate permits it.
 */
export interface GuardrailBoundary<Input, Result, Identity> {
  guard(args: {
    identity: Identity
    input: Input
    execute: (effectiveInput: Input) => Promise<Result>
  }): Promise<BoundaryOutcome<Result>>
}
