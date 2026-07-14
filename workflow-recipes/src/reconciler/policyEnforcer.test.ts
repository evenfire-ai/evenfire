import { describe, expect, it } from 'vitest'
import { WorkflowRecipeCRD, WorkflowRecipePolicyCRD } from '../types'
import { enforcePolicy } from './policyEnforcer'

function makeRecipe(overrides: Partial<WorkflowRecipeCRD['spec']> = {}): WorkflowRecipeCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'test-recipe', namespace: 'sandbox-recipes' },
    spec: {
      workloads: [{ id: 'web', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 80 }],
      ...overrides,
    },
  }
}

function makePolicy(
  overrides: Partial<WorkflowRecipePolicyCRD['spec']> = {}
): WorkflowRecipePolicyCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipePolicy',
    metadata: { name: 'test-policy', namespace: 'sandbox-recipes' },
    spec: overrides,
  }
}

describe('policyEnforcer.enforcePolicy', () => {
  // ── No policies → no violations ──────────────────────────────

  it('returns empty violations when no policies exist', () => {
    const result = enforcePolicy(makeRecipe(), [])
    expect(result).toEqual([])
  })

  it('returns empty violations when policy has no governance or detection', () => {
    const result = enforcePolicy(makeRecipe(), [makePolicy({})])
    expect(result).toEqual([])
  })

  // ── maxWorkloadsPerRecipe ────────────────────────────────────

  it('passes when workload count is within limit', () => {
    const policy = makePolicy({ governance: { maxWorkloadsPerRecipe: 3 } })
    const result = enforcePolicy(makeRecipe(), [policy])
    expect(result).toEqual([])
  })

  it('rejects when workload count exceeds limit', () => {
    const recipe = makeRecipe({
      workloads: [
        { id: 'a', type: 'deployment', image: 'nginx:1.30.1-alpine' },
        { id: 'b', type: 'deployment', image: 'redis:latest' },
        { id: 'c', type: 'deployment', image: 'postgres:latest' },
      ],
    })
    const policy = makePolicy({ governance: { maxWorkloadsPerRecipe: 2 } })
    const result = enforcePolicy(recipe, [policy])
    expect(result).toHaveLength(1)
    expect(result[0].rule).toBe('maxWorkloadsPerRecipe')
    expect(result[0].message).toContain('3 workloads')
    expect(result[0].message).toContain('max 2')
  })

  // ── maxReplicasPerWorkload ───────────────────────────────────

  it('passes when replicas are within limit', () => {
    const recipe = makeRecipe({
      workloads: [{ id: 'web', type: 'deployment', image: 'nginx:1.30.1-alpine', replicas: 3 }],
    })
    const policy = makePolicy({ governance: { maxReplicasPerWorkload: 5 } })
    expect(enforcePolicy(recipe, [policy])).toEqual([])
  })

  it('rejects when replicas exceed limit', () => {
    const recipe = makeRecipe({
      workloads: [{ id: 'web', type: 'deployment', image: 'nginx:1.30.1-alpine', replicas: 10 }],
    })
    const policy = makePolicy({ governance: { maxReplicasPerWorkload: 5 } })
    const result = enforcePolicy(recipe, [policy])
    expect(result).toHaveLength(1)
    expect(result[0].rule).toBe('maxReplicasPerWorkload')
    expect(result[0].message).toContain('10 replicas')
  })

  it('uses default replicas=1 when not specified', () => {
    const policy = makePolicy({ governance: { maxReplicasPerWorkload: 1 } })
    expect(enforcePolicy(makeRecipe(), [policy])).toEqual([])
  })

  // ── allowedWorkloadTypes ─────────────────────────────────────

  it('passes when workload type is allowed', () => {
    const policy = makePolicy({ governance: { allowedWorkloadTypes: ['deployment', 'job'] } })
    expect(enforcePolicy(makeRecipe(), [policy])).toEqual([])
  })

  it('rejects when workload type is not allowed', () => {
    const recipe = makeRecipe({
      workloads: [{ id: 'monitor', type: 'daemonset', image: 'monitor:latest' }],
    })
    const policy = makePolicy({ governance: { allowedWorkloadTypes: ['deployment', 'job'] } })
    const result = enforcePolicy(recipe, [policy])
    expect(result).toHaveLength(1)
    expect(result[0].rule).toBe('allowedWorkloadTypes')
    expect(result[0].message).toContain('daemonset')
  })

  // ── requiredSecurityLevel ────────────────────────────────────

  it('passes when security level meets requirement', () => {
    const recipe = makeRecipe({ security: { isolationLevel: 'strict' } })
    const policy = makePolicy({ governance: { requiredSecurityLevel: 'standard' } })
    expect(enforcePolicy(recipe, [policy])).toEqual([])
  })

  it('passes when security level equals requirement', () => {
    const recipe = makeRecipe({ security: { isolationLevel: 'standard' } })
    const policy = makePolicy({ governance: { requiredSecurityLevel: 'standard' } })
    expect(enforcePolicy(recipe, [policy])).toEqual([])
  })

  it('rejects when security level is below requirement', () => {
    const recipe = makeRecipe({ security: { isolationLevel: 'minimal' } })
    const policy = makePolicy({ governance: { requiredSecurityLevel: 'strict' } })
    const result = enforcePolicy(recipe, [policy])
    expect(result).toHaveLength(1)
    expect(result[0].rule).toBe('requiredSecurityLevel')
    expect(result[0].message).toContain('minimal')
    expect(result[0].message).toContain('strict')
  })

  it('defaults to minimal when recipe has no security config', () => {
    const policy = makePolicy({ governance: { requiredSecurityLevel: 'standard' } })
    const result = enforcePolicy(makeRecipe(), [policy])
    expect(result).toHaveLength(1)
    expect(result[0].rule).toBe('requiredSecurityLevel')
  })

  // ── imageDenylist ────────────────────────────────────────────

  it('passes when image does not match denylist', () => {
    const policy = makePolicy({ detection: { imageDenylist: ['malicious/*'] } })
    expect(enforcePolicy(makeRecipe(), [policy])).toEqual([])
  })

  it('rejects when image matches denylist pattern', () => {
    const recipe = makeRecipe({
      workloads: [{ id: 'web', type: 'deployment', image: 'untrusted/evil:latest' }],
    })
    const policy = makePolicy({ detection: { imageDenylist: ['untrusted/*'] } })
    const result = enforcePolicy(recipe, [policy])
    expect(result).toHaveLength(1)
    expect(result[0].rule).toBe('imageDenylist')
    expect(result[0].message).toContain('untrusted/evil:latest')
  })

  // ── imageAllowlist ───────────────────────────────────────────

  it('passes when image matches allowlist', () => {
    const policy = makePolicy({ detection: { imageAllowlist: ['nginx:*', 'redis:*'] } })
    expect(enforcePolicy(makeRecipe(), [policy])).toEqual([])
  })

  it('rejects when image does not match allowlist', () => {
    const recipe = makeRecipe({
      workloads: [{ id: 'web', type: 'deployment', image: 'custom/app:v1' }],
    })
    const policy = makePolicy({ detection: { imageAllowlist: ['nginx:*', 'redis:*'] } })
    const result = enforcePolicy(recipe, [policy])
    expect(result).toHaveLength(1)
    expect(result[0].rule).toBe('imageAllowlist')
    expect(result[0].message).toContain('custom/app:v1')
  })

  // ── requireApproval ────────────────────────────────────────────

  it('blocks candidate recipe when requireApproval is true', () => {
    const recipe = makeRecipe()
    // candidate is the default phase (no status)
    const policy = makePolicy({ governance: { requireApproval: true } })
    const result = enforcePolicy(recipe, [policy])
    expect(result).toHaveLength(1)
    expect(result[0].rule).toBe('requireApproval')
    expect(result[0].message).toContain('pending-approval')
  })

  it('allows approved recipe when requireApproval is true', () => {
    const recipe: WorkflowRecipeCRD = {
      ...makeRecipe(),
      status: { phase: 'approved', workloads: [], conditions: [] },
    }
    const policy = makePolicy({ governance: { requireApproval: true } })
    const result = enforcePolicy(recipe, [policy])
    expect(result).toEqual([])
  })

  it('allows deploying recipe when requireApproval is true', () => {
    const recipe: WorkflowRecipeCRD = {
      ...makeRecipe(),
      status: { phase: 'deploying', workloads: [], conditions: [] },
    }
    const policy = makePolicy({ governance: { requireApproval: true } })
    const result = enforcePolicy(recipe, [policy])
    expect(result).toEqual([])
  })

  it('does not block when requireApproval is false', () => {
    const policy = makePolicy({ governance: { requireApproval: false } })
    const result = enforcePolicy(makeRecipe(), [policy])
    expect(result).toEqual([])
  })

  // ── Glob ? wildcard ───────────────────────────────────────────

  it('glob ? matches single character in image name', () => {
    const recipe = makeRecipe({
      workloads: [{ id: 'web', type: 'deployment', image: 'example-web:1.25' }],
    })
    const policy = makePolicy({ detection: { imageAllowlist: ['example-web:1.2?'] } })
    expect(enforcePolicy(recipe, [policy])).toEqual([])
  })

  it('glob ? does not match zero characters', () => {
    const recipe = makeRecipe({
      workloads: [{ id: 'web', type: 'deployment', image: 'example-web:1.2' }],
    })
    const policy = makePolicy({ detection: { imageAllowlist: ['example-web:1.2?'] } })
    const result = enforcePolicy(recipe, [policy])
    expect(result).toHaveLength(1)
    expect(result[0].rule).toBe('imageAllowlist')
  })

  it('glob ? does not match slash', () => {
    const recipe = makeRecipe({
      workloads: [{ id: 'web', type: 'deployment', image: 'example-web:1.2/bad' }],
    })
    const policy = makePolicy({ detection: { imageDenylist: ['example-web:1.2?bad'] } })
    expect(enforcePolicy(recipe, [policy])).toEqual([])
  })

  // ── Multiple violations ──────────────────────────────────────

  it('accumulates multiple violations from a single policy', () => {
    const recipe = makeRecipe({
      workloads: [
        { id: 'a', type: 'daemonset', image: 'evil:latest' },
        { id: 'b', type: 'job', image: 'nginx:1.30.1-alpine' },
      ],
      security: { isolationLevel: 'minimal' },
    })
    const policy = makePolicy({
      governance: {
        maxWorkloadsPerRecipe: 1,
        allowedWorkloadTypes: ['deployment'],
        requiredSecurityLevel: 'strict',
      },
      detection: { imageDenylist: ['evil:*'] },
    })
    const result = enforcePolicy(recipe, [policy])
    // At least: maxWorkloads, 2x allowedTypes (daemonset + job), securityLevel, imageDenylist
    expect(result.length).toBeGreaterThanOrEqual(5)
  })

  it('accumulates violations from multiple policies', () => {
    const recipe = makeRecipe({
      workloads: [{ id: 'web', type: 'deployment', image: 'nginx:1.30.1-alpine', replicas: 10 }],
    })
    const policy1 = makePolicy({ governance: { maxReplicasPerWorkload: 5 } })
    const policy2: WorkflowRecipePolicyCRD = {
      ...makePolicy({ governance: { maxReplicasPerWorkload: 3 } }),
      metadata: { name: 'strict-policy', namespace: 'sandbox-recipes' },
    }
    const result = enforcePolicy(recipe, [policy1, policy2])
    expect(result).toHaveLength(2)
    expect(result[0].policy).toBe('test-policy')
    expect(result[1].policy).toBe('strict-policy')
  })

  // ── Spec invariant: contextRef on agentic workflows ──────────
  //
  // Spec §270-271 + §1441 — contextRef is default-deny for agentic
  // workflows. These tests cover the invariant that runs BEFORE
  // per-policy rules.

  function makeAgenticRecipe(
    overrides: Partial<WorkflowRecipeCRD['spec']> = {}
  ): WorkflowRecipeCRD {
    return {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'agentic-test', namespace: 'sandbox-recipes' },
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 's1', instruction: 'do thing' } as { id: string; instruction: string }],
        ...overrides,
      } as WorkflowRecipeCRD['spec'],
    }
  }

  it('REJECTS agentic recipe with contextRef when no policy exists', () => {
    const recipe = makeAgenticRecipe({ contextRef: 'context1' })
    const result = enforcePolicy(recipe, [])
    expect(result).toHaveLength(1)
    expect(result[0].rule).toBe('agenticWorkflowContextRefBlocked')
  })

  it('REJECTS agentic recipe with contextRef when recipe sets allowContextRef but no policy allows', () => {
    const recipe = makeAgenticRecipe({
      contextRef: 'context1',
      security: { allowContextRef: true },
    } as unknown as Partial<WorkflowRecipeCRD['spec']>)
    const result = enforcePolicy(recipe, [])
    expect(result).toHaveLength(1)
    expect(result[0].rule).toBe('agenticWorkflowContextRefBlocked')
  })

  it('REJECTS agentic recipe with contextRef when policy allows but recipe opt-in is missing', () => {
    const recipe = makeAgenticRecipe({ contextRef: 'context1' })
    const policy = {
      ...makePolicy({}),
      spec: { allowContextRef: true } as { allowContextRef: boolean },
    } as WorkflowRecipePolicyCRD
    const result = enforcePolicy(recipe, [policy])
    expect(result).toHaveLength(1)
    expect(result[0].rule).toBe('agenticWorkflowContextRefBlocked')
  })

  it('ALLOWS agentic recipe with contextRef when BOTH recipe opt-in AND policy allow', () => {
    const recipe = makeAgenticRecipe({
      contextRef: 'context1',
      security: { allowContextRef: true },
    } as unknown as Partial<WorkflowRecipeCRD['spec']>)
    const policy = {
      ...makePolicy({}),
      spec: { allowContextRef: true } as { allowContextRef: boolean },
    } as WorkflowRecipePolicyCRD
    const result = enforcePolicy(recipe, [policy])
    expect(result).toEqual([])
  })

  it('DOES NOT block non-agentic (MCP-only) recipes with contextRef', () => {
    // Classic MCP stack — no spec.steps[] — is allowed to use contextRef freely.
    const recipe = makeRecipe({ contextRef: 'context1' } as Partial<WorkflowRecipeCRD['spec']>)
    const result = enforcePolicy(recipe, [])
    expect(result).toEqual([])
  })

  it('DOES NOT block agentic recipe WITHOUT contextRef', () => {
    const recipe = makeAgenticRecipe()
    const result = enforcePolicy(recipe, [])
    expect(result).toEqual([])
  })
})
