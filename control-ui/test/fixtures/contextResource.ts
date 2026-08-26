import type { ContextSharedFileSystemRef, ContextSharedFileSystemStatus } from '../../lib/api'

export type ProducerContextResource = {
  metadata: {
    name: string
    namespace: string
    resourceVersion: string
  }
  spec: {
    contextId: string
    /** Optional visible name (spec.displayName); the producer omits it when unset. */
    displayName?: string
    description: string
    mcpServers: string[]
    sharedFileSystems: ContextSharedFileSystemRef[]
  }
  status: {
    sharedFileSystems: ContextSharedFileSystemStatus[]
  }
}

/** The create payload emitted by HostWizard before Kubernetes adds metadata/status. */
export type ProducerContextCreatePayload = {
  metadata: { name: string }
  spec: {
    contextId: string
    description: string
    mcpServers: string[]
  }
}

/** The create payload emitted by HostWizard before Kubernetes adds metadata/status. */
export type ProducerHostCreatePayload = {
  metadata: { name: string }
  spec: {
    host: string
    contextRef: string
    secretRef: string
    channels: string[]
    model: { provider: string; name: string }
    [key: string]: unknown
  }
}

/** The Host shape returned by the producer after Kubernetes materializes it. */
export type ProducerHostResource = {
  metadata: {
    name: string
    namespace: string
    resourceVersion: string
  }
  spec: {
    host: string
    contextRef: string
    secretRef: string
    channels: string[]
    model: { provider: string; name: string }
    [key: string]: unknown
  }
}

export type ContextResourceOverrides = {
  metadata?: Partial<ProducerContextResource['metadata']>
  spec?: Partial<ProducerContextResource['spec']>
  status?: Partial<ProducerContextResource['status']>
}

export function buildContextResource(
  overrides: ContextResourceOverrides = {}
): ProducerContextResource {
  const name = overrides.metadata?.name ?? overrides.spec?.contextId ?? 'research'
  return {
    metadata: {
      name,
      namespace: overrides.metadata?.namespace ?? 'mcp-server',
      resourceVersion: overrides.metadata?.resourceVersion ?? 'rv-context-read',
    },
    spec: {
      contextId: overrides.spec?.contextId ?? name,
      ...(overrides.spec?.displayName !== undefined
        ? { displayName: overrides.spec.displayName }
        : {}),
      description: overrides.spec?.description ?? '',
      mcpServers: [...(overrides.spec?.mcpServers ?? [])],
      sharedFileSystems: [...(overrides.spec?.sharedFileSystems ?? [])],
    },
    status: {
      sharedFileSystems: [...(overrides.status?.sharedFileSystems ?? [])],
    },
  }
}

export function buildContextList(items: readonly ProducerContextResource[] = []) {
  return { items: [...items] }
}

/**
 * Materialize the persisted Context shape from the exact HostWizard POST body.
 * This keeps UI tests anchored to the producer's request/response boundary:
 * the wizard supplies the spec, while Kubernetes supplies namespace, version,
 * and status fields.
 */
export function materializeContextResource(
  payload: ProducerContextCreatePayload,
  overrides: ContextResourceOverrides = {}
): ProducerContextResource {
  return buildContextResource({
    metadata: {
      name: payload.metadata.name,
      ...overrides.metadata,
    },
    spec: {
      contextId: payload.spec.contextId,
      description: payload.spec.description,
      mcpServers: [...payload.spec.mcpServers],
      ...overrides.spec,
    },
    status: overrides.status,
  })
}

/**
 * Materialize the persisted Host shape from the exact HostWizard POST body.
 * The defaults model the producer/Kubernetes response fields that are
 * relevant to a Host consuming a Context; the payload's remaining spec fields
 * are retained so tests cannot accidentally discard unrelated Host settings.
 */
export function materializeHostResource(
  payload: ProducerHostCreatePayload,
  overrides: {
    metadata?: Partial<ProducerHostResource['metadata']>
    spec?: Partial<ProducerHostResource['spec']>
  } = {}
): ProducerHostResource {
  return {
    metadata: {
      name: payload.metadata.name,
      namespace: 'mcp-host',
      resourceVersion: 'rv-host-read',
      ...overrides.metadata,
    },
    spec: {
      ...payload.spec,
      channels: [...payload.spec.channels],
      model: { ...payload.spec.model },
      ...overrides.spec,
    },
  }
}

export function buildHostReferencesForContext(
  contextName: string,
  hostNames: readonly string[] = ['foo', 'bar']
): Record<string, ProducerHostResource> {
  return Object.fromEntries(
    hostNames.map(name => [
      name,
      {
        metadata: { name, namespace: 'mcp-host', resourceVersion: `rv-host-${name}` },
        spec: {
          host: name,
          contextRef: contextName,
          secretRef: 'shared-llm-secret',
          channels: [],
          model: { provider: 'openai', name: 'gpt-5.4-mini' },
        },
      },
    ])
  )
}

/**
 * Build the producer-shaped resources needed to exercise a shared Context.
 * Multiple Hosts intentionally carry the same `spec.contextRef`; connector
 * membership belongs to that Context, not to either Host.
 */
export function buildSharedContextScenario(
  input: {
    contextName?: string
    description?: string
    mcpServers?: readonly string[]
    hostNames?: readonly string[]
  } = {}
) {
  const contextName = input.contextName ?? 'shared-connectors'
  const context = materializeContextResource(
    {
      metadata: { name: contextName },
      spec: {
        contextId: contextName,
        description: input.description ?? 'Shared connector context',
        mcpServers: [...(input.mcpServers ?? [])],
      },
    },
    {
      metadata: {
        namespace: 'mcp-server',
        resourceVersion: 'rv-context-shared-1',
      },
    }
  )
  const hostNames = input.hostNames ?? ['foo', 'bar']
  const hosts = buildHostReferencesForContext(contextName, hostNames)

  return { context, hosts }
}
