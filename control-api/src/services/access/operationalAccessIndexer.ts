import { config } from '../../config.js'
import type { K8sGateway } from '../../k8s.js'
import type { ClerumResourceType } from '../../types.js'
import { AccessExecutionBudget } from './accessExecutionBudget.js'
import { OperationalAccessIndex } from './operationalAccessIndex.js'
import {
  OPERATIONAL_SOURCE_FAMILIES,
  type OperationalObjectProjection,
  type OperationalSourceFamily,
  canonicalEnvironmentId,
  projectOperationalObject,
} from './operationalAccessProjection.js'

type IndexedPlural = Extract<
  ClerumResourceType,
  'hosts' | 'contexts' | 'mcpservers' | 'workflowrecipes' | 'sharedfilesystems'
>

export type OperationalSourceSpec = Readonly<{
  family: OperationalSourceFamily
  plural: IndexedPlural
  namespace: string
}>

export const operationalSourceSpecs: readonly OperationalSourceSpec[] = Object.freeze([
  { family: 'host', plural: 'hosts', namespace: config.hostsNamespace },
  { family: 'context', plural: 'contexts', namespace: config.contextsNamespace },
  { family: 'mcp_server', plural: 'mcpservers', namespace: config.mcpServersNamespace },
  {
    family: 'workflow_recipe',
    plural: 'workflowrecipes',
    namespace: config.sandboxNamespace,
  },
  {
    family: 'shared_filesystem',
    plural: 'sharedfilesystems',
    namespace: config.sharedFilesystemsNamespace,
  },
])

export type OperationalIndexGateway = Pick<
  K8sGateway,
  'listResourcePage' | 'watchResource' | 'getResourceExact'
>

export class OperationalWatchExpiredError extends Error {
  constructor() {
    super('Operational Kubernetes watch expired')
    this.name = 'OperationalWatchExpiredError'
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function metadataResourceVersion(value: unknown): string {
  const metadata = objectRecord(objectRecord(value).metadata)
  const resourceVersion =
    typeof metadata.resourceVersion === 'string' ? metadata.resourceVersion.trim() : ''
  if (!resourceVersion || resourceVersion.length > 256 || resourceVersion.includes('\0')) {
    throw new Error('operational_object_resource_version_invalid')
  }
  return resourceVersion
}

function watchStatusCode(value: unknown): number | null {
  const record = objectRecord(value)
  const code = Number(record.code)
  return Number.isSafeInteger(code) ? code : null
}

function safeSourceError(error: unknown): string {
  if (error instanceof OperationalWatchExpiredError) return 'watch_expired'
  if (error instanceof Error && error.name === 'AbortError') return 'request_cancelled'
  return 'operational_source_unavailable'
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, milliseconds)
    timer.unref?.()
    function done() {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export class OperationalAccessIndexer {
  private readonly environmentId: string
  private readonly relationshipNamespaces: Readonly<{
    context: string
    mcpServer: string
    sharedFilesystem: string
  }>

  constructor(
    private readonly gateway: OperationalIndexGateway,
    private readonly index: OperationalAccessIndex = new OperationalAccessIndex(),
    options: {
      environmentId?: string
      behaviorFingerprintKey?: string
      retryDelayMs?: number
    } = {}
  ) {
    this.environmentId = options.environmentId ?? canonicalEnvironmentId()
    this.behaviorFingerprintKey = options.behaviorFingerprintKey ?? config.sessionJwtPrivateKey
    this.retryDelayMs = options.retryDelayMs ?? 5_000
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 100) {
      throw new Error('operational index retry delay must be at least 100ms')
    }
    this.relationshipNamespaces = Object.freeze({
      context: config.contextsNamespace,
      mcpServer: config.mcpServersNamespace,
      sharedFilesystem: config.sharedFilesystemsNamespace,
    })
  }

  private readonly behaviorFingerprintKey: string
  private readonly retryDelayMs: number

  private projection(
    spec: OperationalSourceSpec,
    object: unknown,
    maxObjectBytes: number
  ): OperationalObjectProjection {
    return projectOperationalObject({
      environmentId: this.environmentId,
      plural: spec.plural,
      namespace: spec.namespace,
      object,
      behaviorFingerprintKey: this.behaviorFingerprintKey,
      maxObjectBytes,
      relationshipNamespaces: this.relationshipNamespaces,
    })
  }

  async reconcileSource(spec: OperationalSourceSpec, parentSignal?: AbortSignal): Promise<string> {
    const budget = AccessExecutionBudget.create('catalog', { parentSignal })
    try {
      const stagingGeneration = await this.index.beginRelist({
        environmentId: this.environmentId,
        sourceFamily: spec.family,
        budget,
      })
      let continueToken: string | undefined
      let snapshotResourceVersion: string | null = null
      do {
        const timeoutSeconds = Math.max(1, Math.min(60, Math.ceil(budget.remainingMs() / 1_000)))
        const page = await budget.runProducer(signal =>
          this.gateway.listResourcePage(spec.plural, spec.namespace, {
            limit: budget.limits.kubernetesPageSize,
            ...(continueToken ? { continueToken } : {}),
            timeoutSeconds,
            signal,
          })
        )
        if (snapshotResourceVersion && page.resourceVersion !== snapshotResourceVersion) {
          throw new Error('operational_relist_snapshot_changed')
        }
        snapshotResourceVersion ??= page.resourceVersion
        const projections = page.items.map(item => {
          const projection = this.projection(spec, item, budget.limits.objectBytes)
          budget.chargeOperationalObject(projection.contentBytes, false)
          if (projection.relationships.length > 0) {
            budget.charge({
              kind: 'relationships',
              amount: projection.relationships.length,
              authorityRequired: false,
            })
          }
          return projection
        })
        await this.index.stageRelistPage({
          environmentId: this.environmentId,
          sourceFamily: spec.family,
          stagingGeneration,
          projections,
          budget,
        })
        continueToken = page.continueToken ?? undefined
      } while (continueToken)

      if (!snapshotResourceVersion) {
        throw new Error('operational_relist_resource_version_missing')
      }
      await this.index.promoteRelist({
        environmentId: this.environmentId,
        sourceFamily: spec.family,
        stagingGeneration,
        resourceVersion: snapshotResourceVersion,
        budget,
      })
      return snapshotResourceVersion
    } finally {
      budget.close()
    }
  }

  async applyWatchEvent(
    spec: OperationalSourceSpec,
    phase: string,
    object: unknown,
    parentSignal?: AbortSignal
  ): Promise<void> {
    if (phase === 'ERROR') {
      if (watchStatusCode(object) === 410) throw new OperationalWatchExpiredError()
      throw new Error('operational_watch_error')
    }
    if (!['ADDED', 'MODIFIED', 'DELETED', 'BOOKMARK'].includes(phase)) {
      throw new Error('operational_watch_phase_invalid')
    }
    const resourceVersion = metadataResourceVersion(object)
    const budget = AccessExecutionBudget.create('action', { parentSignal })
    try {
      if (phase === 'BOOKMARK') {
        await this.index.recordWatchBookmark({
          environmentId: this.environmentId,
          sourceFamily: spec.family,
          resourceVersion,
          budget,
        })
        return
      }
      const projection = this.projection(spec, object, budget.limits.objectBytes)
      budget.chargeOperationalObject(projection.contentBytes, false)
      if (projection.relationships.length > 0) {
        budget.charge({
          kind: 'relationships',
          amount: projection.relationships.length,
          authorityRequired: false,
        })
      }
      await this.index.applyWatchProjection({
        environmentId: this.environmentId,
        sourceFamily: spec.family,
        resourceVersion,
        projection,
        deleted: phase === 'DELETED',
        budget,
      })
    } finally {
      budget.close()
    }
  }

  async runSourceOnce(spec: OperationalSourceSpec, signal: AbortSignal): Promise<void> {
    const resourceVersion = await this.reconcileSource(spec, signal)
    await this.gateway.watchResource(
      spec.plural,
      spec.namespace,
      resourceVersion,
      signal,
      (phase, object) => this.applyWatchEvent(spec, phase, object, signal)
    )
    if (!signal.aborted) throw new Error('operational_watch_closed')
  }

  start(specs: readonly OperationalSourceSpec[] = operationalSourceSpecs): {
    stop: () => void
    completion: Promise<void>
  } {
    if (
      specs.length !== OPERATIONAL_SOURCE_FAMILIES.length ||
      new Set(specs.map(spec => spec.family)).size !== OPERATIONAL_SOURCE_FAMILIES.length
    ) {
      throw new Error('operational index requires every source family exactly once')
    }
    const controller = new AbortController()
    const loops = specs.map(spec => this.runSourceLoop(spec, controller.signal))
    return {
      stop: () => controller.abort('shutdown'),
      completion: Promise.all(loops).then(() => undefined),
    }
  }

  private async runSourceLoop(spec: OperationalSourceSpec, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runSourceOnce(spec, signal)
      } catch (error) {
        if (signal.aborted) break
        const status = error instanceof OperationalWatchExpiredError ? 'relisting' : 'unavailable'
        const budget = AccessExecutionBudget.create('action', { parentSignal: signal })
        try {
          await this.index.markSourceState({
            environmentId: this.environmentId,
            sourceFamily: spec.family,
            status,
            safeErrorCode: safeSourceError(error),
            budget,
          })
        } catch {
          // The source remains unavailable if even its authoritative state cannot be recorded.
        } finally {
          budget.close()
        }
        await abortableDelay(this.retryDelayMs, signal)
      }
    }
  }
}
