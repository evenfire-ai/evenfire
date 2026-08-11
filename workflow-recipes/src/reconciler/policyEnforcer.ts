/**
 * Policy Enforcer — validates a WorkflowRecipe against WorkflowRecipePolicies.
 *
 * Pure function: receives recipe + policies, returns violations array.
 * Empty array = all checks pass. Non-empty = recipe is rejected.
 *
 * Enforcement is BLOCKING: any violation prevents deployment.
 */
import { SecurityIsolationLevel, WorkflowRecipeCRD, WorkflowRecipePolicyCRD } from '../types'

export interface PolicyViolation {
  policy: string
  rule: string
  message: string
}

const SECURITY_LEVELS: Record<SecurityIsolationLevel, number> = {
  minimal: 0,
  standard: 1,
  strict: 2,
}

/**
 * Match a string against a glob-like pattern (supports *, **, and ?).
 * Caches compiled RegExp per pattern to avoid re-compilation in inner loops.
 */
// Bounded by the number of unique glob patterns in WorkflowRecipePolicy CRDs.
// Policies are operator-managed and small in number — no eviction needed.
const globCache = new Map<string, RegExp>()

function globMatch(pattern: string, value: string): boolean {
  let re = globCache.get(pattern)
  if (!re) {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
      .replace(/\\\?/g, '[^/]')
      .replace(/\*\*/g, '<<<GLOBSTAR>>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<<GLOBSTAR>>>/g, '.*')
    re = new RegExp(`^${escaped}$`)
    globCache.set(pattern, re)
  }
  return re.test(value)
}

/**
 * Enforce all applicable policies against a recipe.
 * Returns an array of violations (empty = pass).
 *
 * Invariants enforced OUTSIDE any policy (spec §270-271, §1441):
 *
 * - Agentic recipes (with `spec.steps[]`) MUST NOT set `agent.contextRef`
 *   unless both conditions are met:
 *     1. `spec.security.allowContextRef: true` is explicitly declared on the
 *        recipe itself (opt-in), AND
 *     2. A matching WorkflowRecipePolicy with `allowContextRef: true` exists
 *        for the recipe's namespace.
 *   Rationale: a shared Context (e.g. `context1`) typically aggregates
 *   FIRST-PARTY MCP servers — allowing an arbitrary workflow to contextRef
 *   it would let that workflow silently inject or reuse servers the operator
 *   didn't intend. Default-deny.
 */
export function enforcePolicy(
  recipe: WorkflowRecipeCRD,
  policies: WorkflowRecipePolicyCRD[]
): PolicyViolation[] {
  const violations: PolicyViolation[] = []

  // ── Hard invariant: contextRef gating for agentic workflows ──────────
  //
  // This runs BEFORE the per-policy loop because it's a spec-mandated
  // invariant, not a policy-configurable rule. A missing
  // WorkflowRecipePolicy cannot WEAKEN this gate — only widen it via
  // explicit allowContextRef: true.
  const isAgentic = Array.isArray(recipe.spec.steps) && recipe.spec.steps.length > 0
  const hasContextRef =
    typeof (recipe.spec as { contextRef?: string }).contextRef === 'string' &&
    ((recipe.spec as { contextRef?: string }).contextRef ?? '').length > 0
  if (isAgentic && hasContextRef) {
    const recipeAllowFlag =
      (recipe.spec.security as { allowContextRef?: boolean } | undefined)?.allowContextRef === true
    const anyPolicyAllows = policies.some(
      p => (p.spec as { allowContextRef?: boolean } | undefined)?.allowContextRef === true
    )
    if (!recipeAllowFlag || !anyPolicyAllows) {
      violations.push({
        policy: '(spec-invariant)',
        rule: 'agenticWorkflowContextRefBlocked',
        message:
          'Agentic workflow (spec.steps[] present) declares spec.contextRef but ' +
          'spec.security.allowContextRef is not true on the recipe and/or no ' +
          'matching WorkflowRecipePolicy sets allowContextRef: true. Context sharing ' +
          'with first-party servers is default-deny per spec §270-271 / §1441.',
      })
    }
  }

  for (const policy of policies) {
    const policyName = policy.metadata.name
    const gov = policy.spec.governance
    const det = policy.spec.detection

    // ── Governance checks ──────────────────────────────────

    if (gov?.maxWorkloadsPerRecipe !== undefined) {
      if ((recipe.spec.workloads ?? []).length > gov.maxWorkloadsPerRecipe) {
        violations.push({
          policy: policyName,
          rule: 'maxWorkloadsPerRecipe',
          message: `Recipe has ${(recipe.spec.workloads ?? []).length} workloads, policy allows max ${gov.maxWorkloadsPerRecipe}`,
        })
      }
    }

    if (gov?.maxReplicasPerWorkload !== undefined) {
      for (const w of recipe.spec.workloads ?? []) {
        const replicas = w.replicas ?? 1
        if (replicas > gov.maxReplicasPerWorkload) {
          violations.push({
            policy: policyName,
            rule: 'maxReplicasPerWorkload',
            message: `Workload "${w.id}" has ${replicas} replicas, policy allows max ${gov.maxReplicasPerWorkload}`,
          })
        }
      }
    }

    if (gov?.allowedWorkloadTypes && gov.allowedWorkloadTypes.length > 0) {
      for (const w of recipe.spec.workloads ?? []) {
        if (!gov.allowedWorkloadTypes.includes(w.type)) {
          violations.push({
            policy: policyName,
            rule: 'allowedWorkloadTypes',
            message: `Workload "${w.id}" type "${w.type}" not in allowed types: [${gov.allowedWorkloadTypes.join(', ')}]`,
          })
        }
      }
    }

    if (gov?.requiredSecurityLevel) {
      const recipeLevel = recipe.spec.security?.isolationLevel ?? 'standard'
      if (SECURITY_LEVELS[recipeLevel] < SECURITY_LEVELS[gov.requiredSecurityLevel]) {
        violations.push({
          policy: policyName,
          rule: 'requiredSecurityLevel',
          message: `Recipe security level "${recipeLevel}" is below required "${gov.requiredSecurityLevel}"`,
        })
      }
    }

    if (gov?.requireApproval) {
      const phase = recipe.status?.phase ?? 'candidate'
      // Block phases that have NOT yet passed the approval gate.
      // "candidate" = initial state, never approved.
      // "pending-approval" = awaiting human sign-off, not yet approved.
      // All other phases (approved, deploying, running, failed, recovering, cancelled)
      // have previously passed the approval gate and must not be re-blocked.
      const UNAPPROVED_PHASES = new Set(['candidate', 'pending-approval'])
      if (UNAPPROVED_PHASES.has(phase)) {
        violations.push({
          policy: policyName,
          rule: 'requireApproval',
          message: `Recipe must be approved before deployment (current phase: "${phase}"). Transition to "pending-approval" first.`,
        })
      }
    }

    // ── Detection checks ───────────────────────────────────

    if (det?.imageDenylist && det.imageDenylist.length > 0) {
      for (const w of recipe.spec.workloads ?? []) {
        for (const pattern of det.imageDenylist) {
          if (globMatch(pattern, w.image)) {
            violations.push({
              policy: policyName,
              rule: 'imageDenylist',
              message: `Workload "${w.id}" image "${w.image}" matches denylist pattern "${pattern}"`,
            })
          }
        }
      }
    }

    if (det?.imageAllowlist && det.imageAllowlist.length > 0) {
      for (const w of recipe.spec.workloads ?? []) {
        const allowed = det.imageAllowlist.some(pattern => globMatch(pattern, w.image))
        if (!allowed) {
          violations.push({
            policy: policyName,
            rule: 'imageAllowlist',
            message: `Workload "${w.id}" image "${w.image}" not in allowlist`,
          })
        }
      }
    }
  }

  return violations
}
