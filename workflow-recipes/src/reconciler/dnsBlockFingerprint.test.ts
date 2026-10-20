/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest'
import type { WorkflowRecipeCRD } from '../types'
import { dnsBlockFingerprint } from './dnsBlockFingerprint'

const r = (): WorkflowRecipeCRD =>
  ({
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'r', namespace: 'sandbox-recipes', generation: 3, uid: 'u' },
    spec: { steps: [], workloads: [] },
    status: {
      phase: 'active',
      message: 'ok',
      workflowExecution: { phase: 'completed', message: 'm' },
    },
  }) as unknown as WorkflowRecipeCRD

const boundaryCondition = {
  type: 'InternalDependenciesReady',
  status: 'False',
  reason: 'InvalidInternalDependency',
  message: 'x.mcp-server.svc.cluster.local is not an eligible runtime Service',
}

const mutations: Array<[string, (x: any) => void]> = [
  ['generation', x => (x.metadata.generation = 4)],
  ['status.phase', x => (x.status.phase = 'degraded')],
  ['status.message', x => (x.status.message = 'Policy violation: x')],
  ['workflowExecution.phase', x => (x.status.workflowExecution.phase = 'running')],
  ['workflowExecution.message', x => (x.status.workflowExecution.message = 'other')],
  ['workflow run-id label', x => (x.metadata.labels = { 'clerum.io/workflow-run-id': 'run-9' })],
  ['spec.pluginWorkloadSdk presence', x => (x.spec.pluginWorkloadSdk = {})],
  ['status.pluginWorkloadSdk presence', x => (x.status.pluginWorkloadSdk = { state: 'validated' })],
  [
    'pending transport',
    x =>
      (x.status.conditions = [
        { type: 'TransportExternalEgressReady', status: 'False', reason: 'Pending' },
      ]),
  ],
  ['shared MCP boundary latch', x => (x.status.conditions = [boundaryCondition])],
  [
    'all observed workloads ready',
    x => (x.status.workloads = [{ id: 'a', phase: 'ready', ready: true }]),
  ],
]

describe('dnsBlockFingerprint (#1016)', () => {
  it.each(mutations)('changes when %s changes', (_n, mutate) => {
    const a = r()
    const b = r()
    mutate(b)
    expect(dnsBlockFingerprint(b, {})).not.toBe(dnsBlockFingerprint(a, {}))
  })

  it('changes when one observed workload stops being ready', () => {
    const a: any = r()
    const b: any = r()
    a.status.workloads = [{ id: 'a', phase: 'ready', ready: true }]
    b.status.workloads = [
      { id: 'a', phase: 'ready', ready: true },
      { id: 'b', ready: false },
    ]
    expect(dnsBlockFingerprint(b, {})).not.toBe(dnsBlockFingerprint(a, {}))
  })

  it('changes with the SDK feature flag', () => {
    expect(dnsBlockFingerprint(r(), { pluginWorkloadSdkEnabled: true })).not.toBe(
      dnsBlockFingerprint(r(), { pluginWorkloadSdkEnabled: false })
    )
  })

  it('is stable for identical input', () => {
    expect(dnsBlockFingerprint(r(), {})).toBe(dnsBlockFingerprint(r(), {}))
  })

  it('ignores fields no guard reads', () => {
    const b: any = r()
    b.metadata.resourceVersion = '99'
    expect(dnsBlockFingerprint(b, {})).toBe(dnsBlockFingerprint(r(), {}))
  })
})
