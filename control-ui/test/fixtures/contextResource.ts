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

export function buildHostReferencesForContext(
  contextName: string,
  hostNames: readonly string[] = ['foo', 'bar']
) {
  return Object.fromEntries(
    hostNames.map(name => [
      name,
      {
        metadata: { name, namespace: 'mcp-host', resourceVersion: `rv-host-${name}` },
        spec: { host: name, contextRef: contextName },
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
  const context = buildContextResource({
    metadata: {
      name: contextName,
      namespace: 'mcp-server',
      resourceVersion: 'rv-context-shared-1',
    },
    spec: {
      contextId: contextName,
      description: input.description ?? 'Shared connector context',
      mcpServers: [...(input.mcpServers ?? [])],
    },
  })
  const hostNames = input.hostNames ?? ['foo', 'bar']
  const hosts = buildHostReferencesForContext(contextName, hostNames)

  return { context, hosts }
}
