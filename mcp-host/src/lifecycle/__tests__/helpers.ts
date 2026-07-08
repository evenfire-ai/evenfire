/**
 * Shared test helpers for TaskLifecycle tests (A.4, A.5, A.6).
 *
 * Centralizes the Task constructor stub and event-listener helper so future
 * tests don't re-invent the typing (avoiding `as Task` / `as any` casts).
 */
import type { Task, TaskPriority, TaskSource } from '../../queue/types'
import type { CanonicalReason, TaskStatus, TransitionEvent } from '../types'

interface TaskOverrides {
  id?: string
  source?: TaskSource
  priority?: TaskPriority
}

export function buildTask(overrides: TaskOverrides = {}): Task {
  return {
    id: overrides.id ?? 't-test-' + Math.random().toString(36).slice(2, 8),
    source: overrides.source ?? 'internal',
    priority: overrides.priority ?? 'normal',
    status: 'pending',
    conversationHistory: [],
    createdAt: new Date(),
  }
}

/**
 * Tuple entry for the legal-transition matrix. Use with `it.each<LegalTransition>([...])`
 * to get full typechecking on the transitions table.
 */
export type LegalTransition = [from: TaskStatus, to: TaskStatus, reason: CanonicalReason]

/**
 * Collect TransitionEvents emitted by a TaskLifecycle. Returns the array
 * (mutated by the listener) for easy assertion.
 */
export function collectEvents(lc: {
  on: (e: 'transition', h: (ev: TransitionEvent) => void) => unknown
}): TransitionEvent[] {
  const events: TransitionEvent[] = []
  lc.on('transition', ev => events.push(ev))
  return events
}
