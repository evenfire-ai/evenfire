import { describe, expect, it } from 'vitest'
import { CATALOG_ORIGIN } from '@clerum/grok-provider-attempt-contract'
import {
  GROK_CATALOG_ORIGIN,
  pickGrokGrantModel,
  planGrokCatalogReconcile,
} from '../src/services/grokSubscriptionCatalog.js'
import {
  isGrokUnassignedConnectionKey,
  readHostGrokConnectionRef,
} from '../src/services/grokSubscriptionConnection.js'

describe('grok subscription catalog', () => {
  it('uses the frozen catalog origin from the Grok attempt contract', () => {
    expect(GROK_CATALOG_ORIGIN).toBe(CATALOG_ORIGIN)
    expect(GROK_CATALOG_ORIGIN).toBe('https://cli-chat-proxy.grok.com/v1/models')
    expect(GROK_CATALOG_ORIGIN).not.toContain('api.x.ai')
  })

  it('auto-enables new discovery rows and never invents a static default model', () => {
    const plan = planGrokCatalogReconcile([], {
      outcome: 'ready',
      models: [{ model: 'grok-4.6' }, { model: 'grok-4.5' }],
    })
    expect(plan.catalogStatus).toBe('ready')
    expect(plan.inserts.map(row => row.model)).toEqual(['grok-4.6', 'grok-4.5'])
    expect(pickGrokGrantModel('', ['grok-4.6', 'grok-4.5'], 'grok-4.6')).toBe('grok-4.6')
    expect(pickGrokGrantModel('missing', ['grok-4.6'], null)).toBe('grok-4.6')
  })

  it('rejects unassigned Host refs for assignment', () => {
    expect(isGrokUnassignedConnectionKey(readHostGrokConnectionRef(''))).toBe(true)
    expect(isGrokUnassignedConnectionKey(readHostGrokConnectionRef('team-grok'))).toBe(false)
  })
})
