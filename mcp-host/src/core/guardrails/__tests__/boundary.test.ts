/**
 * Boundary pipeline tests (spec §2, §4) — SKELETON.
 *
 * The pipeline is TODO(phase1); these `.todo` specs pin the behaviors the
 * implementation must satisfy. Convert each to a real test as `boundary.ts`
 * lands. See also `docs/features/mcp-host-guardrails/mcp-host-guardrails-spec.md`.
 */
import { describe, it } from 'vitest'

describe('GuardrailBoundary pipeline (Phase 1 TODO)', () => {
  it.todo(
    'runs Intake → pre contributors → aggregate → (approve) → execute at-most-once → post (§2)'
  )
  it.todo('deny aggregate blocks execution and returns a bounded denied outcome (§3)')
  it.todo('ask aggregate routes to the approval path; unattended with no resolver denies (§6.3)')
  it.todo('allow/no_decision proceeds; no_decision defers to the existing path unchanged (§3/§6.3)')

  // Rewrite re-aggregation (§4.1 / F8)
  it.todo('a pre rewrite re-validates and RESTARTS the pre chain against the final input (§4.1)')
  it.todo(
    'every rule evaluates the final rewritten input — no rule is bypassed by a later rewrite (§4.1)'
  )
  it.todo('each source rewrite is honored at most once; the chain restarts ≤ N times (§4.1)')
  it.todo('a rewrite failing re-validation is rejected rewrite_invalid, fail-closed (§4.1)')

  // At-most-once + resume (§4.2 / F10)
  it.todo('an approved call executes exactly once across suspend/retry/resume (§4.2)')
  it.todo('resume re-runs the declarative rules and denies if now stricter/missing (§4.2)')
})
