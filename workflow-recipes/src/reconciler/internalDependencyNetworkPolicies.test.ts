import { describe, expect, it } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import type { WorkflowRecipeCRD, WorkloadDef } from '../types'
import {
  INTERNAL_DEPENDENCY_DESIRED_HASH_ANNOTATION,
  INTERNAL_DEPENDENCY_POLICY_TYPE,
  NETWORK_POLICY_DIRECTION_LABEL,
  NETWORK_POLICY_SOURCE_WORKLOAD_LABEL,
  NETWORK_POLICY_TARGET_WORKLOAD_LABEL,
  NETWORK_POLICY_TYPE_LABEL,
  buildInternalDependencyEgressNetworkPolicy,
  buildInternalDependencyIngressNetworkPolicy,
  internalDependencyEgressPolicyName,
  internalDependencyIngressPolicyName,
} from './internalDependencyNetworkPolicies'

function recipe(name = 'recipe-recap'): WorkflowRecipeCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name, namespace: 'sandbox-recipes', uid: `uid-${name}` },
    spec: { workloads: [] },
    status: { phase: 'approved' },
  }
}

function workload(id: string): WorkloadDef {
  return { id, type: 'deployment', image: `${id}:test`, port: 8080 }
}

describe('internal dependency NetworkPolicy builders', () => {
  it('builds egress policy shape without reusing legacy wl names or selectors', () => {
    const r = recipe()
    const policy = buildInternalDependencyEgressNetworkPolicy(
      workload('mcp-recap'),
      r,
      'mcp-server',
      [
        {
          targetWorkloadId: 'recap-db',
          targetNamespace: 'sandbox-recipes',
          port: 5432,
          protocol: 'TCP',
        },
        {
          targetWorkloadId: 'recap-cache',
          targetNamespace: 'sandbox-recipes',
          port: 6379,
          protocol: 'TCP',
        },
      ]
    )!

    expect(policy.metadata?.name).toBe(
      internalDependencyEgressPolicyName('recipe-recap', 'mcp-recap')
    )
    expect(policy.metadata?.name).toMatch(/^wr-intdep-egress-/)
    expect(policy.metadata?.labels).toMatchObject({
      'clerum.io/managed-by': 'workflow-recipes',
      'clerum.io/recipe': 'recipe-recap',
      [NETWORK_POLICY_TYPE_LABEL]: INTERNAL_DEPENDENCY_POLICY_TYPE,
      [NETWORK_POLICY_DIRECTION_LABEL]: 'egress',
      [NETWORK_POLICY_SOURCE_WORKLOAD_LABEL]: 'mcp-recap',
    })
    expect(policy.metadata?.annotations?.[INTERNAL_DEPENDENCY_DESIRED_HASH_ANNOTATION]).toMatch(
      /^[a-f0-9]{16}$/
    )
    expect(policy.spec?.podSelector?.matchLabels).toMatchObject({
      'clerum.io/managed-by': 'workflow-recipes',
      'clerum.io/recipe': 'recipe-recap',
      'clerum.io/workload': 'mcp-recap',
    })
    expect(policy.spec?.egress).toHaveLength(2)
    expect(policy.spec?.egress?.[0].to?.[0].podSelector?.matchLabels).toMatchObject({
      'clerum.io/managed-by': 'workflow-recipes',
      'clerum.io/workload': 'recap-cache',
    })
  })

  it('builds ingress policy with WRC-owned source peers and target labels', () => {
    const r = recipe()
    const policy = buildInternalDependencyIngressNetworkPolicy(
      workload('recap-db'),
      r,
      'sandbox-recipes',
      [
        {
          sourceWorkloadId: 'recap-api',
          sourceNamespace: 'sandbox-recipes',
          port: 5432,
          protocol: 'TCP',
        },
        {
          sourceWorkloadId: 'mcp-recap',
          sourceNamespace: 'mcp-server',
          port: 5432,
          protocol: 'TCP',
        },
      ]
    )!

    expect(policy.metadata?.name).toBe(
      internalDependencyIngressPolicyName('recipe-recap', 'recap-db')
    )
    expect(policy.metadata?.labels).toMatchObject({
      [NETWORK_POLICY_TYPE_LABEL]: INTERNAL_DEPENDENCY_POLICY_TYPE,
      [NETWORK_POLICY_DIRECTION_LABEL]: 'ingress',
      [NETWORK_POLICY_TARGET_WORKLOAD_LABEL]: 'recap-db',
    })
    expect(policy.spec?.podSelector?.matchLabels).toMatchObject({
      'clerum.io/managed-by': 'workflow-recipes',
      'clerum.io/workload': 'recap-db',
    })
    const from = policy.spec?.ingress?.map(rule => rule._from?.[0])
    expect(
      from?.map(peer => peer?.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'])
    ).toEqual(['mcp-server', 'sandbox-recipes'])
    expect(from?.[0]?.podSelector?.matchLabels).toMatchObject({
      'clerum.io/managed-by': 'workflow-recipes',
      'clerum.io/workload': 'mcp-recap',
    })
    const serialized = k8s.dumpYaml(policy)
    expect(serialized).toContain('from:')
    expect(serialized).not.toContain('_from:')
  })

  it('keeps long policy names DNS-1123 length safe', () => {
    const long = 'recipe-' + 'a'.repeat(80)
    expect(internalDependencyEgressPolicyName(long, 'source')).toHaveLength(63)
    expect(internalDependencyIngressPolicyName(long, 'target')).toHaveLength(63)
  })

  it('keeps policy names DNS-1123 safe when workload ids are long', () => {
    const longWorkload = 'workload-' + 'b'.repeat(80)
    expect(internalDependencyEgressPolicyName('recipe-recap', longWorkload)).toHaveLength(63)
    expect(internalDependencyIngressPolicyName('recipe-recap', longWorkload)).toHaveLength(63)
  })

  it('keeps truncated long policy names distinct with a hash suffix', () => {
    const prefix = 'recipe-' + 'a'.repeat(80)
    const first = internalDependencyEgressPolicyName(`${prefix}-one`, 'source')
    const second = internalDependencyEgressPolicyName(`${prefix}-two`, 'source')

    expect(first).toHaveLength(63)
    expect(second).toHaveLength(63)
    expect(first).not.toBe(second)
    expect(first).toMatch(/[a-f0-9]{8}$/)
    expect(second).toMatch(/[a-f0-9]{8}$/)
  })

  it('keeps truncated long workload policy names distinct with a hash suffix', () => {
    const prefix = 'workload-' + 'b'.repeat(80)
    const first = internalDependencyEgressPolicyName('recipe-recap', `${prefix}-one`)
    const second = internalDependencyEgressPolicyName('recipe-recap', `${prefix}-two`)

    expect(first).toHaveLength(63)
    expect(second).toHaveLength(63)
    expect(first).not.toBe(second)
    expect(first).toMatch(/[a-f0-9]{8}$/)
    expect(second).toMatch(/[a-f0-9]{8}$/)
  })
})
