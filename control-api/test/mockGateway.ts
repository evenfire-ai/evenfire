import { K8sNotFoundError } from '../src/services/resourceService.js'

type ResourceType =
  | 'hosts'
  | 'contexts'
  | 'communicationchannels'
  | 'mcpservers'
  | 'workflowrecipes'
  | 'workflowrecipepolicies'
  | 'sharedfilesystems'

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
  }
  spec: Record<string, unknown>
  status?: Record<string, unknown>
}

export class MockGateway {
  private readonly ns: string
  private readonly store: Record<ResourceType, Map<string, ResourceRecord>>
  private readonly secretStore: Map<
    string,
    {
      name: string
      namespace: string
      type?: string
      labels?: Record<string, string>
      annotations?: Record<string, string>
      data?: Record<string, string>
      stringData?: Record<string, string>
    }
  >

  private readonly endpointsStore: Map<string, number>

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
    }
    this.secretStore = new Map()
    this.endpointsStore = new Map()
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
    const row: ResourceRecord = {
      metadata: {
        name: body.metadata.name,
        namespace: ns,
        ...(body.metadata.labels && { labels: body.metadata.labels }),
        ...(body.metadata.annotations && { annotations: body.metadata.annotations }),
        ...(body.metadata.creationTimestamp && {
          creationTimestamp: body.metadata.creationTimestamp,
        }),
      },
      spec: body.spec || {},
      ...(body.status ? { status: body.status } : {}),
    }
    this.store[plural].set(this.key(body.metadata.name, ns), row)
    return row
  }

  async updateResource(
    plural: ResourceType,
    name: string,
    body: {
      metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }
      spec: Record<string, unknown>
    },
    namespace?: string
  ): Promise<unknown> {
    const ns = namespace || this.ns
    const existing = this.store[plural].get(this.key(name, ns))
    if (!existing) {
      throw new K8sNotFoundError(`${plural}/${name} not found`)
    }
    // Mirror resourceService.updateResource: body.metadata.{labels,annotations}
    // REPLACES the corresponding map when provided (each map is a leaf), else
    // the existing map survives.
    const updated: ResourceRecord = {
      metadata: {
        ...existing.metadata,
        ...(body.metadata?.labels && { labels: body.metadata.labels }),
        ...(body.metadata?.annotations && { annotations: body.metadata.annotations }),
      },
      spec: body.spec || {},
      ...(existing.status ? { status: existing.status } : {}),
    }
    this.store[plural].set(this.key(name, ns), updated)
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
      },
      spec: next.spec || {},
      ...(existing.status ? { status: existing.status } : {}),
    }
    this.store[plural].set(this.key(name, ns), updated)
    return updated
  }

  async deleteResource(plural: ResourceType, name: string, namespace?: string): Promise<unknown> {
    const ns = namespace || this.ns
    const key = this.key(name, ns)
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
  async getSecret(name: string, namespace?: string): Promise<unknown> {
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
      },
      type: entry.type || 'Opaque',
      data: entry.data,
      stringData: entry.stringData,
    }
  }

  async createSecret(req: unknown): Promise<unknown> {
    const body = req as {
      name: string
      namespace?: string
      type?: string
      labels?: Record<string, string>
      annotations?: Record<string, string>
      data?: Record<string, string>
      stringData?: Record<string, string>
    }
    this.secretStore.set(this.key(body.name, body.namespace), {
      name: body.name,
      namespace: body.namespace || this.ns,
      type: body.type,
      labels: body.labels,
      annotations: body.annotations,
      data: body.data,
      stringData: body.stringData,
    })
    return req
  }

  async updateSecret(req: unknown): Promise<unknown> {
    const body = req as {
      name: string
      namespace?: string
      type?: string
      labels?: Record<string, string>
      annotations?: Record<string, string>
      data?: Record<string, string>
      stringData?: Record<string, string>
    }
    this.secretStore.set(this.key(body.name, body.namespace), {
      name: body.name,
      namespace: body.namespace || this.ns,
      type: body.type,
      labels: body.labels,
      annotations: body.annotations,
      data: body.data,
      stringData: body.stringData,
    })
    return req
  }

  async removeSecretKey(req: { name: string; namespace?: string; key: string }): Promise<unknown> {
    const ns = req.namespace || this.ns
    const key = this.key(req.name, ns)
    const existing = this.secretStore.get(key)
    if (existing?.data) {
      delete existing.data[req.key]
    }
    if (existing?.stringData) {
      delete existing.stringData[req.key]
    }
    return { name: req.name, namespace: ns, deletedKey: req.key }
  }

  async deleteSecret(name: string, namespace?: string): Promise<unknown> {
    const ns = namespace || this.ns
    const deleted = this.secretStore.delete(this.key(name, ns))
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
