import type { DbClient } from '../../db.js'
import type { InfrastructureTelemetrySubmitterPrincipalV1 } from '../../middleware/tracingSubmitterAuth.js'
import { WorkflowRunBindingRepository } from '../workflowRunBindingRepository.js'
import type {
  InfrastructureTelemetryEventInputV1,
  InfrastructureTelemetryServerBindingV1,
} from './contracts.js'
import { canonicalTracingClusterName, canonicalTracingEnvironment } from './environment.js'
import type { InfrastructureWorkloadBindingResolver } from './routeSubmissionService.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function outcome(phase: string): string {
  if (phase === 'Succeeded') return 'succeeded'
  if (phase === 'Failed') return 'failed'
  if (phase === 'Canceled') return 'stopped'
  if (phase === 'Running') return 'started'
  return 'unknown'
}

export class WrcInfrastructureBindingResolver implements InfrastructureWorkloadBindingResolver {
  private readonly bindings: WorkflowRunBindingRepository

  constructor(
    db: Pick<DbClient, 'query'>,
    private readonly environment = canonicalTracingEnvironment(),
    private readonly clusterName = canonicalTracingClusterName()
  ) {
    this.bindings = new WorkflowRunBindingRepository(db)
  }

  async resolve(
    principal: InfrastructureTelemetrySubmitterPrincipalV1,
    event: InfrastructureTelemetryEventInputV1
  ): Promise<InfrastructureTelemetryServerBindingV1 | null> {
    return (await this.resolveMany(principal, [event]))[0] ?? null
  }

  async resolveMany(
    principal: InfrastructureTelemetrySubmitterPrincipalV1,
    events: readonly InfrastructureTelemetryEventInputV1[]
  ): Promise<readonly (InfrastructureTelemetryServerBindingV1 | null)[]> {
    if (principal.kind !== 'wrc_internal_control') return events.map(() => null)
    const runIds = events
      .map(event => event.workflowRunLookupReference?.runId.trim() ?? '')
      .filter(runId => UUID_PATTERN.test(runId))
      .map(runId => runId.toLowerCase())
    const bindings = await this.bindings.resolveMany(runIds)

    return events.map(event => {
      const runId = event.workflowRunLookupReference?.runId.trim().toLowerCase()
      if (!runId || !UUID_PATTERN.test(runId)) return null
      const binding = bindings.get(runId)
      if (!binding?.recipeNamespace || !binding.recipeName || !binding.phase) return null
      return {
        triggerKind: 'controller_reconcile',
        outcome: event.telemetryType === 'controller_error' ? 'failed' : outcome(binding.phase),
        reasonCode: null,
        environment: this.environment,
        clusterName: this.clusterName,
        namespace: binding.recipeNamespace,
        workloadKind: 'WorkflowRecipe',
        workloadRef: `${binding.recipeNamespace}/${binding.recipeName}`,
        kubernetesKind: 'WorkflowRecipe',
        kubernetesName: binding.recipeName,
        kubernetesUid: null,
        metadataGeneration: null,
        relatedOperationId: null,
        relatedRunId: runId,
      }
    })
  }
}

export class InfrastructureBindingResolverChain implements InfrastructureWorkloadBindingResolver {
  constructor(private readonly resolvers: readonly InfrastructureWorkloadBindingResolver[]) {}

  async resolve(
    principal: InfrastructureTelemetrySubmitterPrincipalV1,
    event: InfrastructureTelemetryEventInputV1
  ): Promise<InfrastructureTelemetryServerBindingV1 | null> {
    return (await this.resolveMany(principal, [event]))[0] ?? null
  }

  async resolveMany(
    principal: InfrastructureTelemetrySubmitterPrincipalV1,
    events: readonly InfrastructureTelemetryEventInputV1[]
  ): Promise<readonly (InfrastructureTelemetryServerBindingV1 | null)[]> {
    const unresolved = new Set(events.map((_, index) => index))
    const results: Array<InfrastructureTelemetryServerBindingV1 | null> = events.map(() => null)
    for (const resolver of this.resolvers) {
      if (unresolved.size === 0) break
      const pendingIndexes = [...unresolved]
      const pendingEvents = pendingIndexes.map(index => events[index]!)
      const resolved = resolver.resolveMany
        ? await resolver.resolveMany(principal, pendingEvents)
        : await Promise.all(pendingEvents.map(event => resolver.resolve(principal, event)))
      if (resolved.length !== pendingEvents.length)
        throw new Error('binding resolver batch mismatch')
      resolved.forEach((binding, offset) => {
        if (!binding) return
        const index = pendingIndexes[offset]!
        results[index] = binding
        unresolved.delete(index)
      })
    }
    return results
  }
}
