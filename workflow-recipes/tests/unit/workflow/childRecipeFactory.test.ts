import { describe, expect, it, vi } from 'vitest'
import {
  INHERITED_PARENT_RESOURCES_ANNOTATION,
  ParentRecipe,
  buildChildRecipe,
  formatTimestamp,
  resolveExecutionIndex,
} from '../../../src/workflow/childRecipeFactory'

const parent: ParentRecipe = {
  metadata: { name: 'market-report', namespace: 'sandbox-recipes', uid: 'uid-123' },
  spec: {
    contextRef: 'wf-market-report',
    security: { allowContextRef: true, isolationLevel: 'strict' },
    coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
    inputContract: {
      properties: {
        market: { type: 'string', default: 'AI tools' },
      },
    },
    steps: [
      { id: 'fetch', instruction: 'Get data' },
      { id: 'analyze', instruction: 'Analyze' },
    ],
    agent: { model: 'gpt-4', provider: 'openai' },
    mcpServers: [{ id: 'mongodb', endpoint: 'http://mongo:3000' }],
    workloads: [{ id: 'db', type: 'statefulset' }],
    resources: [{ id: 'api-key', type: 'secret', data: { token: 'redacted' } }],
    runtimeEgress: { http: { allowedHosts: ['swapi.info'] } },
    output: { destination: 'stdout' },
  },
}

describe('buildChildRecipe', () => {
  const now = new Date('2026-03-16T09:00:00Z')

  it('copies steps from parent', () => {
    const child = buildChildRecipe(parent, 0, now) as any
    expect(child.spec.steps).toEqual(parent.spec.steps)
  })

  it('copies custom coordinator image and input contract from parent', () => {
    const child = buildChildRecipe(parent, 0, now) as any
    expect(child.spec.coordinatorImage).toBe(parent.spec.coordinatorImage)
    expect(child.spec.inputContract).toEqual(parent.spec.inputContract)
  })

  it('copies runtime egress intent from parent', () => {
    const child = buildChildRecipe(parent, 0, now) as any
    expect(child.spec.runtimeEgress).toEqual(parent.spec.runtimeEgress)
  })

  it('copies context and security boundary from parent', () => {
    const child = buildChildRecipe(parent, 0, now) as any
    expect(child.spec.contextRef).toBe(parent.spec.contextRef)
    expect(child.spec.security).toEqual(parent.spec.security)
  })

  it('copies declared resources from parent for child validation and templates', () => {
    const child = buildChildRecipe(parent, 0, now) as any
    expect(child.spec.resources).toEqual(parent.spec.resources)
    expect(child.metadata.annotations[INHERITED_PARENT_RESOURCES_ANNOTATION]).toBe('true')
  })

  it('omits scheduling from child', () => {
    const child = buildChildRecipe(parent, 0, now) as any
    expect(child.spec.scheduling).toBeUndefined()
  })

  it('sets ownerRef to parent', () => {
    const child = buildChildRecipe(parent, 0, now) as any
    expect(child.metadata.ownerReferences[0].name).toBe('market-report')
    expect(child.metadata.ownerReferences[0].uid).toBe('uid-123')
  })

  it('sets blockOwnerDeletion true (BUG-12 fix: prevents orphaned Pods on parent deletion)', () => {
    const child = buildChildRecipe(parent, 0, now) as any
    expect(child.metadata.ownerReferences[0].blockOwnerDeletion).toBe(true)
  })

  it('sets required labels', () => {
    const child = buildChildRecipe(parent, 5, now) as any
    expect(child.metadata.labels['clerum.io/parent-recipe']).toBe('market-report')
    expect(child.metadata.labels['clerum.io/scheduled']).toBe('true')
    expect(child.metadata.labels['clerum.io/execution-index']).toBe('5')
    expect(child.metadata.labels['clerum.io/managed-by']).toBe('clerum-wrc')
  })

  it('name follows timestamp pattern', () => {
    const child = buildChildRecipe(parent, 0, now) as any
    expect(child.metadata.name).toBe('market-report-20260316-090000-0000')
    expect(child.metadata.name).toMatch(/^market-report-\d{8}-\d{6}-\d{4}$/)
  })

  it('uses UTC for timestamp regardless of timezone', () => {
    // The factory always uses UTC — timezone is only for CronJob scheduling
    const child = buildChildRecipe(parent, 0, new Date('2026-03-16T09:00:00+05:00')) as any
    expect(child.metadata.name).toBe('market-report-20260316-040000-0000') // UTC offset applied
  })

  it('deepCopy prevents spec mutation', () => {
    const child = buildChildRecipe(parent, 0, now) as any
    ;(child.spec.steps as any[])[0].id = 'MUTATED'
    child.spec.runtimeEgress.http.allowedHosts[0] = 'mutated.example'
    child.spec.resources[0].data.token = 'mutated'
    expect((parent.spec.steps as any[])[0].id).toBe('fetch') // Parent unchanged
    expect((parent.spec.runtimeEgress as any)?.http?.allowedHosts).toEqual(['swapi.info'])
    expect((parent.spec.resources as any[])[0].data.token).toBe('redacted')
  })

  it('handles empty workloads', () => {
    const p = { ...parent, spec: { ...parent.spec, workloads: [] } }
    const child = buildChildRecipe(p, 0, now) as any
    expect(child.spec.workloads).toEqual([])
  })

  it('handles no output', () => {
    const p = { ...parent, spec: { ...parent.spec, output: undefined } }
    const child = buildChildRecipe(p, 0, now) as any
    expect(child.spec.output).toBeUndefined()
  })

  it('handles no mcpServers', () => {
    const p = { ...parent, spec: { ...parent.spec, mcpServers: undefined } }
    const child = buildChildRecipe(p, 0, now) as any
    expect(child.spec.mcpServers).toBeUndefined()
  })

  it('rejects parent WorkflowRecipe namespaces outside sandbox-recipes', () => {
    const p = { ...parent, metadata: { ...parent.metadata, namespace: 'mcp-server' } }
    expect(() => buildChildRecipe(p, 0, now)).toThrow(/sandbox-recipes/)
  })
})

describe('formatTimestamp', () => {
  it('formats UTC date as YYYYMMDD-HHmmss', () => {
    expect(formatTimestamp(new Date('2026-03-16T09:05:30Z'))).toBe('20260316-090530')
  })

  it('pads single digits', () => {
    expect(formatTimestamp(new Date('2026-01-02T03:04:05Z'))).toBe('20260102-030405')
  })
})

describe('resolveExecutionIndex', () => {
  it('returns 0 when no children exist', async () => {
    const mockApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    } as any
    expect(await resolveExecutionIndex(mockApi, 'parent', 'ns')).toBe(0)
  })

  it('returns N when N children exist', async () => {
    const mockApi = {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({
        items: [{}, {}, {}],
      }),
    } as any
    expect(await resolveExecutionIndex(mockApi, 'parent', 'ns')).toBe(3)
  })

  it('returns 0 on API error', async () => {
    const mockApi = {
      listNamespacedCustomObject: vi.fn().mockRejectedValue(new Error('fail')),
    } as any
    expect(await resolveExecutionIndex(mockApi, 'parent', 'ns')).toBe(0)
  })
})
