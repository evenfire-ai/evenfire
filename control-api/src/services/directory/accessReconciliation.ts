import { config } from '../../config.js'
import type { K8sGateway } from '../../k8s.js'

type HostResource = {
  metadata?: { name?: string }
  spec?: { enabled?: boolean }
}

type ContextResource = {
  metadata?: { name?: string }
  spec?: { contextId?: string; enabled?: boolean }
}

export type AccessPartition = {
  active: string[]
  deleted: string[]
}

export const MAX_DELETED_ACCESS_HISTORY = 200

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

export async function listActiveAgentNames(gateway: K8sGateway): Promise<string[]> {
  const listed = await gateway.listResource('hosts', config.hostsNamespace)
  const hosts = Array.isArray(listed) ? (listed as HostResource[]) : []
  return normalizeUnique(
    hosts
      .map(host => host?.metadata?.name)
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
