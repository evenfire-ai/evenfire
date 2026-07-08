import { RecipePhase } from '../types'

/**
 * Custom error for invalid state transitions.
 */
export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: RecipePhase,
    public readonly action: string
  ) {
    super(`Invalid transition: cannot apply "${action}" from state "${from}"`)
    this.name = 'InvalidTransitionError'
  }
}

/**
 * Canonical transition map.
 * Source of truth: WORKLOADRECIPE-SPEC §12.1
 *
 * Format: { [fromState]: { [action]: toState } }
 *
 * Terminal states (deprecated, rollback-failed) have NO outgoing transitions.
 *
 * Deviations from spec (intentional):
 * - rolling-back → candidate (via "rollback-success"):
 *   Spec says rolling-back → failed ("original state unrecoverable").
 *   Code allows retry after successful rollback — more practical for operators
 *   who want to fix the recipe and redeploy. Documented decision, not a bug.
 */
const TRANSITIONS: Record<RecipePhase, Record<string, RecipePhase>> = {
  candidate: {
    approve: 'approved',
    'request-approval': 'pending-approval',
  },
  'pending-approval': {
    approve: 'approved',
    deprecate: 'deprecated',
  },
  approved: {
    queue: 'pending',
    'request-input': 'pending-operator-input',
    deploy: 'deploying',
  },
  pending: {
    deploy: 'deploying',
  },
  'pending-operator-input': {
    deploy: 'deploying',
  },
  deploying: {
    'test-pass': 'testing',
    degrade: 'degraded',
    rollback: 'rolling-back',
  },
  testing: {
    success: 'active',
    fail: 'rolling-back', // Spec §12.1: testing failure triggers rollback
  },
  active: {
    deprecate: 'deprecated',
    degrade: 'degraded',
    rollback: 'rolling-back',
  },
  degraded: {
    recover: 'active',
    rollback: 'rolling-back',
    fail: 'failed',
  },
  'rolling-back': {
    'rollback-success': 'candidate', // See deviation note above
    fail: 'failed',
    'critical-fail': 'rollback-failed',
  },
  failed: {
    retry: 'candidate',
  },
  deprecated: {},
  'rollback-failed': {},
}

/**
 * Execute a state transition.
 *
 * @throws InvalidTransitionError if the transition is not allowed
 */
export function transition(from: RecipePhase, action: string): RecipePhase {
  const validActions = TRANSITIONS[from]
  if (!validActions || !(action in validActions)) {
    throw new InvalidTransitionError(from, action)
  }
  return validActions[action]
}

/**
 * Get all valid actions from a given state.
 */
export function getValidTransitions(from: RecipePhase): string[] {
  return Object.keys(TRANSITIONS[from] || {})
}

/**
 * Check if a state is terminal (no outgoing transitions).
 */
export function isTerminal(phase: RecipePhase): boolean {
  return getValidTransitions(phase).length === 0
}
