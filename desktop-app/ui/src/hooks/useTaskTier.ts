import { useEffect, useState } from 'react'
import type { TaskState } from '@contexts/AgentTaskTrackerContext'

/** Elapsed-time UX tiers for an in-flight task (D.5b). */
export type TaskTier = 'T1' | 'T2' | 'T3' | 'T4' | 'T5'

export interface TierThresholds {
  /** age ≥ this → T2 (ms) */
  T2: number
  /** age ≥ this → T3 (ms) */
  T3: number
  /** age ≥ this → T4 (ms) */
  T4: number
  /** age ≥ this → T5 (ms) */
  T5: number
}

export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  T2: 30_000,
  T3: 120_000,
  T4: 300_000,
  T5: 900_000,
}

/** Pure classifier — exported for telemetry (tier at terminal) and testing. */
export function classifyTier(
  ageMs: number,
  thresholds: TierThresholds = DEFAULT_TIER_THRESHOLDS
): TaskTier {
  if (ageMs < thresholds.T2) return 'T1'
  if (ageMs < thresholds.T3) return 'T2'
  if (ageMs < thresholds.T4) return 'T3'
  if (ageMs < thresholds.T5) return 'T4'
  return 'T5'
}

/**
 * Tier of a task based on its ACTIVE age — how long the agent has been working,
 * not how long the user has been waiting. Recomputes every 5s (the user can't
 * perceive sub-5s tier boundaries — §6.2).
 *
 * Approval waits are excluded from the age in two complementary ways (§AC3),
 * because every T3+ nudge asserts the agent is busy:
 *  - the OPEN pause segment: while `status === 'suspended'` the clock freezes at
 *    `pausedAt`, so sitting at the gate never escalates the tier;
 *  - CLOSED segments: `pausedMs` (accumulated by the tracker on resume) is
 *    subtracted, so approving after a 10min wait resumes at the tier the work
 *    actually earned instead of jumping straight to T4/T5.
 */
export function useTaskTier(
  taskState: TaskState | undefined,
  thresholds: TierThresholds = DEFAULT_TIER_THRESHOLDS
): TaskTier {
  const [now, setNow] = useState(() => Date.now())

  const taskId = taskState?.taskId
  const status = taskState?.status
  const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled'

  // Depend on task identity + terminal-ness, NOT the mutable taskState object:
  // the tracker emits a fresh object on every SSE event, so `[taskState]` would
  // tear down + recreate the interval each event (and, if events arrive faster
  // than 5s, it would never fire → `now` frozen → tier stuck). Stop ticking once
  // terminal (the component renders nothing then anyway).
  useEffect(() => {
    if (!taskId || isTerminal) return
    const id = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(id)
  }, [taskId, isTerminal])

  if (!taskState) return 'T1'

  const effectiveNow =
    taskState.status === 'suspended' && taskState.pausedAt ? taskState.pausedAt : now
  const age = Math.max(0, effectiveNow - taskState.startedAt - (taskState.pausedMs ?? 0))
  return classifyTier(age, thresholds)
}
