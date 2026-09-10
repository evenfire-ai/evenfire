import { describe, expect, it } from 'vitest'
import { OAI_EGRESS_BROKERS_CONDITION_TYPE } from '@clerum/egress-policy'
import { buildBrokersCondition } from './openaiEgressBrokerStatus'
import { HostCRD, HostCondition } from './types'

function host(conditions?: HostCondition[]): HostCRD {
  return {
    name: 'h',
    namespace: 'mcp-host',
    spec: { host: 'h', contextRef: 'ctx' },
    ...(conditions ? { status: { conditions } } : {}),
  }
}

const NOW = () => new Date('2026-01-01T00:00:00.000Z')

describe('buildBrokersCondition (decision table)', () => {
  it('Host declares no openai-compatible slot → null (writer removes any existing)', () => {
    expect(
      buildBrokersCondition(host(), {
        declaresOpenAiCompatible: false,
        provisioned: 0,
        dropped: [],
      })
    ).toBeNull()
  })

  it('declares + zero drops → True / AllSlotsProvisioned with a broker count message', () => {
    const cond = buildBrokersCondition(
      host(),
      { declaresOpenAiCompatible: true, provisioned: 2, dropped: [] },
      NOW
    )
    expect(cond).toMatchObject({
      type: OAI_EGRESS_BROKERS_CONDITION_TYPE,
      status: 'True',
      reason: 'AllSlotsProvisioned',
      message: '2 broker(s) provisioned',
      lastTransitionTime: '2026-01-01T00:00:00.000Z',
    })
  })

  it('declares + ≥1 drop → False, reason = first drop in PascalCase, message lists all', () => {
    const cond = buildBrokersCondition(
      host(),
      {
        declaresOpenAiCompatible: true,
        provisioned: 0,
        dropped: [
          { slotId: 'primary', reason: 'cluster_internal' },
          { slotId: 'fallback-1', reason: 'path_unsafe' },
        ],
      },
      NOW
    )
    expect(cond).toMatchObject({
      status: 'False',
      reason: 'ClusterInternal',
      message: 'primary: cluster_internal; fallback-1: path_unsafe',
    })
  })

  it('maps the fail-closed guard reason to ClusterInternalGuardUnconfigured', () => {
    const cond = buildBrokersCondition(host(), {
      declaresOpenAiCompatible: true,
      provisioned: 0,
      dropped: [{ slotId: 'primary', reason: 'cluster_internal_guard_unconfigured' }],
    })
    expect(cond?.reason).toBe('ClusterInternalGuardUnconfigured')
  })

  it('preserves lastTransitionTime when status + reason are unchanged', () => {
    const prior: HostCondition = {
      type: OAI_EGRESS_BROKERS_CONDITION_TYPE,
      status: 'False',
      reason: 'ClusterInternal',
      message: 'primary: cluster_internal',
      lastTransitionTime: '2020-05-05T05:05:05.000Z',
    }
    const cond = buildBrokersCondition(
      host([prior]),
      {
        declaresOpenAiCompatible: true,
        provisioned: 0,
        dropped: [{ slotId: 'primary', reason: 'cluster_internal' }],
      },
      NOW
    )
    // reason unchanged → timestamp carried over even though NOW differs.
    expect(cond?.lastTransitionTime).toBe('2020-05-05T05:05:05.000Z')
  })

  it('stamps a new lastTransitionTime when status flips', () => {
    const prior: HostCondition = {
      type: OAI_EGRESS_BROKERS_CONDITION_TYPE,
      status: 'False',
      reason: 'ClusterInternal',
      lastTransitionTime: '2020-05-05T05:05:05.000Z',
    }
    const cond = buildBrokersCondition(
      host([prior]),
      { declaresOpenAiCompatible: true, provisioned: 1, dropped: [] },
      NOW
    )
    expect(cond?.status).toBe('True')
    expect(cond?.lastTransitionTime).toBe('2026-01-01T00:00:00.000Z')
  })
})
