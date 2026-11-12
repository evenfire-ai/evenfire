// Shared builder for the clerum-llm-allowed-models ConfigMap, so every suite
// that drives Grok (or Codex) execution through the allowlist reads the same
// shape.

export type Connection = {
  status: string
  catalogRevision: number
  connectionRevision: number
  models: string[]
}

export function allowlistConfigMap(
  options: {
    grokEnabled?: boolean
    grokConnections?: Record<string, Connection>
  } = {}
) {
  const annotations: Record<string, string> = {
    'clerum.io/content-hash': 'aa',
    'clerum.io/catalog-revision': '1',
    'clerum.io/connection-revision': '1',
    'clerum.io/codex-connection-status': 'connected',
    'clerum.io/codex-enabled': 'true',
    'clerum.io/codex-connections': JSON.stringify({
      'deployment-default': {
        status: 'connected',
        catalogRevision: 1,
        connectionRevision: 1,
        models: ['gpt-5.3-codex'],
      },
    }),
  }
  if (options.grokEnabled !== undefined) {
    annotations['clerum.io/grok-enabled'] = String(options.grokEnabled)
  }
  if (options.grokConnections) {
    annotations['clerum.io/grok-connections'] = JSON.stringify(options.grokConnections)
  }
  return {
    metadata: { resourceVersion: '1', annotations },
    data: {
      'codex-subscription': JSON.stringify([{ model: 'gpt-5.3-codex', stale: false }]),
    },
  }
}

export const liveGrokConnections: Record<string, Connection> = {
  'team-grok': {
    status: 'connected',
    catalogRevision: 1,
    connectionRevision: 1,
    models: ['grok-4'],
  },
}
