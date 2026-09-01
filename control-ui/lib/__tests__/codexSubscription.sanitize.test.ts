import { describe, expect, it } from 'vitest'
import {
  CODEX_DEVICE_VERIFICATION_URI,
  type CodexSubscriptionConnectionView,
  isAssignableCodexGrant,
  sanitizeCodexConnection,
  sanitizeCodexDevicePoll,
  sanitizeCodexDeviceStart,
} from '../codexSubscription'

function connected(
  overrides: Partial<CodexSubscriptionConnectionView> = {}
): CodexSubscriptionConnectionView {
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

describe('sanitizeCodexDeviceStart', () => {
  it('keeps the canonical ChatGPT verification URI', () => {
    expect(
      sanitizeCodexDeviceStart({
        userCode: 'ABCD-1234',
        verificationUri: CODEX_DEVICE_VERIFICATION_URI,
        intervalSeconds: 5,
        state: 'state-1',
        intent: 'connect',
      })
    ).toMatchObject({
      userCode: 'ABCD-1234',
      verificationUri: CODEX_DEVICE_VERIFICATION_URI,
    })
  })

  it('rejects a non-canonical verification URI', () => {
    expect(() =>
      sanitizeCodexDeviceStart({
        userCode: 'ABCD-1234',
        verificationUri: 'https://chatgpt.com/device',
        intervalSeconds: 5,
        state: 'state-1',
        intent: 'connect',
      })
    ).toThrow(/verification URI is not allowed/)
  })
})

describe('sanitizeCodexDevicePoll', () => {
  it('keeps catalogStatus when present and defaults when the backend omits it', () => {
    const ready = sanitizeCodexDevicePoll({
      status: 'connected',
      connection: connected(),
    })
    expect(ready.status).toBe('connected')
    if (ready.status === 'connected') {
      expect(ready.connection.catalogStatus).toBe('ready')
    }
    const omitted = sanitizeCodexDevicePoll({
      status: 'connected',
      connection: { ...connected(), catalogStatus: undefined },
    })
    expect(omitted.status).toBe('connected')
    if (omitted.status === 'connected') {
      expect(omitted.connection.catalogStatus).toBe('never_synced')
    }
  })
})

describe('isAssignableCodexGrant', () => {
  it('accepts only a connected grant whose catalog is ready', () => {
    expect(isAssignableCodexGrant(connected())).toBe(true)
    expect(isAssignableCodexGrant(connected({ status: 'connecting' }))).toBe(false)
    expect(isAssignableCodexGrant(connected({ catalogStatus: 'never_synced' }))).toBe(false)
    expect(isAssignableCodexGrant(connected({ status: 'revoked' }))).toBe(false)
  })
})
