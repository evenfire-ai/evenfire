import { config } from '../../config.js'
import { makeHostSubjectId } from '../../gfs/hostSubject.js'
import type { K8sGateway } from '../../k8s.js'

type HostResource = {
  metadata?: {
    name?: string
    namespace?: string
    deletionTimestamp?: string | null
  }
  spec?: { enabled?: boolean; host?: string }
}

type ContextResource = {
  metadata?: { name?: string }
  spec?: { contextId?: string; enabled?: boolean }
}

export type AccessPartition = {
  active: string[]
  deleted: string[]
}

export type AgentDirectoryEntry = {
  name: string
  namespace: string
  displayName: string
  active: true
  gfsSubject: {
    type: 'host'
    id: string
  }
}

// The legacy shared credential was never an individual Host identity. Keeping
// it out of the directory prevents callers from turning fleet-wide history into
// a selectable per-agent grant target.
const LEGACY_FLEET_WIDE_HOST_SENTINEL = 'standalone'

export function buildAgentDirectoryEntry(
  value: unknown,
  trustedNamespace: string
): AgentDirectoryEntry | null {
  if (!value || typeof value !== 'object') return null
  const host = value as HostResource
  const name = typeof host.metadata?.name === 'string' ? host.metadata.name : ''
  const reportedNamespace = host.metadata?.namespace

  if (!name || (trustedNamespace === 'mcp-host' && name === LEGACY_FLEET_WIDE_HOST_SENTINEL))
    return null
  if (reportedNamespace !== trustedNamespace) return null
  if (host.metadata?.deletionTimestamp) return null
  if (host.spec?.enabled === false) return null

  const subjectId = makeHostSubjectId('1st', trustedNamespace, name)
  if (!subjectId) return null

  const configuredDisplayName = typeof host.spec?.host === 'string' ? host.spec.host.trim() : ''
  return {
    name,
    namespace: trustedNamespace,
    displayName: configuredDisplayName || name,
    active: true,
    gfsSubject: { type: 'host', id: subjectId },
  }
}

export const MAX_DELETED_ACCESS_HISTORY = 200

export class DeletedAgentHistoryLimitError extends Error {
  constructor(public readonly limit: number) {
    super(`deleted agent history exceeds the ${limit}-entry limit`)
    this.name = 'DeletedAgentHistoryLimitError'
  }
}

export function normalizeUnique(values: unknown[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const value of values) {
    const item = String(value || '').trim()
    if (!item || seen.has(item)) continue
    seen.add(item)
    normalized.push(item)
  }
  return normalized
}

export function accessValueSetsEqual(left: unknown[], right: unknown[]): boolean {
  const normalizedLeft = normalizeUnique(left)
  const normalizedRight = normalizeUnique(right)
  if (normalizedLeft.length !== normalizedRight.length) return false
  const rightSet = new Set(normalizedRight)
  return normalizedLeft.every(value => rightSet.has(value))
}

export function filterAccessValues(
  values: unknown,
  activeValues: ReadonlySet<string> | null
): string[] {
  const deduped = Array.isArray(values) ? normalizeUnique(values) : []
  if (!activeValues) return deduped
  return deduped.filter(value => activeValues.has(value))
}

export function partitionAccessValues(
  assignedValues: unknown[],
  activeValues: Iterable<string>
): AccessPartition {
  const activeSet = new Set(normalizeUnique(Array.from(activeValues)))
  const active: string[] = []
  const deleted: string[] = []
  for (const value of normalizeUnique(assignedValues)) {
    if (activeSet.has(value)) {
      active.push(value)
    } else {
      deleted.push(value)
    }
  }
  return { active, deleted }
}

export function mergeActiveUpdateWithDeletedHistory(
  requestedValues: unknown[],
  activeValues: Iterable<string>,
  deletedHistory: unknown[]
): string[] {
  const activeSet = new Set(normalizeUnique(Array.from(activeValues)))
  const activeRequested = normalizeUnique(requestedValues).filter(value => activeSet.has(value))
  const retainedDeletedHistory = normalizeUnique(deletedHistory)
    .filter(value => !activeSet.has(value))
    .slice(0, MAX_DELETED_ACCESS_HISTORY)
  return normalizeUnique([...activeRequested, ...retainedDeletedHistory])
}

/** Agent grants must never silently discard retained deleted-host history. */
export function mergeActiveAgentUpdateWithDeletedHistory(
  requestedValues: unknown[],
  activeValues: Iterable<string>,
  deletedHistory: unknown[]
): string[] {
  const activeSet = new Set(normalizeUnique(Array.from(activeValues)))
  const retainedDeletedHistory = normalizeUnique(deletedHistory).filter(
    value => !activeSet.has(value)
  )
  if (retainedDeletedHistory.length > MAX_DELETED_ACCESS_HISTORY) {
    throw new DeletedAgentHistoryLimitError(MAX_DELETED_ACCESS_HISTORY)
  }
  const activeRequested = normalizeUnique(requestedValues).filter(value => activeSet.has(value))
  return normalizeUnique([...activeRequested, ...retainedDeletedHistory])
}

// A namespace-scoped list query already guarantees every returned Host lives
// in the queried namespace, so a resource that omits `metadata.namespace` is
// still first-party. Default it to the scoped namespace before running the
// strict directory-entry filter. buildAgentDirectoryEntry itself stays strict
// (an absent namespace is rejected) for callers that resolve a single Host
// from a broader or untrusted source.
function withScopedNamespace(host: HostResource, scopedNamespace: string): HostResource {
  if (host?.metadata?.namespace) return host
  return { ...host, metadata: { ...host?.metadata, namespace: scopedNamespace } }
}

export async function listActiveAgentNames(gateway: K8sGateway): Promise<string[]> {
  const listed = await gateway.listResource('hosts', config.hostsNamespace)
  const hosts = Array.isArray(listed) ? (listed as HostResource[]) : []
  return normalizeUnique(
    hosts
      .map(
        host =>
          buildAgentDirectoryEntry(
            withScopedNamespace(host, config.hostsNamespace),
            config.hostsNamespace
          )?.name
      )
      .filter((value): value is string => typeof value === 'string')
  )
}

export async function listActiveContextIds(gateway: K8sGateway): Promise<string[]> {
  const listed = await gateway.listResource('contexts', config.contextsNamespace)
  const contexts = Array.isArray(listed) ? (listed as ContextResource[]) : []
  return normalizeUnique(
    contexts
      .map(context => context?.metadata?.name)
      .filter((value): value is string => typeof value === 'string')
  )
}

export async function partitionAgentAccess(
  gateway: K8sGateway,
  agentNames: unknown[]
): Promise<AccessPartition> {
  return partitionAccessValues(agentNames, await listActiveAgentNames(gateway))
}

export async function partitionContextAccess(
  gateway: K8sGateway,
  contextIds: unknown[]
): Promise<AccessPartition> {
  return partitionAccessValues(contextIds, await listActiveContextIds(gateway))
}
