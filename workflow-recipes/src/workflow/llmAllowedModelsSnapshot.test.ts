import { describe, expect, it } from 'vitest'
import { parseAllowedModelsSnapshot } from './llmAllowedModelsSnapshot'

function multiGrantConfigMap() {
  return {
    metadata: {
      annotations: {
        'clerum.io/content-hash': 'aa',
        'clerum.io/catalog-revision': '1',
        'clerum.io/connection-revision': '1',
        'clerum.io/codex-connection-status': 'connected',
        'clerum.io/codex-enabled': 'true',
        'clerum.io/codex-connections': JSON.stringify({
          'deployment-default': {
            status: 'revoked',
            catalogRevision: 1,
            connectionRevision: 9,
          },
          'personal-pro': { status: 'connected', catalogRevision: 4, connectionRevision: 2 },
        }),
      },
    },
    data: {
      'codex-subscription': JSON.stringify([{ model: 'gpt-5.3-codex', stale: false }]),
    },
  }
}

describe('WRC parseAllowedModelsSnapshot per assigned connection', () => {
  it('reads clerum.io/codex-connections instead of the flat status annotation', () => {
    const snapshot = parseAllowedModelsSnapshot(multiGrantConfigMap())
    expect(snapshot.connectionStatus).toBe('revoked')
    expect(snapshot.connectionRevision).toBe(9)
  })

  it('can project a non-default grant when a recipe is later bound to one', () => {
    const snapshot = parseAllowedModelsSnapshot(multiGrantConfigMap(), 'personal-pro')
    expect(snapshot.connectionStatus).toBe('connected')
    expect(snapshot.catalogRevision).toBe(4)
  })
})
