/**
 * Doom-loop guard (spec §6.4).
 *
 * Within one task, three consecutive identical `(resolved tool, effective-input
 * digest)` calls → `deny (repeated_identical_call)`. Any intervening different
 * tool or input resets the counter; the counter is persisted with task state.
 *
 * This is a best-effort RUNAWAY/cost guard, NOT a security control — alternating
 * calls evade it (spec §6.4 / N12). The tool-lane rules are the real control.
 *
 * TODO(phase1): implement the per-task counter + persistence hook.
 */

const LIMIT = 3

export interface DoomLoopState {
  lastKey?: string
  count: number
}

/**
 * Record a call and report whether it trips the guard. `key` is
 * `hash(resolvedTool + effectiveInputDigest)`.
 *
 * TODO(phase1): wire persistence with task state; this is the pure transition.
 */
export function recordAndCheck(
  state: DoomLoopState,
  key: string
): { tripped: boolean; state: DoomLoopState } {
  const count = state.lastKey === key ? state.count + 1 : 1
  const next: DoomLoopState = { lastKey: key, count }
  return { tripped: count >= LIMIT, state: next }
}
