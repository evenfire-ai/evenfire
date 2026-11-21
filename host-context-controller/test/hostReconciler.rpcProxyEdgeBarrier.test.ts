import { describe, expect, it } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import {
  RPC_PROXY_EDGE_PROTOCOL_LABEL,
  RPC_PROXY_EDGE_PROTOCOL_V1,
  rpcProxyProtocolCohortIsReady,
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
  name: string
  labels?: Record<string, string>
  phase: string
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
}> = [
  {
    name: 'a current, observed, fully labelled cohort',
    deployment: current,
    pods: [
      pod({ name: 'a', labels: SIGNED, phase: 'Running' }),
      pod({ name: 'b', labels: SIGNED, phase: 'Running' }),
    ],
    ready: true,
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
  },
  {
    name: 'a running pod without the label',
    deployment: current,
    pods: [
      pod({ name: 'a', labels: SIGNED, phase: 'Running' }),
      pod({ name: 'old', phase: 'Running' }),
    ],
    ready: false,
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
  },
  {
    name: 'a template without the label',
    deployment: deployment({ generation: 5, observedGeneration: 5 }),
    pods: [pod({ name: 'a', labels: SIGNED, phase: 'Running' })],
    ready: false,
  },
  {
    name: 'a generation the controller has not observed yet',
    deployment: deployment({ generation: 6, observedGeneration: 5, templateLabels: SIGNED }),
    pods: [pod({ name: 'a', labels: SIGNED, phase: 'Running' })],
    ready: false,
  },
  {
    name: 'no generation and no observed generation',
    deployment: deployment({ templateLabels: SIGNED }),
    pods: [pod({ name: 'a', labels: SIGNED, phase: 'Running' })],
    ready: false,
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
  },
]

describe('rpcProxyProtocolCohortIsReady', () => {
  it.each(cases)('$name -> $ready', ({ deployment, pods, ready }) => {
    expect(rpcProxyProtocolCohortIsReady(deployment, pods)).toBe(ready)
  })

  it('covers both verdicts', () => {
    expect(cases.filter(row => row.ready)).toHaveLength(4)
    expect(cases.filter(row => !row.ready)).toHaveLength(7)
  })
})
