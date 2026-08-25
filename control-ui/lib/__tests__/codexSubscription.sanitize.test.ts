import { describe, expect, it } from 'vitest'
import { sanitizeCodexConnection } from '../codexSubscription'

function connected(overrides: Record<string, unknown> = {}) {
  return {
    connectionKey: 'codex-aaa',
    status: 'connected',
    credentialRevision: 1,
    catalogRevision: 1,
    accountFingerprint: null,
    catalogStatus: 'ready',
    catalogSyncedAt: null,
    lastRefreshAt: null,
    lastAuthAt: null,
    refreshLockHeld: false,
    ...overrides,
  }
}

describe('sanitizeCodexConnection', () => {
  it('keeps an explicit grant key', () => {
    expect(sanitizeCodexConnection(connected()).connectionKey).toBe('codex-aaa')
  })

  it('rejects a missing or reserved connection key instead of inventing deployment-default', () => {
    expect(() => sanitizeCodexConnection(connected({ connectionKey: '' }))).toThrow(
      /connection key is invalid/
    )
    expect(() => sanitizeCodexConnection(connected({ connectionKey: 'unassigned' }))).toThrow(
      /connection key is invalid/
    )
    expect(() => sanitizeCodexConnection(connected({ connectionKey: undefined }))).toThrow(
      /connection key is invalid/
    )
  })
})
