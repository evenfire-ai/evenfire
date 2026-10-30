/**
 * An in-memory stand-in for the apiserver's custom-objects endpoints, for driving
 * the real `ResourceService`. It keeps what the routes under test depend on: objects
 * keyed by plural, namespace and name; a server-assigned uid and a resourceVersion
 * that advances on every write; and a replace that answers 409 when the body's
 * `metadata.resourceVersion` or `metadata.uid` no longer matches the stored object,
 * as the apiserver does.
 *
 * `hooks.beforeCall` runs before every call and may await, so a test can park a
 * request between two of its apiserver calls and let another actor write.
 */
import { vi } from 'vitest'
import { ResourceService } from '../../src/services/resourceService.js'

type Obj = Record<string, unknown> & {
  metadata: Record<string, unknown> & { name: string; uid?: string; resourceVersion?: string }
}

type CallArgs = { plural: string; namespace: string; name?: string; body?: unknown }

export type ApiserverVerb = 'get' | 'list' | 'create' | 'replace' | 'delete'

function apiError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code })
}

export function fakeCustomObjectsApiserver(
  opts: {
    namespaces?: Partial<Record<'contexts' | 'mcpservers', string>>
    defaultNamespace?: string
  } = {}
) {
  let rv = 0
  let uidSeq = 0
  const store = new Map<string, Obj>()
  const key = (plural: string, ns: string, name: string) => `${plural}/${ns}/${name}`
  const hooks: {
    beforeCall?: (verb: ApiserverVerb, args: CallArgs) => Promise<void> | void
  } = {}

  const customApi = {
    getNamespacedCustomObject: vi.fn(async (args: CallArgs) => {
      await hooks.beforeCall?.('get', args)
      const obj = store.get(key(args.plural, args.namespace, args.name!))
      if (!obj) throw apiError(404, `${args.plural} "${args.name}" not found`)
      return structuredClone(obj)
    }),
    listNamespacedCustomObject: vi.fn(async (args: CallArgs) => {
      await hooks.beforeCall?.('list', args)
      const prefix = `${args.plural}/${args.namespace}/`
      return {
        items: [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([, v]) => structuredClone(v)),
      }
    }),
    createNamespacedCustomObject: vi.fn(async (args: CallArgs) => {
      await hooks.beforeCall?.('create', args)
      const body = args.body as Obj
      const k = key(args.plural, args.namespace, body.metadata.name)
      if (store.has(k)) throw apiError(409, `${args.plural} "${body.metadata.name}" already exists`)
      const stored: Obj = {
        ...structuredClone(body),
        metadata: {
          ...structuredClone(body.metadata),
          namespace: args.namespace,
          uid: `uid-${body.metadata.name}-${++uidSeq}`,
          resourceVersion: String(++rv),
        },
      }
      store.set(k, stored)
      return structuredClone(stored)
    }),
    replaceNamespacedCustomObject: vi.fn(async (args: CallArgs) => {
      await hooks.beforeCall?.('replace', args)
      const body = args.body as Obj
      const k = key(args.plural, args.namespace, args.name!)
      const existing = store.get(k)
      if (!existing) throw apiError(404, `${args.plural} "${args.name}" not found`)
      if (
        (body.metadata.resourceVersion !== undefined &&
          body.metadata.resourceVersion !== existing.metadata.resourceVersion) ||
        (body.metadata.uid !== undefined && body.metadata.uid !== existing.metadata.uid)
      ) {
        throw apiError(409, `Operation cannot be fulfilled on ${args.plural} "${args.name}"`)
      }
      const stored: Obj = {
        ...structuredClone(body),
        metadata: {
          ...structuredClone(body.metadata),
          name: args.name!,
          namespace: args.namespace,
          uid: existing.metadata.uid,
          resourceVersion: String(++rv),
        },
      }
      store.set(k, stored)
      return structuredClone(stored)
    }),
    deleteNamespacedCustomObject: vi.fn(async (args: CallArgs) => {
      await hooks.beforeCall?.('delete', args)
      const k = key(args.plural, args.namespace, args.name!)
      if (!store.delete(k)) throw apiError(404, `${args.plural} "${args.name}" not found`)
      return { status: 'Success' }
    }),
  }

  const namespaces = opts.namespaces ?? {}
  const defaultNamespace = opts.defaultNamespace ?? namespaces.contexts ?? 'default'
  const svc = new ResourceService(
    customApi as unknown as ConstructorParameters<typeof ResourceService>[0],
    defaultNamespace,
    namespaces
  )
  const gateway = {
    getResource: svc.getResource.bind(svc),
    updateResource: svc.updateResource.bind(svc),
    createResource: svc.createResource.bind(svc),
    deleteResource: svc.deleteResource.bind(svc),
    listResource: svc.listResource.bind(svc),
  }

  /** The stored object, or undefined; never a live reference into the store. */
  function peek(plural: string, namespace: string, name: string): Obj | undefined {
    const obj = store.get(key(plural, namespace, name))
    return obj ? structuredClone(obj) : undefined
  }

  /** Mark a stored object as being deleted, as the apiserver reports while finalizers run. */
  function markDeleting(plural: string, namespace: string, name: string): void {
    const obj = store.get(key(plural, namespace, name))
    if (!obj) throw new Error(`markDeleting: ${plural}/${name} not found`)
    obj.metadata.deletionTimestamp = new Date().toISOString()
  }

  return { customApi, gateway, svc, store, hooks, peek, markDeleting }
}
