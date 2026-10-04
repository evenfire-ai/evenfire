import { describe, expect, it } from 'vitest'
import { buildGuardrailDetailScenario } from '../guardrailProducer'

describe('guardrail detail producer fixture', () => {
  it('tracks the Control API registry payload, Host reference, and HCC condition', () => {
    const { hook, hosts } = buildGuardrailDetailScenario()

    expect(hook.metadata).toMatchObject({
      name: 'sample-hook',
      namespace: 'llm-hooks',
      resourceVersion: 'rv-hook-read',
    })
    expect(hook.spec).toEqual({
      target: { service: { name: 'sample-hook-service', namespace: 'llm-hooks', port: 8080 } },
      path: '/check',
      lifecyclePoints: ['preCall'],
      order: 100,
      failMode: 'open',
    })
    expect(hook.status?.conditions).toEqual([
      {
        type: 'Ready',
        status: 'True',
        reason: 'NoWorkload',
        message: 'No workload deployed for service/remote target',
        lastTransitionTime: '2026-01-01T00:00:00.000Z',
      },
    ])
    expect(hook.status?.lastReconciled).toEqual(expect.any(String))
    expect(hosts.items).toHaveLength(1)
    expect(hosts.items[0].metadata).toMatchObject({
      name: 'sample-agent',
      namespace: 'mcp-host',
    })
    expect(hosts.items[0].spec?.guardrails).toEqual({
      hooks: { preCall: [{ id: 'sample-hook' }] },
    })
  })
})
