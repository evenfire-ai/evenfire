import { describe, expect, it } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import type { WebhookDef, WorkflowRecipeCRD } from '../types'
import type { ResolvedExternalEgress } from './fqdnResolver'
import {
  buildInternalDependencyEgressNetworkPolicy,
  buildInternalDependencyIngressNetworkPolicy,
} from './internalDependencyNetworkPolicies'
import { buildOAuthBrokerEgressNetworkPolicy, buildUiEgressNetworkPolicy } from './resourceBuilder'
import { type BuildInput, buildWebhookGatewayResources } from './webhookGatewayBuilder'

function makeRecipe(): WorkflowRecipeCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: {
      name: 'sales-crm',
      namespace: 'sandbox-recipes',
      uid: 'uid-sales-crm',
    },
    spec: {
      workloads: [
        { id: 'web', type: 'deployment', image: 'web:latest', port: 8080 },
        { id: 'postgres', type: 'deployment', image: 'postgres:16', port: 5432 },
        { id: 'worker', type: 'deployment', image: 'worker:latest' },
        { id: 'sync', type: 'deployment', image: 'sync:latest' },
      ],
    },
  }
}

function webhook(id = 'fireflies'): WebhookDef {
  return {
    id,
    workloadRef: 'web',
    path: `/webhooks/${id}`,
    verification: {
      scheme: 'hmac-sha256-body',
      secretRef: { name: 'webhook-creds', key: 'signing-secret' },
      signatureHeader: 'X-Hub-Signature-256',
    },
  }
}

function webhookInput(overrides: Partial<BuildInput> = {}): BuildInput {
  const recipe = makeRecipe()
  const wh = webhook()
  return {
    recipe,
    webhooks: [wh],
    targetNamespace: 'sandbox-recipes',
    handlers: {
      [wh.id]: { podName: 'web', port: 8080, path: wh.path },
    },
    image: 'clerum/webhook-gateway:test',
    monitoringNamespace: 'monitoring',
    webhookIngressNamespace: 'webhook-ingress',
    ...overrides,
  }
}

function expectPolicySelectorPinned(policy: k8s.V1NetworkPolicy): void {
  const selector = policy.spec?.podSelector
  expect(selector).not.toEqual({})
  expect(
    Object.keys(selector?.matchLabels ?? {}).length > 0 ||
      (selector?.matchExpressions?.length ?? 0) > 0
  ).toBe(true)
}

function expectPeerPinned(peer: k8s.V1NetworkPolicyPeer): void {
  expect(peer.namespaceSelector).not.toEqual({})
  expect(peer.podSelector).not.toEqual({})
  expect(
    peer.ipBlock !== undefined ||
      Object.keys(peer.namespaceSelector?.matchLabels ?? {}).length > 0 ||
      (peer.namespaceSelector?.matchExpressions?.length ?? 0) > 0 ||
      Object.keys(peer.podSelector?.matchLabels ?? {}).length > 0 ||
      (peer.podSelector?.matchExpressions?.length ?? 0) > 0
  ).toBe(true)
}

function expectNoPortsOnlyRules(policy: k8s.V1NetworkPolicy): void {
  for (const rule of policy.spec?.egress ?? []) {
    expect(rule.ports?.length).toBeGreaterThan(0)
    expect(rule.to?.length).toBeGreaterThan(0)
    for (const peer of rule.to ?? []) expectPeerPinned(peer)
  }

  for (const rule of policy.spec?.ingress ?? []) {
    const from = (rule as { _from?: k8s.V1NetworkPolicyPeer[] })._from ?? []
    expect(rule.ports?.length).toBeGreaterThan(0)
    expect(from.length).toBeGreaterThan(0)
    for (const peer of from) expectPeerPinned(peer)
  }

  if ((policy.spec?.ingress ?? []).length > 0) {
    const serialized = k8s.dumpYaml(policy)
    expect(serialized).toContain('from:')
    expect(serialized).not.toContain('_from:')
  }
}

describe('generated WRC NetworkPolicy hardening', () => {
  it('pins sandbox UI egress rules to explicit destinations', () => {
    const recipe = makeRecipe()
    recipe.spec.ui = {
      workloadRef: 'web',
      port: 8080,
      egress: { internal: [{ workloadRef: 'postgres', port: 5432 }] },
    }
    const resolved: ResolvedExternalEgress[] = [
      {
        cidr: '93.184.216.10/32',
        port: 443,
        source: { kind: 'fqdn', fqdn: 'api.stripe.com' },
      },
    ]

    const policy = buildUiEgressNetworkPolicy(recipe, 'sandbox-ui', 'sandbox-recipes', resolved)!

    expectPolicySelectorPinned(policy)
    expectNoPortsOnlyRules(policy)
  })

  it('pins OAuth broker egress to opted-in workloads and control-api', () => {
    const policy = buildOAuthBrokerEgressNetworkPolicy(
      makeRecipe(),
      ['worker', 'sync'],
      'sandbox-recipes',
      'control-plane'
    )!

    expectPolicySelectorPinned(policy)
    expectNoPortsOnlyRules(policy)
    expect(policy.spec?.podSelector?.matchExpressions?.[0]).toEqual({
      key: 'clerum.io/workload',
      operator: 'In',
      values: ['sync', 'worker'],
    })
  })

  it('pins webhook gateway NetworkPolicies without ports-only or empty-selector rules', () => {
    const out = buildWebhookGatewayResources(webhookInput())

    for (const policy of [
      out.proxyIngressPolicy,
      out.handlerEgressPolicy,
      out.handlerIngressPolicy,
    ]) {
      expectPolicySelectorPinned(policy)
      expectNoPortsOnlyRules(policy)
    }
  })

  it('pins WRC internal-dependency policies to owned workload peers', () => {
    const recipe = makeRecipe()
    const egress = buildInternalDependencyEgressNetworkPolicy(
      recipe.spec.workloads![2],
      recipe,
      'sandbox-recipes',
      [
        {
          targetWorkloadId: 'postgres',
          targetNamespace: 'sandbox-recipes',
          port: 5432,
          protocol: 'TCP',
        },
      ]
    )!
    const ingress = buildInternalDependencyIngressNetworkPolicy(
      recipe.spec.workloads![1],
      recipe,
      'sandbox-recipes',
      [
        {
          sourceWorkloadId: 'worker',
          sourceNamespace: 'sandbox-recipes',
          port: 5432,
          protocol: 'TCP',
        },
      ]
    )!

    for (const policy of [egress, ingress]) {
      expectPolicySelectorPinned(policy)
      expectNoPortsOnlyRules(policy)
    }
  })
})
