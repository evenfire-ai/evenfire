import { config } from '../../src/config.js'
import { K8sNotFoundError, type ResourceListPage } from '../../src/services/resourceService.js'
import type { AccessTransactionTripwire } from './accessTransactionTripwire.js'

export type OperationalPlural =
  | 'hosts'
  | 'contexts'
  | 'mcpservers'
  | 'workflowrecipes'
  | 'sharedfilesystems'

export const OPERATIONAL_NAMESPACES: Readonly<Record<OperationalPlural, string>> = Object.freeze({
  hosts: config.hostsNamespace,
  contexts: config.contextsNamespace,
  mcpservers: config.mcpServersNamespace,
  workflowrecipes: config.sandboxNamespace,
  sharedfilesystems: config.sharedFilesystemsNamespace,
})

type ObjectOptions = Readonly<{
  uid?: string
  resourceVersion?: string
  generation?: number
  deletionTimestamp?: string
  padBytes?: number
}>

function metadata(plural: OperationalPlural, name: string, options: ObjectOptions) {
  return {
    name,
    namespace: OPERATIONAL_NAMESPACES[plural],
    uid: options.uid ?? `uid-${plural}-${name}`,
    resourceVersion: options.resourceVersion ?? '1',
    generation: options.generation ?? 1,
    ...(options.deletionTimestamp ? { deletionTimestamp: options.deletionTimestamp } : {}),
    ...(options.padBytes ? { annotations: { padding: 'x'.repeat(options.padBytes) } } : {}),
  }
}

export function hostObject(
  name: string,
  spec: Readonly<{ contextRef?: string; enabled?: boolean }> = {},
  options: ObjectOptions = {}
) {
  return {
    metadata: metadata('hosts', name, options),
    spec: {
      enabled: spec.enabled ?? true,
      ...(spec.contextRef ? { contextRef: spec.contextRef } : {}),
    },
  }
}

export function contextObject(
  name: string,
  spec: Readonly<{
    contextId?: string
    mcpServers?: readonly string[]
    sharedFileSystems?: readonly string[]
  }> = {},
  options: ObjectOptions = {}
) {
  return {
    metadata: metadata('contexts', name, options),
    spec: {
      ...(spec.contextId ? { contextId: spec.contextId } : {}),
      mcpServers: [...(spec.mcpServers ?? [])],
      sharedFileSystems: (spec.sharedFileSystems ?? []).map(sfs => ({
        name: sfs,
        mountPath: `/mnt/${sfs}`,
      })),
    },
  }
}

export function mcpServerObject(
  name: string,
  spec: Readonly<{ contextRef?: string; url?: string }> = {},
  options: ObjectOptions = {}
) {
  return {
    metadata: metadata('mcpservers', name, options),
    spec: {
      enabled: true,
      auth: { type: 'none' },
      transport: {
        type: 'streamable-http',
        url: spec.url ?? `http://${name}.mcp-server:3000/mcp`,
      },
      ...(spec.contextRef ? { contextRef: spec.contextRef } : {}),
    },
  }
}

export function sharedFilesystemObject(name: string, options: ObjectOptions = {}) {
  return { metadata: metadata('sharedfilesystems', name, options), spec: {} }
}

export function workflowRecipeObject(
  name: string,
  spec: Readonly<{ contextRef?: string; ui?: boolean }> = {},
  options: ObjectOptions = {}
) {
  return {
    metadata: metadata('workflowrecipes', name, options),
    spec: {
      ...(spec.contextRef ? { contextRef: spec.contextRef } : {}),
      ...(spec.ui ? { ui: { workloadRef: `${name}-ui`, port: 8080 } } : {}),
    },
  }
}

export type FakeGatewayCall = Readonly<{
  method: 'getResourceExact' | 'listResourcePage'
  plural: OperationalPlural
  namespace: string
  name?: string
  limit?: number
  continueToken?: string
  timeoutSeconds: number
}>

export type FakeOperationalGatewayOptions = Readonly<{
  objects: Partial<Record<OperationalPlural, readonly unknown[]>>
  tripwire?: AccessTransactionTripwire
  /** Return an error to make that call reject with it. */
  fail?: (call: FakeGatewayCall) => unknown
}>

function nameOf(object: unknown): string {
  return String((object as { metadata?: { name?: unknown } }).metadata?.name ?? '')
}

/**
 * In-memory Kubernetes for the operational loader. LISTs page by `limit` with
 * opaque continue tokens; GETs answer `K8sNotFoundError` for missing objects.
 */
export function createFakeOperationalGateway(options: FakeOperationalGatewayOptions) {
  const objects: Record<OperationalPlural, unknown[]> = {
    hosts: [...(options.objects.hosts ?? [])],
    contexts: [...(options.objects.contexts ?? [])],
    mcpservers: [...(options.objects.mcpservers ?? [])],
    workflowrecipes: [...(options.objects.workflowrecipes ?? [])],
    sharedfilesystems: [...(options.objects.sharedfilesystems ?? [])],
  }
  const calls: FakeGatewayCall[] = []
  const record = (call: FakeGatewayCall) => {
    calls.push(call)
    options.tripwire?.assertOutsideTransaction(
      `${call.method}:${call.plural}${call.name ? `/${call.name}` : ''}`
    )
    const failure = options.fail?.(call)
    if (failure) throw failure
  }
  const gateway = {
    async getResourceExact(
      plural: string,
      name: string,
      namespace: string,
      request: { timeoutSeconds: number; signal: AbortSignal }
    ): Promise<unknown> {
      const typed = plural as OperationalPlural
      record({
        method: 'getResourceExact',
        plural: typed,
        namespace,
        name,
        timeoutSeconds: request.timeoutSeconds,
      })
      const found =
        namespace === OPERATIONAL_NAMESPACES[typed]
          ? objects[typed].find(object => nameOf(object) === name)
          : undefined
      if (!found)
        throw new K8sNotFoundError(`${plural}/${name} not found in namespace ${namespace}`)
      return found
    },
    async listResourcePage(
      plural: string,
      namespace: string,
      request: {
        limit: number
        continueToken?: string
        timeoutSeconds: number
        signal: AbortSignal
      }
    ): Promise<ResourceListPage> {
      const typed = plural as OperationalPlural
      record({
        method: 'listResourcePage',
        plural: typed,
        namespace,
        limit: request.limit,
        ...(request.continueToken ? { continueToken: request.continueToken } : {}),
        timeoutSeconds: request.timeoutSeconds,
      })
      const items = namespace === OPERATIONAL_NAMESPACES[typed] ? objects[typed] : []
      const offset = request.continueToken ? Number(request.continueToken.split(':')[1]) : 0
      const page = items.slice(offset, offset + request.limit)
      const next = offset + request.limit
      return Object.freeze({
        items: Object.freeze(page),
        continueToken: next < items.length ? `${plural}:${next}` : null,
        resourceVersion: '100',
      })
    },
  }
  return { gateway, calls, objects }
}
