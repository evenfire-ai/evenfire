import { describe, expect, it } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as YAML from 'yaml'
import {
  RPC_PROXY_EDGE_PROTOCOL_LABEL,
  RPC_PROXY_EDGE_PROTOCOL_V1,
  RPC_PROXY_RUNTIME_RBAC_MANIFEST,
  RPC_PROXY_RUNTIME_RBAC_NAME,
  RPC_PROXY_RUNTIME_RBAC_SUBJECT,
  rpcProxyProtocolCohortBlockers,
} from '../src/hostReconciler'

const SIGNED = { [RPC_PROXY_EDGE_PROTOCOL_LABEL]: RPC_PROXY_EDGE_PROTOCOL_V1 }

function deployment(options: {
  generation?: number
  observedGeneration?: number
  templateLabels?: Record<string, string>
  replicas?: number
  updatedReplicas?: number
  readyReplicas?: number
  availableReplicas?: number
}): k8s.V1Deployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'rpc-proxy', namespace: 'rpc-proxy', generation: options.generation },
    spec: {
      replicas: options.replicas ?? 2,
      selector: { matchLabels: { app: 'rpc-proxy' } },
      template: {
        metadata: { labels: { app: 'rpc-proxy', ...options.templateLabels } },
        spec: { containers: [{ name: 'rpc-proxy', image: 'clerum/rpc-proxy:test' }] },
      },
    },
    status: {
      observedGeneration: options.observedGeneration,
      replicas: options.replicas ?? 2,
      updatedReplicas: options.updatedReplicas,
      readyReplicas: options.readyReplicas,
      availableReplicas: options.availableReplicas,
    },
  }
}

function pod(options: {
  name?: string
  labels?: Record<string, string>
  phase?: string
  ready?: boolean
  deletionTimestamp?: Date
}): k8s.V1Pod {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: options.name,
      namespace: 'rpc-proxy',
      labels: { app: 'rpc-proxy', ...options.labels },
      deletionTimestamp: options.deletionTimestamp,
    },
    spec: { containers: [{ name: 'rpc-proxy', image: 'clerum/rpc-proxy:test' }] },
    status: {
      phase: options.phase,
      conditions: [{ type: 'Ready', status: options.ready === false ? 'False' : 'True' }],
    },
  }
}

const current = deployment({
  generation: 5,
  observedGeneration: 5,
  templateLabels: SIGNED,
  updatedReplicas: 2,
  readyReplicas: 2,
  availableReplicas: 2,
})

const cases: Array<{
  name: string
  deployment: k8s.V1Deployment
  pods: k8s.V1Pod[]
  ready: boolean
  blockers: string[]
}> = [
  {
    name: 'a current, observed, fully labelled cohort',
    deployment: current,
    pods: [
      pod({ name: 'a', labels: SIGNED, phase: 'Running' }),
      pod({ name: 'b', labels: SIGNED, phase: 'Running' }),
    ],
    ready: true,
    blockers: [],
  },
  {
    name: 'a surge rollout of a labelled release (pod and replica counts differ from desired)',
    deployment: deployment({
      generation: 6,
      observedGeneration: 6,
      templateLabels: SIGNED,
      updatedReplicas: 1,
      readyReplicas: 2,
      availableReplicas: 2,
    }),
    pods: [
      pod({ name: 'old-a', labels: SIGNED, phase: 'Running' }),
      pod({ name: 'old-b', labels: SIGNED, phase: 'Running' }),
      pod({ name: 'new-a', labels: SIGNED, phase: 'Pending', ready: false }),
    ],
    ready: true,
    blockers: [],
  },
  {
    name: 'Failed and Succeeded pods, labelled or not, next to a labelled running pod',
    deployment: current,
    pods: [
      pod({ name: 'a', labels: SIGNED, phase: 'Running' }),
      pod({ name: 'evicted', phase: 'Failed', ready: false }),
      pod({ name: 'oom-killed', labels: SIGNED, phase: 'Failed', ready: false }),
      pod({ name: 'completed', phase: 'Succeeded', ready: false }),
    ],
    ready: true,
    blockers: [],
  },
  {
    name: 'a terminating running pod without the label',
    deployment: current,
    pods: [
      pod({ name: 'a', labels: SIGNED, phase: 'Running' }),
      pod({
        name: 'old',
        phase: 'Running',
        deletionTimestamp: new Date('2026-11-21T00:00:00.000Z'),
      }),
    ],
    ready: false,
    blockers: [
      '1 non-terminal pod(s) without clerum.io/rpc-proxy-edge-protocol=signed-assertion-v1: old',
    ],
  },
  {
    name: 'a running pod without the label',
    deployment: current,
    pods: [
      pod({ name: 'a', labels: SIGNED, phase: 'Running' }),
      pod({ name: 'old', phase: 'Running' }),
    ],
    ready: false,
    blockers: [
      '1 non-terminal pod(s) without clerum.io/rpc-proxy-edge-protocol=signed-assertion-v1: old',
    ],
  },
  {
    name: 'a pending pod on a retired protocol value',
    deployment: current,
    pods: [
      pod({ name: 'a', labels: SIGNED, phase: 'Running' }),
      pod({
        name: 'old',
        labels: { [RPC_PROXY_EDGE_PROTOCOL_LABEL]: 'dedicated-header-v1' },
        phase: 'Pending',
        ready: false,
      }),
    ],
    ready: false,
    blockers: [
      '1 non-terminal pod(s) without clerum.io/rpc-proxy-edge-protocol=signed-assertion-v1: old',
    ],
  },
  {
    name: 'a template on a retired protocol value',
    deployment: deployment({
      generation: 5,
      observedGeneration: 5,
      templateLabels: { [RPC_PROXY_EDGE_PROTOCOL_LABEL]: 'dedicated-header-v1' },
    }),
    pods: [pod({ name: 'a', labels: SIGNED, phase: 'Running' })],
    ready: false,
    blockers: [
      'Deployment "rpc-proxy" pod template label clerum.io/rpc-proxy-edge-protocol is "dedicated-header-v1", expected "signed-assertion-v1"',
    ],
  },
  {
    name: 'a template without the label',
    deployment: deployment({ generation: 5, observedGeneration: 5 }),
    pods: [pod({ name: 'a', labels: SIGNED, phase: 'Running' })],
    ready: false,
    blockers: [
      'Deployment "rpc-proxy" pod template label clerum.io/rpc-proxy-edge-protocol is absent, expected "signed-assertion-v1"',
    ],
  },
  {
    name: 'a generation the controller has not observed yet',
    deployment: deployment({ generation: 6, observedGeneration: 5, templateLabels: SIGNED }),
    pods: [pod({ name: 'a', labels: SIGNED, phase: 'Running' })],
    ready: false,
    blockers: ['Deployment "rpc-proxy" status.observedGeneration 5 is below metadata.generation 6'],
  },
  {
    name: 'no generation and no observed generation',
    deployment: deployment({ templateLabels: SIGNED }),
    pods: [pod({ name: 'a', labels: SIGNED, phase: 'Running' })],
    ready: false,
    blockers: ['Deployment "rpc-proxy" has no numeric metadata.generation'],
  },
  {
    name: 'a labelled, observed template scaled to zero with no pods',
    deployment: deployment({
      generation: 5,
      observedGeneration: 5,
      templateLabels: SIGNED,
      replicas: 0,
    }),
    pods: [],
    ready: true,
    blockers: [],
  },
]

describe('rpcProxyProtocolCohortBlockers', () => {
  it.each(cases)('$name -> $ready', ({ deployment, pods, ready, blockers }) => {
    const actual = rpcProxyProtocolCohortBlockers(deployment, pods)
    expect(actual.length === 0).toBe(ready)
    expect(actual).toEqual(blockers)
  })

  it('covers both verdicts', () => {
    expect(cases.filter(row => row.ready)).toHaveLength(4)
    expect(cases.filter(row => !row.ready)).toHaveLength(7)
  })

  it('lists every failed condition when more than one fails', () => {
    expect(
      rpcProxyProtocolCohortBlockers(
        deployment({
          generation: 5,
          observedGeneration: 5,
          templateLabels: { [RPC_PROXY_EDGE_PROTOCOL_LABEL]: 'dedicated-header-v1' },
        }),
        [
          pod({ name: 'a', labels: SIGNED, phase: 'Running' }),
          pod({ name: 'old', phase: 'Running' }),
        ]
      )
    ).toEqual([
      'Deployment "rpc-proxy" pod template label clerum.io/rpc-proxy-edge-protocol is "dedicated-header-v1", expected "signed-assertion-v1"',
      '1 non-terminal pod(s) without clerum.io/rpc-proxy-edge-protocol=signed-assertion-v1: old',
    ])
  })

  it('prints the first ten unlabelled pod names in sorted order and counts the rest', () => {
    const names = Array.from({ length: 12 }, (_, index) => `old-${String(index).padStart(2, '0')}`)
    const shuffled = [...names.slice(6), ...names.slice(0, 6).reverse()]
    expect(
      rpcProxyProtocolCohortBlockers(
        current,
        shuffled.map(name => pod({ name, phase: 'Running' }))
      )
    ).toEqual([
      `12 non-terminal pod(s) without clerum.io/rpc-proxy-edge-protocol=signed-assertion-v1: ${names
        .slice(0, 10)
        .join(', ')} and 2 more`,
    ])
  })

  it('counts unnamed pods and pods in phase Unknown or without a phase as non-terminal', () => {
    expect(
      rpcProxyProtocolCohortBlockers(current, [
        pod({ phase: 'Running' }),
        pod({ name: 'unknown', phase: 'Unknown' }),
        pod({ name: 'no-phase' }),
      ])
    ).toEqual([
      '3 non-terminal pod(s) without clerum.io/rpc-proxy-edge-protocol=signed-assertion-v1: <unnamed>, no-phase, unknown',
    ])
  })

  it('prints an absent observed generation as absent', () => {
    expect(
      rpcProxyProtocolCohortBlockers(deployment({ generation: 5, templateLabels: SIGNED }), [
        pod({ name: 'a', labels: SIGNED, phase: 'Running' }),
      ])
    ).toEqual([
      'Deployment "rpc-proxy" status.observedGeneration absent is below metadata.generation 5',
    ])
  })
})

describe('RPC Proxy runtime RBAC named by the barrier error', () => {
  const manifest = path.resolve(__dirname, '../..', RPC_PROXY_RUNTIME_RBAC_MANIFEST)
  const documents = YAML.parseAllDocuments(readFileSync(manifest, 'utf8')).map(doc => doc.toJS())

  it('declares the Role with the two cohort reads in the RPC Proxy namespace', () => {
    const role = documents.find(
      doc => doc?.kind === 'Role' && doc.metadata?.name === RPC_PROXY_RUNTIME_RBAC_NAME
    )
    expect(role?.metadata?.namespace).toBe('rpc-proxy')
    expect(role?.rules).toEqual(
      expect.arrayContaining([
        { apiGroups: [''], resources: ['pods'], verbs: ['list'] },
        {
          apiGroups: ['apps'],
          resources: ['deployments'],
          resourceNames: ['rpc-proxy'],
          verbs: ['get'],
        },
      ])
    )
  })

  it('binds that Role to the HCC ServiceAccount', () => {
    const binding = documents.find(
      doc => doc?.kind === 'RoleBinding' && doc.metadata?.name === RPC_PROXY_RUNTIME_RBAC_NAME
    )
    const [namespace, name] = RPC_PROXY_RUNTIME_RBAC_SUBJECT.split('/')
    expect(binding?.metadata?.namespace).toBe('rpc-proxy')
    expect(binding?.roleRef).toEqual({
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'Role',
      name: RPC_PROXY_RUNTIME_RBAC_NAME,
    })
    expect(binding?.subjects).toContainEqual({ kind: 'ServiceAccount', name, namespace })
  })
})
