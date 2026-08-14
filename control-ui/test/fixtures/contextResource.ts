import type { ContextSharedFileSystemRef, ContextSharedFileSystemStatus } from '../../lib/api'

export type ProducerContextResource = {
  metadata: {
    name: string
    namespace: string
    resourceVersion: string
  }
  spec: {
    contextId: string
    description: string
    mcpServers: string[]
    sharedFileSystems: ContextSharedFileSystemRef[]
  }
  status: {
    sharedFileSystems: ContextSharedFileSystemStatus[]
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
