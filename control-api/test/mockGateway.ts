import { K8sNotFoundError } from '../src/services/resourceService.js'
import {
  type SecretConstraintOptions,
  assertValidEffectiveSecretConstraints,
  assertValidSecretConstraints,
  assertValidSecretType,
  resolveSecretAnnotationsForReplace,
} from '../src/services/secretConstraints.js'
import { assertValidSecretDataKey, assertValidSecretWriteKeys } from '../src/services/secretKeys.js'
import {
  type SecretResource,
  type SecretSnapshot,
  toSecretSnapshot,
} from '../src/services/secretRepository.js'
import type {
  ResourcePreconditions,
  SecretPreconditions,
  SecretUpsertRequest,
} from '../src/types.js'

type ResourceType =
  | 'hosts'
  | 'contexts'
  | 'communicationchannels'
  | 'mcpservers'
  | 'workflowrecipes'
  | 'workflowrecipepolicies'
  | 'sharedfilesystems'
  | 'llmhooks'

// Mirror the real K8sGateway.createResource signature in src/k8s.ts so the
// mock cannot diverge from prod: callers must NOT pass a namespace via the
// body — the server-side `namespace` argument is the single source of truth.
// If a future admin route forgets the inline guard, prod ignores
// metadata.namespace via this same type narrowing, and the mock will now too.
type ResourceBody = {
  metadata: {
    name: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    creationTimestamp?: string
    resourceVersion?: string
    uid?: string
    ownerReferences?: Array<Record<string, unknown>>
    finalizers?: string[]
  }
  spec: Record<string, unknown>
  status?: Record<string, unknown>
}

type ResourceRecord = {
  metadata: {
    name: string
    namespace: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    creationTimestamp?: string
    resourceVersion?: string
    uid?: string
    ownerReferences?: Array<Record<string, unknown>>
    finalizers?: string[]
  }
  spec: Record<string, unknown>
  status?: Record<string, unknown>
}

/** Apply the object-member part of an RFC 7396 merge patch. */
function mergePatchMap(
  existing: Record<string, string> | undefined,
  patch: Record<string, unknown> | undefined
): Record<string, string> | undefined {
  if (patch === undefined) return existing
  // Build the result from entries instead of assigning/deleting through a
  // caller-controlled property name. Object.fromEntries creates own data
  // properties, so a Kubernetes map key such as `__proto__` remains data and
  // cannot invoke an inherited setter while the mock models RFC 7396.
  const appliedEntries = Object.entries(patch).filter(
    ([, value]) => value === null || typeof value === 'string'
  )
  const appliedKeys = new Set(appliedEntries.map(([key]) => key))
  const retainedEntries = Object.entries(existing ?? {}).filter(([key]) => !appliedKeys.has(key))
  const replacementEntries = appliedEntries.filter(
    ([, value]): value is string => typeof value === 'string'
  )
  return Object.fromEntries([...retainedEntries, ...replacementEntries])
}

export type MockGatewaySecretWriteFault = (input: {
  operation: 'create' | 'update' | 'merge'
  snapshot: SecretSnapshot
}) => void | Promise<void>

export type MockGatewayResourceUpdateFault = (input: {
  plural: ResourceType
  name: string
  namespace: string
  snapshot: ResourceRecord
}) => void | Promise<void>

export type MockGatewayResourceCreateFault = (input: {
  plural: ResourceType
  name: string
  namespace: string
  snapshot: ResourceRecord
}) => void | Promise<void>

export class MockGateway {
  private readonly ns: string
  private identitySequence = 0
  private readonly store: Record<ResourceType, Map<string, ResourceRecord>>
  private readonly secretStore: Map<
    string,
    {
      name: string
      namespace: string
      type?: string
      labels?: Record<string, string>
      annotations?: Record<string, string>
      // Server-assigned identity. The fake always models it because production Kubernetes
      // always returns it; tests may override the values to model a specific interleaving.
      uid: string
      resourceVersion: string
      data?: Record<string, string>
      stringData?: Record<string, string>
    }
  >

  private readonly endpointsStore: Map<string, number>
  private secretWriteFault: MockGatewaySecretWriteFault | null = null
  private resourceCreateFault: MockGatewayResourceCreateFault | null = null
  private resourceUpdateFault: MockGatewayResourceUpdateFault | null = null

  // Stub for the LLM allowlist ConfigMap materializer. Defaults to a no-op so
  // CRUD success paths are undisturbed; a test can inject a throwing impl to
  // exercise the 503-on-write-failure path.
  private llmAllowedModelsMaterialize: () => Promise<void> = async () => {}

  constructor(namespace = 'test-namespace') {
    this.ns = namespace
    this.store = {
      hosts: new Map(),
      contexts: new Map(),
      communicationchannels: new Map(),
      mcpservers: new Map(),
      workflowrecipes: new Map(),
      workflowrecipepolicies: new Map(),
      sharedfilesystems: new Map(),
      llmhooks: new Map(),
    }
    this.secretStore = new Map()
    this.endpointsStore = new Map()
  }

  private allocateUid(kind: string, namespace: string, name: string): string {
    this.identitySequence += 1
    return `uid-${kind}-${namespace}-${name}-${this.identitySequence}`
  }

  /**
   * Test helper: register a Service's Endpoints object as existing in the
   * simulated cluster with `readyAddressCount` Ready addresses. Omit (or
   * never call) to simulate a missing Endpoints object (gateway returns null).
   */
  seedServiceEndpoints(name: string, namespace: string, readyAddressCount: number): void {
    this.endpointsStore.set(`${namespace}/${name}`, readyAddressCount)
  }

  async getServiceReadyAddressCount(name: string, namespace: string): Promise<number | null> {
    const key = `${namespace}/${name}`
    if (!this.endpointsStore.has(key)) return null
    return this.endpointsStore.get(key) ?? 0
  }

  /** Test helper: register a Secret as existing in the simulated cluster. */
  seedSecret(
    name: string,
    namespace?: string,
    options?: {
      type?: string
      labels?: Record<string, string>
      annotations?: Record<string, string>
      uid?: string
      resourceVersion?: string
      data?: Record<string, string>
      stringData?: Record<string, string>
    }
  ): void {
    const ns = namespace || this.ns
    this.secretStore.set(`${ns}/${name}`, {
      name,
      namespace: ns,
      type: options?.type,
      labels: options?.labels,
      annotations: options?.annotations,
      uid: options?.uid ?? this.allocateUid('secret', ns, name),
      resourceVersion: options?.resourceVersion ?? '1',
      data: options?.data,
      stringData: options?.stringData,
    })
  }

  getNamespace(): string {
    return this.ns
  }

  /** Test helper: make the allowlist ConfigMap materialize() reject. */
  setLlmAllowedModelsConfigMapMaterialize(fn: () => Promise<void>): void {
    this.llmAllowedModelsMaterialize = fn
  }

  /** Inject a post-commit Secret failure to model response loss/transport errors. */
  setSecretWriteFault(fault: MockGatewaySecretWriteFault | null): void {
    this.secretWriteFault = fault
  }

  /** Inject a post-commit CR update failure or concurrent writer. */
  setResourceUpdateFault(fault: MockGatewayResourceUpdateFault | null): void {
    this.resourceUpdateFault = fault
  }

  /** Inject a post-commit CR create failure or response loss. */
  setResourceCreateFault(fault: MockGatewayResourceCreateFault | null): void {
    this.resourceCreateFault = fault
  }

  llmAllowedModelsConfigMap(): { materialize: () => Promise<void> } {
    return { materialize: () => this.llmAllowedModelsMaterialize() }
  }

  private key(name: string, namespace?: string): string {
    return `${namespace || this.ns}/${name}`
  }

  async listResource(plural: ResourceType, namespace = '*'): Promise<unknown[]> {
    const rows = [...this.store[plural].values()]
    if (namespace === '*') return rows
    return rows.filter(row => row.metadata.namespace === namespace)
  }

  async getResource(plural: ResourceType, name: string, namespace?: string): Promise<unknown> {
    const row = this.store[plural].get(this.key(name, namespace))
    if (!row) {
      throw new K8sNotFoundError(`${plural}/${name} not found`)
    }
    return row
  }

  async createResource(
    plural: ResourceType,
    body: ResourceBody,
    namespace?: string
  ): Promise<unknown> {
    // Server-decided namespace only — body.metadata cannot carry one (see ResourceBody type).
    const ns = namespace || this.ns
    const key = this.key(body.metadata.name, ns)
    if (this.store[plural].has(key)) {
      const err = new Error(`${plural}/${body.metadata.name} already exists`) as Error & {
        statusCode: number
        code: number
      }
      err.statusCode = 409
      err.code = 409
      throw err
    }
    const row: ResourceRecord = {
      metadata: {
        name: body.metadata.name,
        namespace: ns,
        uid: body.metadata.uid ?? this.allocateUid(plural, ns, body.metadata.name),
        ...(body.metadata.labels && { labels: body.metadata.labels }),
        ...(body.metadata.annotations && { annotations: body.metadata.annotations }),
        ...(body.metadata.creationTimestamp && {
          creationTimestamp: body.metadata.creationTimestamp,
        }),
        ...(body.metadata.ownerReferences && { ownerReferences: body.metadata.ownerReferences }),
        ...(body.metadata.finalizers && { finalizers: body.metadata.finalizers }),
        resourceVersion: body.metadata.resourceVersion ?? '1',
      },
      spec: body.spec || {},
      ...(body.status ? { status: body.status } : {}),
    }
    this.store[plural].set(key, row)
    if (this.resourceCreateFault) {
      await this.resourceCreateFault({
        plural,
        name: body.metadata.name,
        namespace: ns,
        snapshot: row,
      })
    }
    return row
  }

  async updateResource(
    plural: ResourceType,
    name: string,
    body: {
      metadata?: {
        labels?: Record<string, string>
        annotations?: Record<string, string>
        uid?: string
        resourceVersion?: string
        ownerReferences?: Array<Record<string, unknown>>
        finalizers?: string[]
      }
      spec: Record<string, unknown>
    },
    namespace?: string
  ): Promise<unknown> {
    const ns = namespace || this.ns
    const existing = this.store[plural].get(this.key(name, ns))
    if (!existing) {
      throw new K8sNotFoundError(`${plural}/${name} not found`)
    }
    if (body.metadata?.uid !== undefined) {
      this.assertResourcePrecondition(name, existing, body.metadata)
    } else {
      this.assertResourceVersion(
        name,
        existing.metadata.resourceVersion,
        body.metadata?.resourceVersion
      )
    }
    // Mirror resourceService.updateResource: body.metadata.{labels,annotations}
    // REPLACES the corresponding map when provided (each map is a leaf), else
    // the existing map survives.
    const updated: ResourceRecord = {
      metadata: {
        ...existing.metadata,
        ...(body.metadata?.labels && { labels: body.metadata.labels }),
        ...(body.metadata?.annotations && { annotations: body.metadata.annotations }),
        ...(existing.metadata.resourceVersion && {
          resourceVersion: MockGateway.nextResourceVersion(existing.metadata.resourceVersion),
        }),
      },
      spec: body.spec || {},
      ...(existing.status ? { status: existing.status } : {}),
    }
    this.store[plural].set(this.key(name, ns), updated)
    if (this.resourceUpdateFault) {
      await this.resourceUpdateFault({ plural, name, namespace: ns, snapshot: updated })
    }
    return updated
  }

  async mutateResource(
    plural: ResourceType,
    name: string,
    mutate: (current: ResourceRecord) =>
      | { metadata?: { labels?: Record<string, string> }; spec: Record<string, unknown> }
      | null
      | Promise<{
          metadata?: { labels?: Record<string, string> }
          spec: Record<string, unknown>
        } | null>,
    namespace?: string
  ): Promise<unknown> {
    const ns = namespace || this.ns
    const existing = this.store[plural].get(this.key(name, ns))
    if (!existing) {
      throw new K8sNotFoundError(`${plural}/${name} not found`)
    }
    const next = await mutate(existing)
    if (!next) return existing
    const updated: ResourceRecord = {
      metadata: {
        ...existing.metadata,
        ...(next.metadata?.labels && { labels: next.metadata.labels }),
        ...(existing.metadata.resourceVersion && {
          resourceVersion: MockGateway.nextResourceVersion(existing.metadata.resourceVersion),
        }),
      },
      spec: next.spec || {},
      ...(existing.status ? { status: existing.status } : {}),
    }
    this.store[plural].set(this.key(name, ns), updated)
    return updated
  }

  async deleteResource(
    plural: ResourceType,
    name: string,
    namespace?: string,
    precondition?: ResourcePreconditions
  ): Promise<unknown> {
    const ns = namespace || this.ns
    const key = this.key(name, ns)
    this.assertResourcePrecondition(name, this.store[plural].get(key), precondition)
    const existed = this.store[plural].delete(key)
    return { deleted: existed, name, namespace: ns }
  }

  async listSecrets(_namespace?: string): Promise<unknown[]> {
    return []
  }

  /**
   * Mock Secret read. Throws a K8s-shaped 404 error when the Secret was not
   * seeded via `seedSecret()`. Matches the real K8sGateway.getSecret contract.
   */
  async getSecret(name: string, namespace?: string): Promise<SecretResource> {
    const ns = namespace || this.ns
    const entry = this.secretStore.get(`${ns}/${name}`)
    if (!entry) {
      const err = new Error(`secrets "${name}" not found`) as Error & {
        statusCode: number
        code: number
      }
      err.statusCode = 404
      err.code = 404
      throw err
    }
    return {
      metadata: {
        name: entry.name,
        namespace: entry.namespace,
        labels: entry.labels,
        annotations: entry.annotations,
        uid: entry.uid,
        resourceVersion: entry.resourceVersion,
      },
      type: entry.type || 'Opaque',
      data: entry.data,
      stringData: entry.stringData,
    }
  }

  async createSecret(req: unknown, opts?: SecretConstraintOptions): Promise<SecretSnapshot> {
    const body = req as SecretUpsertRequest
    assertValidSecretConstraints(body, opts)
    assertValidSecretWriteKeys(body)
    const key = this.key(body.name, body.namespace)
    if (this.secretStore.has(key)) {
      const err = new Error(`secrets "${body.name}" already exists`) as Error & {
        statusCode: number
        code: number
      }
      err.statusCode = 409
      err.code = 409
      throw err
    }
    const entry = {
      name: body.name,
      namespace: body.namespace || this.ns,
      type: body.type ?? 'Opaque',
      labels: body.labels,
      annotations: body.annotations,
      uid: this.allocateUid('secret', body.namespace || this.ns, body.name),
      resourceVersion: '1',
      data: body.data,
      stringData: body.stringData,
    }
    this.secretStore.set(key, entry)
    const snapshot = this.snapshot(entry)
    if (this.secretWriteFault) {
      await this.secretWriteFault({ operation: 'create', snapshot })
    }
    return snapshot
  }

  /**
   * Mock Secret replace. Honours `precondition` the way the API server does: a `uid` or
   * `resourceVersion` that disagrees with the stored object is a 409, not a silent
   * overwrite. Without this a test could not tell an ownership-bound write from a
   * name-addressed one — both would "pass" — which is the exact defect the preconditions
   * exist to prevent.
   *
   * A successful write bumps `resourceVersion`, so a caller replaying a stale version is
   * rejected on the second attempt just as it would be against a real cluster.
   */
  async updateSecret(
    req: unknown,
    precondition?: SecretPreconditions,
    opts?: SecretConstraintOptions
  ): Promise<SecretSnapshot> {
    const body = req as SecretUpsertRequest
    const key = this.key(body.name, body.namespace)
    const existing = this.secretStore.get(key)
    if (!existing) {
      const err = new Error(`secrets "${body.name}" not found`) as Error & {
        statusCode: number
        code: number
      }
      err.statusCode = 404
      err.code = 404
      throw err
    }
    assertValidSecretConstraints(body, opts, existing.annotations)
    assertValidSecretWriteKeys(body)
    this.assertPrecondition(body.name, existing, precondition)
    const effectiveAnnotations = resolveSecretAnnotationsForReplace(
      existing.annotations,
      body.annotations,
      opts
    )
    const effectiveType = body.type ?? existing.type ?? 'Opaque'
    assertValidEffectiveSecretConstraints(
      { name: body.name, type: effectiveType, annotations: effectiveAnnotations },
      opts
    )
    const updated = {
      name: body.name,
      namespace: body.namespace || this.ns,
      type: effectiveType,
      labels: body.labels ?? existing.labels,
      annotations: effectiveAnnotations,
      uid: existing?.uid,
      resourceVersion: MockGateway.nextResourceVersion(existing?.resourceVersion),
      data: body.data,
      stringData: body.stringData,
    }
    this.secretStore.set(key, updated)
    const snapshot = this.snapshot(updated)
    if (this.secretWriteFault) {
      await this.secretWriteFault({ operation: 'update', snapshot })
    }
    return snapshot
  }

  async mergeSecret(
    req: unknown,
    opts?: SecretConstraintOptions,
    precondition?: SecretPreconditions
  ): Promise<SecretSnapshot> {
    const body = req as SecretUpsertRequest
    const key = this.key(body.name, body.namespace)
    const existing = this.secretStore.get(key)
    if (!existing) {
      const err = new Error(`secrets "${body.name}" not found`) as Error & {
        statusCode: number
        code: number
      }
      err.statusCode = 404
      err.code = 404
      throw err
    }
    this.assertPrecondition(body.name, existing, precondition)
    if (body.type !== undefined) assertValidSecretType(body.type)
    assertValidSecretWriteKeys(body)
    const effectiveAnnotations = resolveSecretAnnotationsForReplace(
      existing.annotations,
      body.annotations,
      opts
    )
    const effectiveType = body.type ?? existing.type ?? 'Opaque'
    assertValidEffectiveSecretConstraints(
      { name: body.name, type: effectiveType, annotations: effectiveAnnotations },
      opts
    )
    const updated = {
      ...existing,
      type: effectiveType,
      labels: mergePatchMap(existing.labels, body.labels as Record<string, unknown> | undefined),
      annotations: mergePatchMap(
        existing.annotations,
        body.annotations as Record<string, unknown> | undefined
      ),
      data: mergePatchMap(existing.data, body.data as Record<string, unknown> | undefined),
      stringData: mergePatchMap(
        existing.stringData,
        body.stringData as Record<string, unknown> | undefined
      ),
      resourceVersion:
        MockGateway.nextResourceVersion(existing.resourceVersion) ?? existing.resourceVersion,
    }
    this.secretStore.set(key, updated)
    const snapshot = this.snapshot(updated)
    if (this.secretWriteFault) {
      await this.secretWriteFault({ operation: 'merge', snapshot })
    }
    return snapshot
  }

  private snapshot(entry: {
    name: string
    namespace: string
    type?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    uid: string
    resourceVersion: string
    data?: Record<string, string>
    stringData?: Record<string, string>
  }): SecretSnapshot {
    return toSecretSnapshot(
      {
        metadata: {
          name: entry.name,
          namespace: entry.namespace,
          labels: entry.labels,
          annotations: entry.annotations,
          uid: entry.uid,
          resourceVersion: entry.resourceVersion,
        },
        type: entry.type,
        data: entry.data,
        stringData: entry.stringData,
      },
      entry.name,
      entry.namespace
    )
  }

  /**
   * Reject a mutation whose preconditions do not match the stored object, with the same
   * 409 the API server returns. `undefined` fields are not constraints — a caller that
   * supplies neither gets the historical last-writer-wins behaviour.
   */
  private assertPrecondition(
    name: string,
    existing: { uid?: string; resourceVersion?: string } | undefined,
    precondition?: SecretPreconditions
  ): void {
    if (!precondition) return
    const mismatch =
      (precondition.uid !== undefined && existing?.uid !== precondition.uid) ||
      (precondition.resourceVersion !== undefined &&
        existing?.resourceVersion !== precondition.resourceVersion)
    if (!mismatch) return
    const err = new Error(
      `Operation cannot be fulfilled on secrets "${name}": the object has been modified; please apply your changes to the latest version and try again`
    ) as Error & { statusCode: number; code: number }
    err.statusCode = 409
    err.code = 409
    throw err
  }

  /** Monotonic, and only meaningful relative to itself — exactly like the real one. */
  private static nextResourceVersion(current?: string): string | undefined {
    if (current === undefined) return undefined
    const n = Number(current)
    return Number.isFinite(n) ? String(n + 1) : `${current}-1`
  }

  private assertResourceVersion(
    name: string,
    current: string | undefined,
    expected: string | undefined
  ): void {
    // Some legacy route fixtures do not model the server-assigned CR
    // resourceVersion. They cannot prove a CAS mismatch; registry regressions
    // that exercise this contract seed an explicit version and are checked
    // strictly below.
    if (expected === undefined || current === undefined || current === expected) return
    const err = new Error(
      `Operation cannot be fulfilled on resources "${name}": the object has been modified`
    ) as Error & { statusCode: number; code: number }
    err.statusCode = 409
    err.code = 409
    throw err
  }

  private assertResourcePrecondition(
    name: string,
    existing: ResourceRecord | undefined,
    precondition?: ResourcePreconditions
  ): void {
    if (!precondition) return
    const mismatch =
      (precondition.uid !== undefined && existing?.metadata.uid !== precondition.uid) ||
      (precondition.resourceVersion !== undefined &&
        existing?.metadata.resourceVersion !== precondition.resourceVersion)
    if (!mismatch) return
    const err = new Error(
      `Operation cannot be fulfilled on resources "${name}": the object has been modified`
    ) as Error & { statusCode: number; code: number }
    err.statusCode = 409
    err.code = 409
    throw err
  }

  async removeSecretKey(
    req: {
      name: string
      namespace?: string
      key: string
    },
    precondition?: SecretPreconditions
  ): Promise<SecretSnapshot> {
    assertValidSecretDataKey(req.key)
    const ns = req.namespace || this.ns
    const key = this.key(req.name, ns)
    const existing = this.secretStore.get(key)
    if (!existing) {
      const err = new Error(`secrets "${req.name}" not found`) as Error & {
        statusCode: number
        code: number
      }
      err.statusCode = 404
      err.code = 404
      throw err
    }
    this.assertPrecondition(req.name, existing, precondition)
    const effectiveAnnotations = resolveSecretAnnotationsForReplace(existing.annotations, undefined)
    assertValidEffectiveSecretConstraints({
      name: existing.name,
      type: existing.type ?? 'Opaque',
      annotations: effectiveAnnotations,
    })
    const updated = {
      ...existing,
      ...(existing.data ? { data: { ...existing.data } } : {}),
      ...(existing.stringData ? { stringData: { ...existing.stringData } } : {}),
      resourceVersion:
        MockGateway.nextResourceVersion(existing.resourceVersion) ?? existing.resourceVersion,
    }
    delete updated.data?.[req.key]
    delete updated.stringData?.[req.key]
    this.secretStore.set(key, updated)
    return this.snapshot(updated)
  }

  /** Mock Secret delete. Honours `precondition` exactly as `updateSecret` does. */
  async deleteSecret(
    name: string,
    namespace?: string,
    precondition?: SecretPreconditions
  ): Promise<unknown> {
    const ns = namespace || this.ns
    const key = this.key(name, ns)
    this.assertPrecondition(name, this.secretStore.get(key), precondition)
    const deleted = this.secretStore.delete(key)
    return { deleted, name, namespace: ns }
  }

  async getHostOverview(hostName: string, namespace?: string): Promise<unknown> {
    const ns = namespace || this.ns
    const host = this.store.hosts.get(this.key(hostName, ns)) || null
    const contextName = String((host?.spec?.contextRef as string | undefined) || '')
    const context = contextName
      ? this.store.contexts.get(this.key(contextName, this.ns)) || null
      : null
    const communicationChannels = [...this.store.communicationchannels.values()].filter(
      channel => String(channel.spec.hostRef || '') === hostName
    )
    return {
      host,
      context,
      communicationChannels,
      mcpServers: context ? context.spec.mcpServers || [] : [],
    }
  }

  async findPodByLabel(_namespace: string, _labelSelector: string): Promise<string | null> {
    return null
  }

  async listFilesInDirectory(
    _podName: string,
    _namespace: string,
    _containerName: string | undefined,
    _directory: string
  ): Promise<string> {
    return ''
  }

  async readFileFromPod(
    _podName: string,
    _namespace: string,
    _containerName: string | undefined,
    _filePath: string
  ): Promise<Buffer> {
    return Buffer.from('')
  }
}
