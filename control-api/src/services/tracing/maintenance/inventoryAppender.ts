import type { DbClient } from '../../../db.js'
import type {
  InfrastructureTelemetryEventService,
  TraceMaintenanceInfrastructurePrincipal,
} from '../infrastructureTelemetryEvents.js'
import { canonicalSha256 } from './canonical.js'
import type { InventorySnapshot } from './contracts.js'

export const INVENTORY_APPEND_CHUNK_SIZE = 100

type InventoryAppendService = Pick<InfrastructureTelemetryEventService, 'appendManyInTransaction'>

export async function appendInventorySnapshotInChunks(input: {
  client: DbClient
  service: InventoryAppendService
  principal: TraceMaintenanceInfrastructurePrincipal
  snapshot: InventorySnapshot
  now: Date
  environment: string
  clusterName: string
}): Promise<number> {
  if (input.snapshot.workloads.length === 0) return 0
  const intervalEnd = new Date(Math.floor(input.now.getTime() / 60_000) * 60_000)
  const intervalStart = new Date(intervalEnd.getTime() - 60_000)
  const entries = input.snapshot.workloads.map(workload => {
    const memory = Number(workload.memoryRequestBytes)
    const memoryLimit = Number(workload.memoryLimitBytes)
    if (!Number.isSafeInteger(memory))
      throw new Error('inventory memory request exceeds safe integer range')
    if (!Number.isSafeInteger(memoryLimit))
      throw new Error('inventory memory limit exceeds safe integer range')
    return {
      binding: {
        triggerKind: 'periodic_sample' as const,
        outcome: workload.readyReplicas >= workload.desiredReplicas ? 'healthy' : 'unhealthy',
        reasonCode: input.snapshot.complete ? null : 'inventory_incomplete',
        environment: input.environment,
        clusterName: input.clusterName,
        namespace: workload.namespace,
        workloadKind: workload.workloadKind,
        workloadRef: `${workload.namespace}/${workload.workloadRef}`,
        kubernetesKind: 'Deployment' as const,
        kubernetesName: workload.workloadRef,
        kubernetesUid: workload.kubernetesUid,
        metadataGeneration: workload.metadataGeneration,
        relatedOperationId: null,
        relatedRunId: null,
      },
      input: {
        sourceEventId: `inventory:${canonicalSha256([
          workload.namespace,
          workload.workloadKind,
          workload.workloadRef,
          intervalStart.toISOString(),
        ])}`,
        occurredAt: intervalEnd.toISOString(),
        telemetryType: 'capacity_sample' as const,
        intervalStart: intervalStart.toISOString(),
        intervalEnd: intervalEnd.toISOString(),
        desiredReplicas: workload.desiredReplicas,
        observedReplicas: workload.observedReplicas,
        readyReplicas: workload.readyReplicas,
        cpuRequestCores: Number(workload.cpuRequestNanoCores) / 1_000_000_000,
        cpuLimitCores: Number(workload.cpuLimitNanoCores) / 1_000_000_000,
        memoryRequestBytes: memory,
        memoryLimitBytes: memoryLimit,
        payload: { status: input.snapshot.complete ? 'complete' : 'partial' } as const,
      },
    }
  })

  for (let index = 0; index < entries.length; index += INVENTORY_APPEND_CHUNK_SIZE) {
    const chunk = entries.slice(index, index + INVENTORY_APPEND_CHUNK_SIZE)
    await input.service.appendManyInTransaction(
      input.client,
      input.principal,
      chunk as [(typeof entries)[number], ...Array<(typeof entries)[number]>]
    )
  }
  return input.snapshot.workloads.length
}
