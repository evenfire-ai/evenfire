export type RecipeCondition = {
  type?: string
  status?: string
  reason?: string
  message?: string
  lastTransitionTime?: string
}

// Problem condition types the workflow-recipes controller publishes whose
// names do not follow the Missing/Failed/Invalid convention below. Listed by
// name so that no other type changes tone.
const PROBLEM_CONDITION_TYPES = new Set(['EnvSecretOwnershipDenied', 'StatefulSetImmutableDrift'])

export function conditionTone(cond: RecipeCondition): 'ok' | 'warn' | 'error' | 'info' {
  // Convention: "<Thing>Missing/Failed/Invalid"-style condition types are
  // problem conditions — status:True is bad. Dormant is informational.
  const t = String(cond.type ?? '')
  const s = String(cond.status ?? '')
  if (t === 'WebhookDormant') return s === 'True' ? 'info' : 'ok'
  const isProblem =
    PROBLEM_CONDITION_TYPES.has(t) ||
    /Missing$|Failed$|Invalid$|NotReady$/.test(t) ||
    /Failure|Failed|Invalid|Missing/.test(t)
  if (isProblem) return s === 'True' ? 'error' : 'ok'
  return s === 'True' ? 'ok' : 'warn'
}
