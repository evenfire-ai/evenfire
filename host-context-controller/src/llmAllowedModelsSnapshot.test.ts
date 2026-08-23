import { describe, expect, it } from 'vitest'
import { projectCodexExecution } from './codexExecutionProjection'
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
            status: 'connected',
            catalogRevision: 1,
            connectionRevision: 1,
            models: ['gpt-5.3-codex'],
          },
          'team-plus': {
            status: 'revoked',
            catalogRevision: 3,
            connectionRevision: 8,
            models: ['gpt-5.3-codex'],
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

describe('parseAllowedModelsSnapshot per assigned connection', () => {
  it('marks the assigned revoked grant ineligible and leaves another Host eligible', () => {
    const cm = multiGrantConfigMap()
    const revoked = parseAllowedModelsSnapshot(cm, 'team-plus')
    const live = parseAllowedModelsSnapshot(cm, 'personal-pro')
    expect(revoked.connectionStatus).toBe('revoked')
    expect(revoked.connectionRevision).toBe(8)
    expect(live.connectionStatus).toBe('connected')
    expect(live.catalogRevision).toBe(4)

    const spec = { model: { provider: 'codex-subscription', name: 'gpt-5.3-codex' } }
    expect(projectCodexExecution(spec, revoked).eligibility).toBe('ineligible')
    expect(projectCodexExecution(spec, revoked).reason).toBe('connection_revoked')
    expect(projectCodexExecution(spec, live).eligibility).toBe('eligible')
  })

  it('defaults a Phase 1 Host without connectionRef to deployment-default', () => {
    const snapshot = parseAllowedModelsSnapshot(multiGrantConfigMap())
    expect(snapshot.connectionStatus).toBe('connected')
    expect(snapshot.catalogRevision).toBe(1)
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

  it('does not mark a Host eligible for a model that only another grant serves', () => {
    const cm = multiGrantConfigMap()
    const parsed = JSON.parse(
      String(cm.metadata.annotations['clerum.io/codex-connections'])
    ) as Record<string, { models: string[] }>
    parsed['personal-pro'].models = ['gpt-5.1']
    cm.metadata.annotations['clerum.io/codex-connections'] = JSON.stringify(parsed)
    const snapshot = parseAllowedModelsSnapshot(cm, 'personal-pro')
    const spec = { model: { provider: 'codex-subscription', name: 'gpt-5.3-codex' } }
    expect(projectCodexExecution(spec, snapshot).eligibility).toBe('ineligible')
    expect(projectCodexExecution(spec, snapshot).derivedScopes).toEqual([])
  })
})
