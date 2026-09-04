import { describe, expect, it } from 'vitest'
import {
  buildCoordinatorTokenSecret,
  buildMcpHostRuntimeTokenSecret,
  nextMcpHostRuntimeTokenGeneration,
  readMcpHostRuntimeTokenGeneration,
} from '../../../src/workflow/secretFactory'

describe('Secret Factory — mcpHost Runtime Tokens', () => {
  const retiredApprovalKeyPrefix = 'approval'
  const retiredAccessKey = `${retiredApprovalKeyPrefix}-access-token`
  const retiredRefreshKey = `${retiredApprovalKeyPrefix}-refresh-token`

  const secret = buildMcpHostRuntimeTokenSecret(
    'my-recipe',
    'test-access-token',
    'test-refresh-token',
    'sandbox-recipes',
    'test-control-token'
  )

  // ── New Secret shape ────────────────────────────────────────────────

  it('names secret with wf- prefix and -mcp-host-runtime-tokens suffix', () => {
    expect(secret.metadata!.name).toBe('wf-my-recipe-mcp-host-runtime-tokens')
  })

  it('places secret in sandbox-recipes namespace', () => {
    expect(secret.metadata!.namespace).toBe('sandbox-recipes')
  })

  it('contains mcp-host-runtime-access-token key (base64)', () => {
    const decoded = Buffer.from(secret.data!['mcp-host-runtime-access-token'], 'base64').toString()
    expect(decoded).toBe('test-access-token')
  })

  it('contains mcp-host-runtime-refresh-token key (base64)', () => {
    const decoded = Buffer.from(secret.data!['mcp-host-runtime-refresh-token'], 'base64').toString()
    expect(decoded).toBe('test-refresh-token')
  })

  it('contains mcp-host-workflow-control-token key (base64)', () => {
    const decoded = Buffer.from(
      secret.data!['mcp-host-workflow-control-token'],
      'base64'
    ).toString()
    expect(decoded).toBe('test-control-token')
  })

  it('does not write retired approval token keys', () => {
    expect(secret.data![retiredAccessKey]).toBeUndefined()
    expect(secret.data![retiredRefreshKey]).toBeUndefined()
  })

  it('has exactly 3 data keys', () => {
    expect(Object.keys(secret.data!)).toHaveLength(3)
    expect(Object.keys(secret.data!)).toEqual(
      expect.arrayContaining([
        'mcp-host-runtime-access-token',
        'mcp-host-runtime-refresh-token',
        'mcp-host-workflow-control-token',
      ])
    )
  })

  it('has mcp-host-runtime-token component label', () => {
    expect(secret.metadata!.labels!['clerum.io/component']).toBe('mcp-host-runtime-token')
  })

  it('has recipe and managed-by labels', () => {
    expect(secret.metadata!.labels!['clerum.io/recipe']).toBe('my-recipe')
    expect(secret.metadata!.labels!['clerum.io/managed-by']).toBe('wrc')
  })

  it('has NO ownerReference (cross-namespace GC safety)', () => {
    expect(secret.metadata!.ownerReferences).toBeUndefined()
  })

  it('bumps the runtime token generation from a missing or invalid residue', () => {
    expect(nextMcpHostRuntimeTokenGeneration(undefined)).toBe('1')
    expect(nextMcpHostRuntimeTokenGeneration('1')).toBe('2')
    expect(readMcpHostRuntimeTokenGeneration(undefined)).toBeUndefined()
    expect(
      readMcpHostRuntimeTokenGeneration({
        metadata: { annotations: { 'clerum.io/mcp-host-runtime-token-generation': '4' } },
      })
    ).toBe('4')
  })

  // ── Existing Secret unaffected ───────────────────────────────────────

  it('does NOT modify the existing coordinator-token Secret', () => {
    const coordinatorSecret = buildCoordinatorTokenSecret(
      'my-recipe',
      'mcp-host-token',
      'wrc-token',
      'sandbox-recipes'
    )

    // Coordinator secret has its own name and keys
    expect(coordinatorSecret.metadata!.name).toBe('wf-my-recipe-coordinator-token')
    expect(Object.keys(coordinatorSecret.data!)).toEqual(
      expect.arrayContaining(['mcp-host-token', 'wrc-token'])
    )
    // Should NOT contain approval keys
    expect(coordinatorSecret.data!['mcp-host-runtime-access-token']).toBeUndefined()
    expect(coordinatorSecret.data!['mcp-host-runtime-refresh-token']).toBeUndefined()
    expect(coordinatorSecret.data![retiredAccessKey]).toBeUndefined()
    expect(coordinatorSecret.data![retiredRefreshKey]).toBeUndefined()
  })
})
