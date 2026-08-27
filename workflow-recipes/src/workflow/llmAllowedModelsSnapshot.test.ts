import { describe, expect, it } from 'vitest'
import {
  CODEX_CONNECTION_REF_ANNOTATION,
  parseAllowedModelsSnapshot,
  readRecipeCodexConnectionRef,
} from './llmAllowedModelsSnapshot'

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
            models: [],
          },
          'personal-pro': {
            status: 'connected',
            catalogRevision: 4,
            connectionRevision: 2,
            models: ['gpt-5.3-codex'],
          },
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
    const snapshot = parseAllowedModelsSnapshot(multiGrantConfigMap(), 'deployment-default')
    expect(snapshot.connectionStatus).toBe('revoked')
    expect(snapshot.connectionRevision).toBe(9)
  })

  it('does not inherit a reserved grant when the recipe has no assigned key', () => {
    const snapshot = parseAllowedModelsSnapshot(multiGrantConfigMap())
    expect(snapshot.connectionStatus).toBe('disconnected')
    expect(Array.from(snapshot.enabledModels ?? [])).not.toContain(
      'codex-subscription:gpt-5.3-codex'
    )
  })

  it('can project a non-default grant when a recipe is later bound to one', () => {
    const snapshot = parseAllowedModelsSnapshot(multiGrantConfigMap(), 'personal-pro')
    expect(snapshot.connectionStatus).toBe('connected')
    expect(snapshot.catalogRevision).toBe(4)
  })

  it('does not rematch a missing deployment-default onto another grant in the map', () => {
    const cm = multiGrantConfigMap()
    const parsed = JSON.parse(
      String(cm.metadata.annotations['clerum.io/codex-connections'])
    ) as Record<string, unknown>
    delete parsed['deployment-default']
    cm.metadata.annotations['clerum.io/codex-connections'] = JSON.stringify(parsed)
    const snapshot = parseAllowedModelsSnapshot(cm, 'deployment-default')
    expect(snapshot.connectionStatus).toBe('disconnected')
    expect(Array.from(snapshot.enabledModels ?? [])).not.toContain(
      'codex-subscription:gpt-5.3-codex'
    )
  })
})

describe('readRecipeCodexConnectionRef', () => {
  it('reads the explicit annotation and trims whitespace', () => {
    expect(
      readRecipeCodexConnectionRef({ [CODEX_CONNECTION_REF_ANNOTATION]: ' personal-pro ' })
    ).toBe('personal-pro')
  })

  it('resolves missing/empty annotations to the fail-closed unassigned sentinel', () => {
    expect(readRecipeCodexConnectionRef(undefined)).toBe('unassigned')
    expect(readRecipeCodexConnectionRef({})).toBe('unassigned')
    expect(readRecipeCodexConnectionRef({ [CODEX_CONNECTION_REF_ANNOTATION]: '   ' })).toBe(
      'unassigned'
    )
  })

  it('never aliases the reserved deployment-default grant for a missing annotation', () => {
    expect(readRecipeCodexConnectionRef({})).not.toBe('deployment-default')
  })
})
