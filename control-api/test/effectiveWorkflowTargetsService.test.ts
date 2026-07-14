import { describe, expect, it, vi } from 'vitest'
import { listEffectiveWorkflowTargets } from '../src/services/workflows/effectiveWorkflowTargetsService.js'
import { MockGateway } from './mockGateway.js'

describe('effective workflow targets service', () => {
  it('preserves workflow input contracts in list responses', async () => {
    const gateway = new MockGateway('sandbox-recipes')
    const inputContract = {
      type: 'object',
      required: ['company'],
      properties: {
        company: { type: 'string' },
        depth: { enum: ['standard', 'deep'] },
      },
    }
    await gateway.createResource('workflowrecipes', {
      metadata: { name: 'due-diligence' },
      spec: {
        inputContract,
        triggers: { onDemand: { requiresApproval: true } },
        workloads: [{ id: 'svc', type: 'deployment', image: 'test:latest' }],
      },
      status: { phase: 'Ready' },
    })

    const db = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    }

    const result = await listEffectiveWorkflowTargets({
      caller: { kind: 'admin-ui', userId: 'admin-user' },
      db,
      gateway: gateway as never,
      userId: 'chat-user',
    })

    expect(result.items).toEqual([
      {
        namespace: 'sandbox-recipes',
        name: 'due-diligence',
        inputContract,
        targets: [{ kind: 'user', label: 'Personal' }],
      },
    ])
  })
})
