import { describe, expect, it, vi } from 'vitest'
import type { V1Deployment } from '@kubernetes/client-node'
import type {
  DailyCostKey,
  NormalizedGcpBillingRow,
  PersistedDailyCostVersion,
} from '../src/services/tracing/maintenance/contracts.js'
import { reconcileNormalizedGcpBilling } from '../src/services/tracing/maintenance/gcpBillingReconciliation.js'
import { appendInventorySnapshotInChunks } from '../src/services/tracing/maintenance/inventoryAppender.js'
import {
  AllowlistedDeploymentInventoryCache,
  type DeploymentInventorySource,
  deploymentToInventoryWorkload,
} from '../src/services/tracing/maintenance/inventorySampler.js'
import { selectPeriodCosts } from '../src/services/tracing/maintenance/periodSelection.js'
import { estimateRequestedCapacityDaily } from '../src/services/tracing/maintenance/requestedCapacityEstimate.js'
import { runRetentionBatch } from '../src/services/tracing/maintenance/retention.js'

const key: DailyCostKey = {
  utcDay: '2026-07-10',
  cloudProvider: 'gcp',
  cloudProjectId: 'project-1',
  clusterLocation: 'europe-west1',
  clusterName: 'cluster-1',
  environment: 'test',
  namespace: 'control-plane',
  workloadKind: 'Deployment',
  workloadRef: 'control-api',
  currency: 'USD',
}
const sha = 'a'.repeat(64)

type FakeInformerHandler = () => void

class FakeDeploymentInformer {
  private readonly handlers = new Map<string, FakeInformerHandler[]>()

  constructor(private readonly deployments: readonly V1Deployment[]) {}

  on(event: string, handler: FakeInformerHandler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
  }

  async start(): Promise<void> {
    for (const handler of this.handlers.get('connect') ?? []) handler()
  }

  async stop(): Promise<void> {}

  list(namespace?: string): readonly V1Deployment[] {
    return this.deployments.filter(deployment =>
      namespace ? deployment.metadata?.namespace === namespace : true
    )
  }
}

function deployment(input: {
  namespace: string
  name: string
  labels?: Record<string, string>
  cpu?: string
  memory?: string
  replicas?: number
  observedReplicas?: number
  readyReplicas?: number
  resourceVersion?: string
  uid?: string
  generation?: number
  cpuLimit?: string
  memoryLimit?: string
}): V1Deployment {
  return {
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: input.labels,
      resourceVersion: input.resourceVersion,
      uid: input.uid,
      generation: input.generation,
    },
    spec: {
      replicas: input.replicas,
      template: {
        metadata: {},
        spec: {
          containers: [
            {
              name: 'main',
              image: 'test',
              resources: {
                requests: { cpu: input.cpu, memory: input.memory },
                limits: { cpu: input.cpuLimit, memory: input.memoryLimit },
              },
            },
          ],
        },
      },
    },
    status: { replicas: input.observedReplicas, readyReplicas: input.readyReplicas },
  }
}

function source(input: {
  namespace: string
  deployments: readonly V1Deployment[]
  include: DeploymentInventorySource['include']
  requiredNames?: readonly string[]
}): DeploymentInventorySource {
  return {
    namespace: input.namespace,
    informer: new FakeDeploymentInformer(
      input.deployments
    ) as DeploymentInventorySource['informer'],
    include: input.include,
    requiredNames: input.requiredNames ? new Set(input.requiredNames) : undefined,
  }
}

describe('trace maintenance cost contracts', () => {
  it('chunks 101 inventory appends at 100 while preserving full count and deterministic order', async () => {
    const appendManyInTransaction = vi.fn().mockResolvedValue([])
    const client = { query: vi.fn() } as never
    const workloads = Array.from({ length: 101 }, (_, index) => ({
      namespace: 'mcp-server' as const,
      workloadKind: 'Deployment' as const,
      workloadRef: `worker-${String(index).padStart(3, '0')}`,
      kubernetesUid: `uid-${index}`,
      metadataGeneration: index + 1,
      desiredReplicas: 1,
      observedReplicas: 1,
      readyReplicas: index % 2,
      cpuRequestNanoCores: 100_000_000n + BigInt(index),
      cpuLimitNanoCores: 200_000_000n + BigInt(index),
      memoryRequestBytes: 134_217_728n + BigInt(index),
      memoryLimitBytes: 268_435_456n + BigInt(index),
      stableLabels: {},
    }))

    await expect(
      appendInventorySnapshotInChunks({
        client,
        service: { appendManyInTransaction } as never,
        principal: {
          kind: 'trace_maintenance',
          sourceService: 'control-api',
          serviceSub: 'trace-maintenance-worker',
          credentialId: 'in-process',
          resourceAuthority: 'control_plane_inventory',
          allowedTelemetryTypes: ['capacity_sample'],
        },
        snapshot: {
          observedAt: '2026-07-10T12:00:30.000Z',
          resourceVersion: 'rv-101',
          complete: true,
          workloads,
          omittedAllowlistedWorkloads: [],
        },
        now: new Date('2026-07-10T12:00:30.123Z'),
        environment: 'test',
        clusterName: 'cluster-1',
      })
    ).resolves.toBe(101)

    expect(appendManyInTransaction).toHaveBeenCalledTimes(2)
    expect(appendManyInTransaction.mock.calls.map(call => call[2])).toHaveLength(2)
    expect(appendManyInTransaction.mock.calls[0]![2]).toHaveLength(100)
    expect(appendManyInTransaction.mock.calls[1]![2]).toHaveLength(1)
    const appended = appendManyInTransaction.mock.calls.flatMap(call => call[2])
    expect(appended.map(entry => entry.binding.workloadRef)).toEqual(
      workloads.map(workload => `${workload.namespace}/${workload.workloadRef}`)
    )
    expect(new Set(appended.map(entry => entry.input.sourceEventId)).size).toBe(101)
    expect(appended[0]!.binding).toMatchObject({
      environment: 'test',
      clusterName: 'cluster-1',
      workloadRef: 'mcp-server/worker-000',
      kubernetesUid: 'uid-0',
      metadataGeneration: 1,
    })
    expect(appended[0]!.input).toMatchObject({
      observedReplicas: 1,
      cpuLimitCores: 0.2,
      memoryLimitBytes: 268_435_456,
    })
    expect(appended.at(-1)!.binding.workloadRef).toBe('mcp-server/worker-100')
  })

  it('runs bounded retention through database retention functions only', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 3 })
      .mockResolvedValueOnce({ rows: [], rowCount: 4 })
      .mockResolvedValueOnce({ rows: [], rowCount: 5 })
    await expect(runRetentionBatch({ query }, new Date('2026-07-11T00:00:00Z'))).resolves.toEqual({
      eventsDeleted: 6,
      costsDeleted: 4,
      promptsDeleted: 5,
      saturatedGrains: [],
    })
    expect(query).toHaveBeenCalledTimes(5)
    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([
      'SELECT event_id FROM governed_trace_prune_expired_events($1, $2)',
      'SELECT event_id FROM governed_trace_prune_expired_events($1, $2)',
      'SELECT event_id FROM governed_trace_prune_expired_events($1, $2)',
      'SELECT id FROM governed_trace_prune_expired_costs($1)',
      'SELECT approval_request_id FROM governed_trace_prune_expired_prompts($1)',
    ])
    expect(query.mock.calls.map(([, params]) => params)).toEqual([
      ['agent_run', 200],
      ['administrative', 200],
      ['infrastructure_telemetry', 200],
      [200],
      [200],
    ])
    expect(query.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toMatch(
      /set_config|DELETE/i
    )
  })

  it('reclaims unused grain capacity without exceeding the 1000-row wake budget', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 200 })
      .mockResolvedValueOnce({ rows: [], rowCount: 12 })
      .mockResolvedValueOnce({ rows: [], rowCount: 200 })
      .mockResolvedValueOnce({ rows: [], rowCount: 200 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 200 })
      .mockResolvedValueOnce({ rows: [], rowCount: 188 })

    await expect(runRetentionBatch({ query })).resolves.toEqual({
      eventsDeleted: 800,
      costsDeleted: 200,
      promptsDeleted: 0,
      saturatedGrains: ['agent_run', 'infrastructure_telemetry', 'infrastructure_cost'],
    })
    expect(query.mock.calls.map(([, params]) => params)).toEqual([
      ['agent_run', 200],
      ['administrative', 200],
      ['infrastructure_telemetry', 200],
      [200],
      [200],
      ['agent_run', 200],
      ['infrastructure_telemetry', 188],
    ])
    expect(query.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toMatch(/COUNT\s*\(/i)
  })

  it('uses the full bounded wake budget for a single backlogged grain', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 200 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 200 })
      .mockResolvedValueOnce({ rows: [], rowCount: 200 })
      .mockResolvedValueOnce({ rows: [], rowCount: 200 })
      .mockResolvedValueOnce({ rows: [], rowCount: 200 })

    await expect(runRetentionBatch({ query })).resolves.toEqual({
      eventsDeleted: 1_000,
      costsDeleted: 0,
      promptsDeleted: 0,
      saturatedGrains: ['agent_run'],
    })
    expect(query).toHaveBeenCalledTimes(9)
    expect(query.mock.calls.reduce((sum, [, params]) => sum + Number(params?.at(-1)), 0)).toBe(
      1_800
    )
  })

  it('normalizes Kubernetes resource quantities and strips high-cardinality labels', () => {
    const workload = deploymentToInventoryWorkload({
      metadata: {
        name: 'control-api',
        namespace: 'control-plane',
        uid: 'deployment-uid',
        generation: 9,
        labels: {
          app: 'control-api',
          'clerum.io/managed-by': 'control-api',
          run_id: 'forbidden',
          'clerum.io/human': 'forbidden',
          'clerum.io/team': 'forbidden',
        },
      },
      spec: {
        replicas: 2,
        template: {
          metadata: {},
          spec: {
            containers: [
              {
                name: 'api',
                image: 'test',
                resources: {
                  requests: { cpu: '500m', memory: '1.5Gi' },
                  limits: { cpu: '2', memory: '2Gi' },
                },
              },
            ],
          },
        },
      },
      status: { replicas: 2, readyReplicas: 1 },
    })
    expect(workload).toMatchObject({
      cpuRequestNanoCores: 500_000_000n,
      cpuLimitNanoCores: 2_000_000_000n,
      memoryRequestBytes: 1_610_612_736n,
      memoryLimitBytes: 2_147_483_648n,
      kubernetesUid: 'deployment-uid',
      metadataGeneration: 9,
      observedReplicas: 2,
      stableLabels: { app: 'control-api', 'clerum.io/managed-by': 'control-api' },
    })
  })

  it('samples static control-plane plus HCC and WRC managed Deployments by namespace', async () => {
    const cache = AllowlistedDeploymentInventoryCache.forSources([
      source({
        namespace: 'control-plane',
        deployments: [
          deployment({
            namespace: 'control-plane',
            name: 'control-api',
            labels: { app: 'control-api' },
            cpu: '250m',
            memory: '256Mi',
            replicas: 2,
            readyReplicas: 2,
            resourceVersion: '10',
          }),
          deployment({
            namespace: 'control-plane',
            name: 'foreign-control',
            labels: { app: 'foreign-control' },
          }),
        ],
        requiredNames: ['control-api'],
        include: item => item.metadata?.name === 'control-api',
      }),
      source({
        namespace: 'mcp-server',
        deployments: [
          deployment({
            namespace: 'mcp-server',
            name: 'chatllm',
            labels: {
              'clerum.io/managed-by': 'host-context-controller',
              'clerum.io/team': 'forbidden',
            },
            cpu: '1',
            memory: '1Gi',
            replicas: 1,
            readyReplicas: 1,
            resourceVersion: '20',
          }),
          deployment({
            namespace: 'mcp-server',
            name: 'manual',
            labels: { 'clerum.io/managed-by': 'operator' },
          }),
        ],
        include: item =>
          item.metadata?.labels?.['clerum.io/managed-by'] === 'host-context-controller',
      }),
      source({
        namespace: 'sandbox-recipes',
        deployments: [
          deployment({
            namespace: 'sandbox-recipes',
            name: 'workflow-child',
            labels: {
              'clerum.io/managed-by': 'wrc',
              'clerum.io/human': 'forbidden',
              run_id: 'forbidden',
            },
            cpu: '750m',
            memory: '128Mi',
            replicas: 3,
            readyReplicas: 2,
            resourceVersion: '30',
          }),
          deployment({
            namespace: 'sandbox-recipes',
            name: 'hcc-network-helper',
            labels: { 'clerum.io/managed-by': 'host-context-controller' },
          }),
        ],
        include: item => item.metadata?.labels?.['clerum.io/managed-by'] === 'wrc',
      }),
    ])

    await cache.start()
    const snapshot = cache.snapshot(new Date('2026-07-10T12:00:00Z'))

    expect(snapshot).toMatchObject({
      complete: true,
      omittedAllowlistedWorkloads: [],
      resourceVersion:
        'control-plane/control-api@10:mcp-server/chatllm@20:sandbox-recipes/workflow-child@30',
    })
    expect(
      snapshot.workloads.map(workload => `${workload.namespace}/${workload.workloadRef}`)
    ).toEqual(['control-plane/control-api', 'mcp-server/chatllm', 'sandbox-recipes/workflow-child'])
    expect(snapshot.workloads.map(workload => workload.cpuRequestNanoCores)).toEqual([
      250_000_000n,
      1_000_000_000n,
      750_000_000n,
    ])
    expect(snapshot.workloads.map(workload => workload.memoryRequestBytes)).toEqual([
      268_435_456n,
      1_073_741_824n,
      134_217_728n,
    ])
    expect(snapshot.workloads[1]!.stableLabels).toEqual({
      'clerum.io/managed-by': 'host-context-controller',
    })
    expect(snapshot.workloads[2]!.stableLabels).toEqual({ 'clerum.io/managed-by': 'wrc' })
  })

  it('marks inventory incomplete when a namespace informer is not connected or allowlisted work is missing', async () => {
    const cache = AllowlistedDeploymentInventoryCache.forSources([
      source({
        namespace: 'control-plane',
        deployments: [],
        requiredNames: ['control-api'],
        include: item => item.metadata?.name === 'control-api',
      }),
      source({
        namespace: 'mcp-server',
        deployments: [
          deployment({
            namespace: 'mcp-server',
            name: 'chatllm',
            labels: { 'clerum.io/managed-by': 'host-context-controller' },
          }),
        ],
        include: item =>
          item.metadata?.labels?.['clerum.io/managed-by'] === 'host-context-controller',
      }),
    ])

    const snapshot = cache.snapshot(new Date('2026-07-10T12:00:00Z'))

    expect(snapshot.complete).toBe(false)
    expect(snapshot.omittedAllowlistedWorkloads).toEqual(['control-plane/control-api'])
    expect(
      snapshot.workloads.map(workload => `${workload.namespace}/${workload.workloadRef}`)
    ).toEqual(['mcp-server/chatllm'])
  })

  it('values requested CPU and memory with immutable selected snapshots', () => {
    const result = estimateRequestedCapacityDaily({
      key,
      clusterClass: 'gke-standard',
      intervalStart: '2026-07-10T00:00:00Z',
      intervalEnd: '2026-07-10T01:00:00Z',
      asOfUtc: '2026-07-10T02:00:00Z',
      desiredReplicas: 2,
      cpuRequestNanoCores: 1_000_000_000n,
      memoryRequestBytes: 1_073_741_824n,
      publicationState: 'provisional',
      completenessStatus: 'complete',
      sourceCount: 1,
      sourceSha256: sha,
      priceSnapshots: [
        {
          id: 'cpu-v1',
          cloudProvider: 'gcp',
          cloudProjectId: 'project-1',
          region: 'europe-west1',
          clusterClass: 'gke-standard',
          resourceClass: 'cpu',
          unit: 'vCPU_hour',
          unitPrice: '1.000000000',
          currency: 'USD',
          effectiveFrom: '2026-01-01T00:00:00Z',
          sourceRef: 'fixture',
          sourceSha256: sha,
        },
        {
          id: 'memory-v1',
          cloudProvider: 'gcp',
          cloudProjectId: 'project-1',
          region: 'europe-west1',
          clusterClass: 'gke-standard',
          resourceClass: 'memory',
          unit: 'GiB_hour',
          unitPrice: '0.500000000',
          currency: 'USD',
          effectiveFrom: '2026-01-01T00:00:00Z',
          sourceRef: 'fixture',
          sourceSha256: sha,
        },
      ],
    })
    expect(result).toMatchObject({
      valuationKind: 'estimated',
      selectedBasis: 'requested_capacity',
      grossAmount: '3.000000000',
    })
  })

  it('preserves GCP credits and allocation buckets with exact conservation', () => {
    const row = (
      amount: string,
      costType: NormalizedGcpBillingRow['costType'],
      allocationStatus: NormalizedGcpBillingRow['allocationStatus']
    ): NormalizedGcpBillingRow => ({
      schemaVersion: 'gcp-billing-v1',
      usageUtcDay: key.utcDay,
      cloudProjectId: key.cloudProjectId,
      clusterLocation: key.clusterLocation,
      clusterName: key.clusterName,
      environment: key.environment,
      namespace: key.namespace,
      workloadKind: key.workloadKind,
      workloadRef: key.workloadRef,
      providerService: 'GKE',
      providerSku: 'compute',
      currency: key.currency,
      costType,
      allocationStatus,
      amount,
      sourceRowCount: 1,
      sourceSha256: sha,
      billingViewVersion: 'v1',
      exportWatermark: '2026-07-11T00:00:00Z',
    })
    const result = reconcileNormalizedGcpBilling({
      key,
      asOfUtc: '2026-07-11T01:00:00Z',
      publicationState: 'finalized',
      rows: [
        row('10', 'usage', 'kube:system-overhead'),
        row('-2', 'credit', 'kube:unallocated'),
        row('1', 'usage', 'goog-k8s-unsupported-sku'),
        row('-0.5', 'adjustment', 'missing-label'),
      ],
    })
    expect(result).toMatchObject({
      grossAmount: '11.000000000',
      creditsAmount: '-2.500000000',
      netAmount: '8.500000000',
    })
    expect(result.components.map(component => component.allocationBucket)).toEqual([
      'kube:system-overhead',
      'kube:unallocated',
      'unsupported',
      'adjustment',
    ])
  })

  it('selects a reproducible finalized period vector without mixing dimensions', () => {
    const daily = (utcDay: string, id: string): PersistedDailyCostVersion => ({
      id,
      rollupVersion: 1,
      predecessorVersion: null,
      key: { ...key, utcDay },
      valuationKind: 'billed',
      selectedBasis: 'gcp_request_allocation',
      publicationState: 'finalized',
      completenessStatus: 'complete',
      asOfUtc: `${utcDay}T23:59:59Z`,
      sourceIntervalStart: null,
      sourceIntervalEnd: null,
      billingExportWatermark: `${utcDay}T23:59:59Z`,
      sourceCount: 1,
      sourceSha256: sha,
      grossAmount: '2',
      creditsAmount: '-0.5',
      netAmount: '1.5',
      components: [],
    })
    const result = selectPeriodCosts('week', '2026-07-07', '2026-07-14', [
      daily('2026-07-10', 'd1'),
      daily('2026-07-11', 'd2'),
    ])
    expect(result).toMatchObject({
      publicationState: 'finalized',
      grossAmount: '4.000000000',
      creditsAmount: '-1.000000000',
      netAmount: '3.000000000',
    })
    expect(result.dailyVersionVector).toHaveLength(2)
  })
})
