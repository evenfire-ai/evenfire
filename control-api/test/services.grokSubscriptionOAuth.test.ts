import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { rebuildLiveGrokUnionAllowlist } from '../src/services/grokSubscriptionCatalog.js'
import {
  GrokSubscriptionConnectionKeyConflictError,
  GrokSubscriptionStaleRevisionError,
} from '../src/services/grokSubscriptionConnection.js'

const repos = vi.hoisted(() => ({
  insertState: vi.fn(),
  consumeState: vi.fn(),
  peekState: vi.fn(),
  expireState: vi.fn(),
  cancelState: vi.fn(),
  getSafe: vi.fn(),
  getAny: vi.fn(),
  insertInitial: vi.fn(),
  rotate: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  loadSecrets: vi.fn(),
  revokeConnection: vi.fn(),
  updateInPlace: vi.fn(),
  persistRefresh: vi.fn(),
  markMismatch: vi.fn(),
}))

vi.mock('../src/services/grokSubscriptionOAuthState.js', async () => {
  const actual = await vi.importActual('../src/services/grokSubscriptionOAuthState.js')
  return {
    ...actual,
    insertGrokSubscriptionOAuthState: repos.insertState,
    consumeGrokSubscriptionOAuthState: repos.consumeState,
    peekPendingGrokSubscriptionOAuthState: repos.peekState,
    expireGrokSubscriptionOAuthState: repos.expireState,
    cancelGrokSubscriptionOAuthState: repos.cancelState,
  }
})

vi.mock('../src/services/grokSubscriptionConnection.js', async () => {
  const actual = await vi.importActual('../src/services/grokSubscriptionConnection.js')
  return {
    ...actual,
    getSafeGrokSubscriptionConnection: repos.getSafe,
    getGrokSubscriptionConnectionIncludingRevoked: repos.getAny,
    insertInitialGrokSubscriptionConnection: repos.insertInitial,
    rotateGrokSubscriptionCredentials: repos.rotate,
    acquireGrokSubscriptionRefreshLock: repos.acquireLock,
    releaseGrokSubscriptionRefreshLock: repos.releaseLock,
    loadGrokSubscriptionSecrets: repos.loadSecrets,
    revokeGrokSubscriptionConnection: repos.revokeConnection,
    updateGrokAccessTokenInPlace: repos.updateInPlace,
    persistGrokRefreshCiphertextFirst: repos.persistRefresh,
    markGrokRefreshSubjectMismatch: repos.markMismatch,
  }
})

vi.mock('../src/services/grokSubscriptionCatalog.js', async () => {
  const actual = await vi.importActual('../src/services/grokSubscriptionCatalog.js')
  return {
    ...actual,
    syncGrokSubscriptionCatalog: vi.fn(),
    rebuildLiveGrokUnionAllowlist: vi.fn(),
  }
})

const {
  GROK_OAUTH_DEVICE_GRANT,
  GROK_OAUTH_DEVICE_URL,
  GROK_OAUTH_SCOPES,
  GROK_OAUTH_TOKEN_URL,
  ensureFreshGrokAccessToken,
  pollGrokDevice,
  refreshGrokSubscriptionConnection,
  revokeGrokSubscription,
  startGrokDeviceConnect,
} = await import('../src/services/grokSubscriptionOAuth.js')

const KEY = deriveOAuthEncryptionKey('ab'.repeat(32))
const CONNECTION_KEY = 'team-grok'

function idTokenFor(subject: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')
  return `hdr.${payload}.sig`
}

function fingerprint(subject: string): string {
  return createHash('sha256').update(subject, 'utf8').digest('hex')
}

function assertNoLeak(value: unknown): void {
  const serialized = JSON.stringify(value)
  expect(serialized).not.toMatch(
    /sk-|Bearer |eyJ[A-Za-z0-9_-]+\.|refresh-secret|access-secret|device-secret|cookie/i
  )
  expect(serialized).not.toContain('acct_raw_123')
}

function deps(fetchFn: typeof fetch) {
  return {
    db: { query: vi.fn() },
    encryptionKey: KEY,
    fetchFn,
    clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
    enabled: true,
    connectionKey: CONNECTION_KEY,
  }
}

describe('grok subscription OAuth device broker', () => {
  beforeEach(() => {
    for (const fn of Object.values(repos)) fn.mockReset()
  })

  it('starts RFC 8628 device authorization without leaking the device code', async () => {
    repos.insertState.mockImplementation(
      async (
        _db: unknown,
        _key: Buffer,
        input: { state: string; intent: string; expiresAt: Date; deviceCode: string }
      ) => ({
        state: input.state,
        flow: 'device',
        intent: input.intent,
        status: 'pending',
        connectionKey: CONNECTION_KEY,
        expiresAt: input.expiresAt,
        consumedAt: null,
        cancelledAt: null,
        createdAt: new Date(),
      })
    )
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        device_code: 'device-secret',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.x.ai/activate',
        expires_in: 900,
        interval: 5,
      }),
    })
    const result = await startGrokDeviceConnect(deps(fetchFn), 'connect')
    expect(fetchFn).toHaveBeenCalledWith(
      GROK_OAUTH_DEVICE_URL,
      expect.objectContaining({
        redirect: 'manual',
        headers: expect.objectContaining({
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        }),
      })
    )
    const body = String(fetchFn.mock.calls[0]?.[1]?.body)
    const form = new URLSearchParams(body)
    expect(form.get('client_id')).toBe('b1a00492-073a-47ea-816f-4c329264a828')
    expect(form.get('scope')).toBe(GROK_OAUTH_SCOPES.join(' '))
    expect(result.userCode).toBe('ABCD-EFGH')
    expect(result.verificationUri).toContain('https://auth.x.ai/')
    expect(repos.insertState.mock.calls[0]?.[2]).toMatchObject({
      intent: 'connect',
      deviceCode: 'device-secret',
      connectionKey: CONNECTION_KEY,
    })
    assertNoLeak(result)
    expect(JSON.stringify(result)).not.toContain('device-secret')
  })

  // Live xAI device endpoint (probed 2026-09-18) returns
  // verification_uri=https://accounts.x.ai/oauth2/device, not auth.x.ai.
  it.each([
    ['https://accounts.x.ai/oauth2/device', true],
    ['https://auth.x.ai/activate', true],
    ['http://accounts.x.ai/oauth2/device', false],
    ['https://accounts.x.ai.evil.example/oauth2/device', false],
    ['https://evil.x.ai/oauth2/device', false],
  ])('device start verification_uri %s allowed=%s', async (uri, allowed) => {
    repos.insertState.mockImplementation(
      async (
        _db: unknown,
        _key: Buffer,
        input: { state: string; intent: string; expiresAt: Date }
      ) => ({
        state: input.state,
        flow: 'device',
        intent: input.intent,
        status: 'pending',
        connectionKey: CONNECTION_KEY,
        expiresAt: input.expiresAt,
        consumedAt: null,
        cancelledAt: null,
        createdAt: new Date(),
      })
    )
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        device_code: 'device-secret',
        user_code: 'ABCD-EFGH',
        verification_uri: uri,
        expires_in: 1800,
        interval: 5,
      }),
    })
    const run = startGrokDeviceConnect(deps(fetchFn), 'connect')
    if (allowed) {
      await expect(run).resolves.toMatchObject({ verificationUri: new URL(uri).toString() })
    } else {
      await expect(run).rejects.toMatchObject({ code: 'provider_unavailable' })
    }
  })

  it('does not follow OAuth token redirects and treats 3xx as provider_unavailable', async () => {
    repos.peekState.mockResolvedValue({
      safe: {
        state: 'dev-redir',
        flow: 'device',
        intent: 'connect',
        status: 'pending',
        connectionKey: CONNECTION_KEY,
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
        cancelledAt: null,
        createdAt: new Date(),
      },
      deviceCode: 'device-secret',
    })
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 307,
      json: async () => ({}),
    })
    await expect(pollGrokDevice(deps(fetchFn), 'dev-redir')).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    expect(fetchFn).toHaveBeenCalledWith(
      GROK_OAUTH_TOKEN_URL,
      expect.objectContaining({ redirect: 'manual' })
    )
  })

  it('exchanges a completed device poll for access and refresh tokens', async () => {
    repos.peekState.mockResolvedValue({
      safe: {
        state: 'dev-ok',
        flow: 'device',
        intent: 'connect',
        status: 'pending',
        connectionKey: CONNECTION_KEY,
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
        cancelledAt: null,
        createdAt: new Date(),
      },
      deviceCode: 'device-secret',
    })
    repos.consumeState.mockResolvedValue({
      safe: {
        state: 'dev-ok',
        flow: 'device',
        intent: 'connect',
        status: 'consumed',
        connectionKey: CONNECTION_KEY,
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: new Date(),
        cancelledAt: null,
        createdAt: new Date(),
      },
      deviceCode: 'device-secret',
    })
    repos.getSafe.mockResolvedValue(null)
    repos.insertInitial.mockResolvedValue({
      connectionKey: CONNECTION_KEY,
      status: 'connected',
      credentialRevision: 1,
      accountFingerprint: fingerprint('acct_raw_123'),
    })
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        expires_in: 60,
        id_token: idTokenFor('acct_raw_123'),
      }),
    })
    const connected = await pollGrokDevice(deps(fetchFn), 'dev-ok')
    expect(connected.status).toBe('connected')
    const body = String(fetchFn.mock.calls[0]?.[1]?.body)
    expect(body).toContain(`grant_type=${encodeURIComponent(GROK_OAUTH_DEVICE_GRANT)}`)
    expect(repos.insertInitial.mock.calls[0]?.[2]).toMatchObject({
      refreshToken: 'refresh-secret',
      accessToken: 'access-secret',
    })
    assertNoLeak(connected)
  })

  it('rejects a refresh 200 that omits refresh_token', async () => {
    repos.getSafe.mockResolvedValue({
      connectionKey: CONNECTION_KEY,
      status: 'connected',
      credentialRevision: 3,
      refreshLockHeld: true,
    })
    repos.acquireLock.mockResolvedValue(true)
    repos.loadSecrets.mockResolvedValue({
      refreshToken: 'old-refresh',
      accessToken: null,
      accessTokenExpiresAt: null,
      credentialRevision: 3,
    })
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'access-secret',
        id_token: idTokenFor('acct_raw_123'),
      }),
    })
    await expect(refreshGrokSubscriptionConnection(deps(fetchFn))).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    expect(repos.persistRefresh).not.toHaveBeenCalled()
    expect(repos.releaseLock).toHaveBeenCalled()
  })

  it('maps refresh 403 to provider_unavailable', async () => {
    repos.getSafe.mockResolvedValue({
      connectionKey: CONNECTION_KEY,
      status: 'connected',
      credentialRevision: 3,
      refreshLockHeld: true,
    })
    repos.acquireLock.mockResolvedValue(true)
    repos.loadSecrets.mockResolvedValue({
      refreshToken: 'old-refresh',
      accessToken: null,
      accessTokenExpiresAt: null,
      credentialRevision: 3,
    })
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'access_denied' }),
    })
    await expect(refreshGrokSubscriptionConnection(deps(fetchFn))).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    expect(repos.persistRefresh).not.toHaveBeenCalled()
  })

  it('maps refresh 402 to provider_unavailable', async () => {
    repos.getSafe.mockResolvedValue({
      connectionKey: CONNECTION_KEY,
      status: 'connected',
      credentialRevision: 3,
      refreshLockHeld: true,
    })
    repos.acquireLock.mockResolvedValue(true)
    repos.loadSecrets.mockResolvedValue({
      refreshToken: 'old-refresh',
      accessToken: null,
      accessTokenExpiresAt: null,
      credentialRevision: 3,
    })
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ error: 'payment_required' }),
    })
    await expect(refreshGrokSubscriptionConnection(deps(fetchFn))).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    expect(repos.persistRefresh).not.toHaveBeenCalled()
  })

  it('maps invalid_grant with unchanged lock and revision to reauth_required', async () => {
    repos.getSafe.mockResolvedValue({
      connectionKey: CONNECTION_KEY,
      status: 'connected',
      credentialRevision: 3,
      refreshLockHeld: true,
    })
    repos.acquireLock.mockResolvedValue(true)
    repos.loadSecrets.mockResolvedValue({
      refreshToken: 'old-refresh',
      accessToken: null,
      accessTokenExpiresAt: null,
      credentialRevision: 3,
    })
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    })
    await expect(refreshGrokSubscriptionConnection(deps(fetchFn))).rejects.toMatchObject({
      code: 'reauth_required',
    })
    expect(repos.markMismatch).toHaveBeenCalled()
    expect(repos.persistRefresh).not.toHaveBeenCalled()
  })

  it('maps invalid_grant after a lock/revision change to a lost race', async () => {
    const before = {
      connectionKey: CONNECTION_KEY,
      status: 'connected' as const,
      credentialRevision: 3,
      refreshLockHeld: true,
    }
    repos.getSafe
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce({
        connectionKey: CONNECTION_KEY,
        status: 'connected',
        credentialRevision: 4,
        refreshLockHeld: false,
      })
    repos.acquireLock.mockResolvedValue(true)
    repos.loadSecrets
      .mockResolvedValueOnce({
        refreshToken: 'old-refresh',
        accessToken: null,
        accessTokenExpiresAt: null,
        credentialRevision: 3,
      })
      .mockResolvedValueOnce({
        refreshToken: 'winner-refresh',
        accessToken: 'access-secret',
        accessTokenExpiresAt: new Date(Date.now() + 60_000),
        credentialRevision: 4,
      })
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'invalid_grant' }),
    })
    await expect(refreshGrokSubscriptionConnection(deps(fetchFn))).rejects.toMatchObject({
      code: 'stale_revision',
    })
  })

  it('persists the rotated refresh ciphertext before later processing', async () => {
    repos.getSafe.mockResolvedValue({
      connectionKey: CONNECTION_KEY,
      status: 'connected',
      credentialRevision: 7,
      accountFingerprint: fingerprint('acct_raw_123'),
      refreshLockHeld: true,
    })
    repos.acquireLock.mockResolvedValue(true)
    repos.loadSecrets.mockResolvedValue({
      refreshToken: 'old-refresh',
      accessToken: null,
      accessTokenExpiresAt: null,
      credentialRevision: 7,
    })
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'access-secret',
        refresh_token: 'rotated-refresh',
        id_token: idTokenFor('acct_raw_123'),
      }),
    })
    repos.persistRefresh.mockRejectedValueOnce(new GrokSubscriptionStaleRevisionError())
    await expect(refreshGrokSubscriptionConnection(deps(fetchFn))).rejects.toMatchObject({
      code: 'stale_revision',
    })
    expect(repos.persistRefresh).toHaveBeenCalledWith(
      expect.anything(),
      KEY,
      expect.objectContaining({
        refreshToken: 'rotated-refresh',
        expectedRevision: 7,
        connectionKey: CONNECTION_KEY,
      })
    )
    expect(repos.updateInPlace).not.toHaveBeenCalled()
    expect(repos.releaseLock).toHaveBeenCalled()
  })

  it('persists a rotated refresh before failing closed on an opaque token with no subject', async () => {
    repos.getSafe.mockResolvedValue({
      connectionKey: CONNECTION_KEY,
      status: 'connected',
      credentialRevision: 7,
      accountFingerprint: fingerprint('acct_raw_123'),
      refreshLockHeld: true,
    })
    repos.acquireLock.mockResolvedValue(true)
    repos.loadSecrets.mockResolvedValue({
      refreshToken: 'old-refresh',
      accessToken: null,
      accessTokenExpiresAt: null,
      credentialRevision: 7,
    })
    repos.persistRefresh.mockResolvedValue({
      connectionKey: CONNECTION_KEY,
      status: 'connected',
      credentialRevision: 7,
    })
    repos.markMismatch.mockResolvedValue({
      connectionKey: CONNECTION_KEY,
      status: 'reauth_required',
      credentialRevision: 7,
    })
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'opaque-access-token',
        refresh_token: 'rotated-refresh',
      }),
    })
    const refreshed = await refreshGrokSubscriptionConnection(deps(fetchFn))
    expect(refreshed.status).toBe('reauth_required')
    expect(repos.persistRefresh).toHaveBeenCalledWith(
      expect.anything(),
      KEY,
      expect.objectContaining({ refreshToken: 'rotated-refresh' })
    )
    expect(repos.markMismatch).toHaveBeenCalled()
    expect(repos.updateInPlace).not.toHaveBeenCalled()
  })

  it('keeps the stored fingerprint and marks reauth_required when the subject differs', async () => {
    repos.getSafe.mockResolvedValue({
      connectionKey: CONNECTION_KEY,
      status: 'connected',
      credentialRevision: 2,
      accountFingerprint: fingerprint('acct_raw_123'),
      refreshLockHeld: true,
    })
    repos.acquireLock.mockResolvedValue(true)
    repos.loadSecrets.mockResolvedValue({
      refreshToken: 'old-refresh',
      accessToken: null,
      accessTokenExpiresAt: null,
      credentialRevision: 2,
    })
    repos.persistRefresh.mockResolvedValue({
      connectionKey: CONNECTION_KEY,
      status: 'connected',
      credentialRevision: 2,
      accountFingerprint: fingerprint('acct_raw_123'),
    })
    repos.updateInPlace.mockResolvedValue({
      connectionKey: CONNECTION_KEY,
      status: 'connected',
      credentialRevision: 2,
      accountFingerprint: fingerprint('acct_raw_123'),
    })
    repos.markMismatch.mockResolvedValue({
      connectionKey: CONNECTION_KEY,
      status: 'reauth_required',
      credentialRevision: 2,
      accountFingerprint: fingerprint('acct_raw_123'),
    })
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'access-secret',
        refresh_token: 'rotated-refresh',
        id_token: idTokenFor('other-subject'),
      }),
    })
    const refreshed = await refreshGrokSubscriptionConnection(deps(fetchFn))
    expect(refreshed.status).toBe('reauth_required')
    expect(repos.persistRefresh).toHaveBeenCalled()
    expect(repos.markMismatch).toHaveBeenCalled()
    expect(repos.updateInPlace).not.toHaveBeenCalled()
    expect(repos.rotate).not.toHaveBeenCalled()
  })

  it('refreshes an expiring access token through persist-first', async () => {
    repos.loadSecrets.mockResolvedValue({
      refreshToken: 'refresh-secret',
      accessToken: 'stale-access',
      accessTokenExpiresAt: new Date(Date.now() + 30_000),
      credentialRevision: 3,
    })
    repos.getSafe.mockResolvedValue({
      connectionKey: CONNECTION_KEY,
      status: 'connected',
      credentialRevision: 3,
      accountFingerprint: fingerprint('acct_raw_123'),
      refreshLockHeld: true,
    })
    repos.acquireLock.mockResolvedValue(true)
    repos.persistRefresh.mockResolvedValue({
      connectionKey: CONNECTION_KEY,
      status: 'connected',
      credentialRevision: 3,
    })
    repos.updateInPlace.mockResolvedValue({
      connectionKey: CONNECTION_KEY,
      status: 'connected',
      credentialRevision: 3,
    })
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'access-secret',
        refresh_token: 'rotated-refresh',
        id_token: idTokenFor('acct_raw_123'),
      }),
    })
    await ensureFreshGrokAccessToken(deps(fetchFn))
    expect(repos.persistRefresh).toHaveBeenCalled()
    expect(repos.updateInPlace).toHaveBeenCalled()
    expect(repos.releaseLock).toHaveBeenCalled()
  })
})

function pendingState(state: string, status: 'pending' | 'consumed' = 'pending') {
  return {
    safe: {
      state,
      flow: 'device',
      intent: 'connect',
      status,
      connectionKey: CONNECTION_KEY,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: status === 'consumed' ? new Date() : null,
      cancelledAt: null,
      createdAt: new Date(),
    },
    deviceCode: 'device-secret',
  }
}

function tokenFetch(subject = 'acct_raw_123') {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: 'access-secret',
      refresh_token: 'refresh-secret',
      expires_in: 60,
      id_token: idTokenFor(subject),
    }),
  })
}

const REVOKED_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  connectionKey: CONNECTION_KEY,
  status: 'revoked',
  credentialRevision: 2,
  accountFingerprint: null,
  revokedAt: new Date(),
}

const LIVE_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  connectionKey: CONNECTION_KEY,
  status: 'connected',
  credentialRevision: 1,
  accountFingerprint: fingerprint('acct_raw_123'),
  revokedAt: null,
}

describe('grok subscription grant lifecycle (revocation is terminal per key)', () => {
  beforeEach(() => {
    for (const fn of Object.values(repos)) fn.mockReset()
    vi.mocked(rebuildLiveGrokUnionAllowlist).mockReset()
  })

  it('refuses to start device authorization for a revoked key', async () => {
    repos.getAny.mockResolvedValue(REVOKED_ROW)
    const fetchFn = vi.fn()
    await expect(startGrokDeviceConnect(deps(fetchFn), 'connect')).rejects.toMatchObject({
      code: 'not_connected',
    })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(repos.insertState).not.toHaveBeenCalled()
  })

  it('refuses to poll a device flow for a revoked key before consuming state or calling upstream', async () => {
    repos.getAny.mockResolvedValue(REVOKED_ROW)
    repos.peekState.mockResolvedValue(pendingState('dev-revoked'))
    const fetchFn = tokenFetch()
    await expect(pollGrokDevice(deps(fetchFn), 'dev-revoked')).rejects.toMatchObject({
      code: 'not_connected',
    })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(repos.consumeState).not.toHaveBeenCalled()
    expect(repos.insertInitial).not.toHaveBeenCalled()
  })

  it('does not recreate a live row when the key is revoked after the state was consumed', async () => {
    repos.getAny.mockResolvedValueOnce(null).mockResolvedValue(REVOKED_ROW)
    repos.peekState.mockResolvedValue(pendingState('dev-late'))
    repos.consumeState.mockResolvedValue(pendingState('dev-late', 'consumed'))
    await expect(pollGrokDevice(deps(tokenFetch()), 'dev-late')).rejects.toMatchObject({
      code: 'not_connected',
    })
    expect(repos.insertInitial).not.toHaveBeenCalled()
    expect(repos.rotate).not.toHaveBeenCalled()
  })

  it('maps a first-grant key race against a live row to stale_revision', async () => {
    repos.getAny.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(LIVE_ROW)
    repos.peekState.mockResolvedValue(pendingState('dev-race'))
    repos.consumeState.mockResolvedValue(pendingState('dev-race', 'consumed'))
    repos.insertInitial.mockRejectedValue(new GrokSubscriptionConnectionKeyConflictError())
    await expect(pollGrokDevice(deps(tokenFetch()), 'dev-race')).rejects.toMatchObject({
      code: 'stale_revision',
    })
  })

  it('maps a first-grant key conflict against a revoked tombstone to not_connected', async () => {
    repos.getAny
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(REVOKED_ROW)
    repos.peekState.mockResolvedValue(pendingState('dev-tomb'))
    repos.consumeState.mockResolvedValue(pendingState('dev-tomb', 'consumed'))
    repos.insertInitial.mockRejectedValue(new GrokSubscriptionConnectionKeyConflictError())
    await expect(pollGrokDevice(deps(tokenFetch()), 'dev-tomb')).rejects.toMatchObject({
      code: 'not_connected',
    })
  })

  it('maps a rotate that lost to a concurrent revoke to not_connected', async () => {
    repos.getAny
      .mockResolvedValueOnce(LIVE_ROW)
      .mockResolvedValueOnce(LIVE_ROW)
      .mockResolvedValue(REVOKED_ROW)
    repos.peekState.mockResolvedValue(pendingState('dev-rotate'))
    repos.consumeState.mockResolvedValue(pendingState('dev-rotate', 'consumed'))
    repos.rotate.mockRejectedValue(new GrokSubscriptionStaleRevisionError())
    await expect(pollGrokDevice(deps(tokenFetch()), 'dev-rotate')).rejects.toMatchObject({
      code: 'not_connected',
    })
  })

  it('revokes the grant and rebuilds the union inside one transaction, upstream revoke after commit', async () => {
    const events: string[] = []
    repos.loadSecrets.mockResolvedValue({
      refreshToken: 'refresh-secret',
      accessToken: null,
      accessTokenExpiresAt: null,
      credentialRevision: 1,
    })
    repos.revokeConnection.mockImplementation(async (db: unknown) => {
      events.push(db === 'tx' ? 'revoke:tx' : 'revoke:outside')
      return REVOKED_ROW
    })
    vi.mocked(rebuildLiveGrokUnionAllowlist).mockImplementation(async (db: unknown) => {
      events.push(db === 'tx' ? 'rebuild:tx' : 'rebuild:outside')
    })
    const fetchFn = vi.fn().mockImplementation(async () => {
      events.push('upstream')
      return { ok: true, status: 200, json: async () => ({}) }
    })
    const withTransaction = vi.fn(async (work: (tx: never) => Promise<unknown>) => {
      events.push('begin')
      const result = await work('tx' as never)
      events.push('commit')
      return result
    })
    const revoked = await revokeGrokSubscription({
      ...deps(fetchFn),
      withTransaction: withTransaction as never,
    })
    expect(revoked).toMatchObject({ status: 'revoked' })
    expect(events).toEqual(['begin', 'revoke:tx', 'rebuild:tx', 'commit', 'upstream'])
  })
})
