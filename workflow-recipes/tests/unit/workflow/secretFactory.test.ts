import { describe, expect, it } from 'vitest'
import { buildCoordinatorTokenSecret } from '../../../src/workflow/secretFactory'

describe('Secret Factory', () => {
  const secret = buildCoordinatorTokenSecret(
    'my-recipe',
    'mock-mcp-host-token',
    'mock-wrc-token',
    'sandbox-recipes'
  )

  it('names secret with wf- prefix', () => {
    expect(secret.metadata!.name).toBe('wf-my-recipe-coordinator-token')
  })

  it('places secret in sandbox-recipes', () => {
    expect(secret.metadata!.namespace).toBe('sandbox-recipes')
  })

  it('contains mcp-host-token key (base64)', () => {
    const decoded = Buffer.from(secret.data!['mcp-host-token'], 'base64').toString()
    expect(decoded).toBe('mock-mcp-host-token')
  })

  it('contains wrc-token key (base64)', () => {
    const decoded = Buffer.from(secret.data!['wrc-token'], 'base64').toString()
    expect(decoded).toBe('mock-wrc-token')
  })

  it('has NO ownerReference (cross-namespace GC safety)', () => {
    // WorkflowRecipe and runtime secrets both live in sandbox-recipes.
    // K8s GC 1.24+ deletes cross-namespace owned resources.
    expect(secret.metadata!.ownerReferences).toBeUndefined()
  })

  it('has recipe and managed-by labels', () => {
    expect(secret.metadata!.labels!['clerum.io/recipe']).toBe('my-recipe')
    expect(secret.metadata!.labels!['clerum.io/managed-by']).toBe('wrc')
  })
})
