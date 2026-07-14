import * as k8s from '@kubernetes/client-node'
import {
  CLERUM_GROUP,
  CLERUM_VERSION,
  ClerumResource,
  ClerumResourceType,
  ResourceListResponse,
} from '../types.js'
import { addNonEmpty, extractK8sStatus, kindFromPlural } from './resourceServiceHelpers.js'

export class K8sNotFoundError extends Error {
  readonly httpStatus = 404
  constructor(message: string) {
    super(message)
    this.name = 'K8sNotFoundError'
  }
}

type MutableResourceSnapshot = {
  metadata?: {
    annotations?: Record<string, string>
    labels?: Record<string, string>
    resourceVersion?: string
  }
  spec?: Record<string, unknown>
}

type ResourceMutation = {
  metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }
  spec: Record<string, unknown>
} | null

export class ResourceService {
  // Allowed namespaces derived from config at construction time.
  private readonly allowedNamespaces: Set<string>

  constructor(
    private readonly customApi: k8s.CustomObjectsApi,
    private readonly defaultNamespace: string,
    // Supports string (single namespace) or string[] (multiple namespaces for list operations).
    // The first element of an array is used as the primary namespace for create/get/update/delete.
    private readonly defaultNamespaces: Partial<Record<ClerumResourceType, string | string[]>>
  ) {
    // Build allowed set from all configured namespaces + the default
    const nsSet = new Set<string>([this.defaultNamespace])
    for (const ns of Object.values(this.defaultNamespaces)) {
      addNonEmpty(nsSet, ns)
    }
    this.allowedNamespaces = nsSet
  }

  private resolveNamespace(plural: ClerumResourceType, namespace?: string): string {
    if (namespace && namespace.trim()) {
      const ns = namespace.trim()
      if (!this.allowedNamespaces.has(ns)) {
        throw new Error(`Namespace not allowed: ${ns}`)
      }
      return ns
    }
    const configured = this.defaultNamespaces[plural]
    // For arrays, the first entry is the primary (creation) namespace.
    const primary = Array.isArray(configured) ? configured[0] : configured
    return primary || this.defaultNamespace
  }

  private listNamespacesForPlural(plural: ClerumResourceType): string[] {
    const namespaces = new Set<string>()
    addNonEmpty(namespaces, this.defaultNamespaces[plural])
    addNonEmpty(namespaces, this.defaultNamespace)
    return Array.from(namespaces)
  }

  async listResource(plural: ClerumResourceType, namespace?: string): Promise<unknown[]> {
    if (namespace === '*') {
      const items: unknown[] = []
      for (const nsName of this.listNamespacesForPlural(plural)) {
        try {
          const namespaced = (await this.customApi.listNamespacedCustomObject({
            group: CLERUM_GROUP,
            version: CLERUM_VERSION,
            namespace: nsName,
            plural,
          })) as unknown as ResourceListResponse
          items.push(...(namespaced.items || []))
        } catch {
          // Ignore namespaces where the resource is absent/inaccessible.
        }
      }
      return items
    }

    const resolvedNamespace = this.resolveNamespace(plural, namespace)
    const res = (await this.customApi.listNamespacedCustomObject({
      group: CLERUM_GROUP,
      version: CLERUM_VERSION,
      namespace: resolvedNamespace,
      plural,
    })) as unknown as ResourceListResponse
    return res.items || []
  }

  async getResource(
    plural: ClerumResourceType,
    name: string,
    namespace?: string
  ): Promise<unknown> {
    const ns = this.resolveNamespace(plural, namespace)
    try {
      return await this.customApi.getNamespacedCustomObject({
        group: CLERUM_GROUP,
        version: CLERUM_VERSION,
        namespace: ns,
        plural,
        name,
      })
    } catch (err) {
      const status = extractK8sStatus(err)
      if (namespace && namespace.trim()) {
        if (status === 404) {
          throw new K8sNotFoundError(`${plural}/${name} not found in namespace ${ns}`)
        }
        throw err
      }
      if (status !== 404 && status !== null) {
        throw err
      }
      const items = (await this.listResource(plural, '*')) as Array<{
        metadata?: { name?: string }
      }>
      const match = items.find(i => i.metadata?.name === name)
      if (!match)
        throw new K8sNotFoundError(`${plural}/${name} not found in namespace ${ns} or cluster-wide`)
      return match
    }
  }

  async createResource(
    plural: ClerumResourceType,
    body: {
      metadata: {
        name: string
        labels?: Record<string, string>
        annotations?: Record<string, string>
      }
      spec: Record<string, unknown>
    },
    namespace?: string
  ): Promise<unknown> {
    // Namespaces are determined by the HTTP layer from server-side config; the
    // service intentionally ignores any namespace the body might carry.
    const ns = this.resolveNamespace(plural, namespace)
    const resource: ClerumResource = {
      apiVersion: `${CLERUM_GROUP}/${CLERUM_VERSION}`,
      kind: kindFromPlural(plural),
      metadata: {
        name: body.metadata.name,
        namespace: ns,
        ...(body.metadata.labels && { labels: body.metadata.labels }),
        ...(body.metadata.annotations && { annotations: body.metadata.annotations }),
      },
      spec: body.spec,
    }

    return this.customApi.createNamespacedCustomObject({
      group: CLERUM_GROUP,
      version: CLERUM_VERSION,
      namespace: ns,
      plural,
      body: resource,
    })
  }

  async updateResource(
    plural: ClerumResourceType,
    name: string,
    body: {
      metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }
      spec: Record<string, unknown>
    },
    namespace?: string
  ): Promise<unknown> {
    const ns = this.resolveNamespace(plural, namespace)
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const current = (await this.getResource(plural, name, ns)) as {
        metadata?: {
          annotations?: Record<string, string>
          labels?: Record<string, string>
          resourceVersion?: string
        }
      }

      const resource: ClerumResource = {
        apiVersion: `${CLERUM_GROUP}/${CLERUM_VERSION}`,
        kind: kindFromPlural(plural),
        metadata: {
          name,
          namespace: ns,
          ...(current.metadata?.labels && { labels: current.metadata.labels }),
          ...(body.metadata?.labels && { labels: body.metadata.labels }),
          ...(current.metadata?.annotations && { annotations: current.metadata.annotations }),
          ...(body.metadata?.annotations && { annotations: body.metadata.annotations }),
        },
        spec: body.spec,
      }

      try {
        return await this.customApi.replaceNamespacedCustomObject({
          group: CLERUM_GROUP,
          version: CLERUM_VERSION,
          namespace: ns,
          plural,
          name,
          body: {
            ...resource,
            metadata: {
              ...resource.metadata,
              resourceVersion: current.metadata?.resourceVersion,
            },
          },
        })
      } catch (err) {
        if (extractK8sStatus(err) === 409 && attempt < maxAttempts) {
          continue
        }
        throw err
      }
    }
    throw new Error(`Failed to update ${plural}/${name} after ${maxAttempts} attempts`)
  }

  async mutateResource(
    plural: ClerumResourceType,
    name: string,
    mutate: (current: MutableResourceSnapshot) => ResourceMutation | Promise<ResourceMutation>,
    namespace?: string
  ): Promise<unknown> {
    const ns = this.resolveNamespace(plural, namespace)
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const current = (await this.getResource(plural, name, ns)) as MutableResourceSnapshot
      const next = await mutate(current)
      if (!next) {
        return current
      }

      const resource: ClerumResource = {
        apiVersion: `${CLERUM_GROUP}/${CLERUM_VERSION}`,
        kind: kindFromPlural(plural),
        metadata: {
          name,
          namespace: ns,
          ...(current.metadata?.labels && { labels: current.metadata.labels }),
          ...(next.metadata?.labels && { labels: next.metadata.labels }),
          ...(current.metadata?.annotations && { annotations: current.metadata.annotations }),
          ...(next.metadata?.annotations && { annotations: next.metadata.annotations }),
        },
        spec: next.spec,
      }

      try {
        return await this.customApi.replaceNamespacedCustomObject({
          group: CLERUM_GROUP,
          version: CLERUM_VERSION,
          namespace: ns,
          plural,
          name,
          body: {
            ...resource,
            metadata: {
              ...resource.metadata,
              resourceVersion: current.metadata?.resourceVersion,
            },
          },
        })
      } catch (err) {
        if (extractK8sStatus(err) === 409 && attempt < maxAttempts) {
          continue
        }
        throw err
      }
    }
    throw new Error(`Failed to mutate ${plural}/${name} after ${maxAttempts} attempts`)
  }

  async deleteResource(
    plural: ClerumResourceType,
    name: string,
    namespace?: string
  ): Promise<unknown> {
    const ns = this.resolveNamespace(plural, namespace)
    return this.customApi.deleteNamespacedCustomObject({
      group: CLERUM_GROUP,
      version: CLERUM_VERSION,
      namespace: ns,
      plural,
      name,
    })
  }

  // Merge-patches a CRD's /status subresource. Used by the recipe retry
  // endpoint to drive the state-machine transition out of the terminal
  // `failed` phase without going through a full spec update.
  async patchResourceStatus(
    plural: ClerumResourceType,
    name: string,
    statusPatch: Record<string, unknown>,
    namespace?: string
  ): Promise<unknown> {
    const ns = this.resolveNamespace(plural, namespace)
    return this.customApi.patchNamespacedCustomObjectStatus(
      {
        group: CLERUM_GROUP,
        version: CLERUM_VERSION,
        namespace: ns,
        plural,
        name,
        body: { status: statusPatch },
      },
      { middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')] }
    )
  }
}
