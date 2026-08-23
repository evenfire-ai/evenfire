import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { CodexSubscriptionStaleRevisionError } from '../src/services/codexSubscriptionConnection.js'

const repos = vi.hoisted(() => ({
  insertState: vi.fn(),
  consumeState: vi.fn(),
  peekState: vi.fn(),
  expireState: vi.fn(),
  cancelState: vi.fn(),
  getSafe: vi.fn(),
  insertInitial: vi.fn(),
  rotate: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  loadSecrets: vi.fn(),
  revokeConnection: vi.fn(),
  updateInPlace: vi.fn(),
  persistAccountId: vi.fn(),
}))

vi.mock('../src/services/codexSubscriptionOAuthState.js', async () => {
  const actual = await vi.importActual('../src/services/codexSubscriptionOAuthState.js')
  return {
    ...actual,
    insertCodexSubscriptionOAuthState: repos.insertState,
    consumeCodexSubscriptionOAuthState: repos.consumeState,
    peekPendingCodexSubscriptionOAuthState: repos.peekState,
    expireCodexSubscriptionOAuthState: repos.expireState,
    cancelCodexSubscriptionOAuthState: repos.cancelState,
  }
})

vi.mock('../src/services/codexSubscriptionConnection.js', async () => {
  const actual = await vi.importActual('../src/services/codexSubscriptionConnection.js')
  return {
    ...actual,
    getSafeCodexSubscriptionConnection: repos.getSafe,
    insertInitialCodexSubscriptionConnection: repos.insertInitial,
    rotateCodexSubscriptionCredentials: repos.rotate,
    acquireCodexSubscriptionRefreshLock: repos.acquireLock,
    releaseCodexSubscriptionRefreshLock: repos.releaseLock,
    loadCodexSubscriptionSecrets: repos.loadSecrets,
    revokeCodexSubscriptionConnection: repos.revokeConnection,
    updateCodexAccessTokenInPlace: repos.updateInPlace,
    persistCodexChatgptAccountId: repos.persistAccountId,
  }
})

const {
  CodexSubscriptionOAuthError,
  CODEX_OAUTH_AUTHORIZE_URL,
  CODEX_OAUTH_DEVICE_CALLBACK_URI,
  CODEX_OAUTH_DEVICE_TOKEN_URL,
  CODEX_OAUTH_DEVICE_USERCODE_URL,
  CODEX_OAUTH_DEVICE_VERIFICATION_URI,
  handleCodexBrowserCallback,
  pollCodexDevice,
  ensureFreshCodexAccessToken,
  refreshCodexSubscriptionConnection,
  revokeCodexSubscription,
  startCodexBrowserConnect,
  startCodexDeviceConnect,
} = await import('../src/services/codexSubscriptionOAuth.js')

const KEY = deriveOAuthEncryptionKey('ab'.repeat(32))

function idTokenFor(subject: string, accountId?: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      sub: subject,
      ...(accountId ? { chatgpt_account_id: accountId } : {}),
    })
  ).toString('base64url')
  return `hdr.${payload}.sig`
}

function fingerprint(subject: string): string {
  return createHash('sha256').update(subject, 'utf8').digest('hex')
}

function assertNoLeak(value: unknown): void {
  const serialized = JSON.stringify(value)
  expect(serialized).not.toMatch(
    /sk-|Bearer |eyJ[A-Za-z0-9_-]+\.|refresh-secret|access-secret|cookie/i
  )
  expect(serialized).not.toContain('acct_raw_123')
}

function deps(fetchFn: typeof fetch) {
  return {
    db: { query: vi.fn() },
    encryptionKey: KEY,
    fetchFn,
    clientId: 'app_test_client',
    redirectUri: 'https://control.example.com/control-api/api/v1/auth/codex-subscription/callback',
    enabled: true,
  }
}

describe('codex subscription OAuth broker', () => {
  beforeEach(() => {
    for (const fn of Object.values(repos)) fn.mockReset()
  })

  it('starts a browser PKCE flow without leaking secrets', async () => {
    repos.insertState.mockImplementation(
      async (
        _db: unknown,
        _key: Buffer,
        input: { state: string; intent: string; expiresAt: Date }
      ) => ({
        state: input.state,
        flow: 'browser',
        intent: input.intent,
        status: 'pending',
        expiresAt: input.expiresAt,
        consumedAt: null,
        cancelledAt: null,
        createdAt: new Date(),
      })
    )
    const oauthDeps = deps(vi.fn())
    const result = await startCodexBrowserConnect(oauthDeps, 'connect')
    expect(result.authorizeUrl.startsWith(CODEX_OAUTH_AUTHORIZE_URL)).toBe(true)
    expect(result.authorizeUrl).toContain('code_challenge_method=S256')
    expect(result.authorizeUrl).toContain('state=')
    expect(result.authorizeUrl).toContain(encodeURIComponent(oauthDeps.redirectUri))
    expect(repos.insertState.mock.calls[0]?.[2]).toMatchObject({
      flow: 'browser',
      intent: 'connect',
    })
    expect(repos.insertState.mock.calls[0]?.[2].pkceVerifier).toEqual(expect.any(String))
    assertNoLeak(result)
    expect(JSON.stringify(result)).not.toContain(repos.insertState.mock.calls[0]?.[2].pkceVerifier)
  })

  it('rejects a replayed browser callback', async () => {
    repos.consumeState.mockResolvedValueOnce(null)
    await expect(
      handleCodexBrowserCallback(deps(vi.fn()), { code: 'code-1', state: 'state-1' })
    ).rejects.toMatchObject({ code: 'state_replayed' })
  })

  it('reconnects the same account and requires replace for a different account', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        expires_in: 60,
        id_token: idTokenFor('acct_raw_123'),
      }),
    })
    repos.consumeState.mockResolvedValue({
      safe: {
        state: 'state-1',
        flow: 'browser',
        intent: 'connect',
        status: 'consumed',
        expiresAt: new Date(Date.now() + 1000),
        consumedAt: new Date(),
        cancelledAt: null,
        createdAt: new Date(),
      },
      pkceVerifier: 'verifier',
    })
    repos.getSafe.mockResolvedValue({
      connectionKey: 'deployment-default',
      status: 'connected',
      credentialRevision: 2,
      catalogRevision: 0,
      accountFingerprint: fingerprint('acct_raw_123'),
      catalogStatus: 'ready',
      catalogSyncedAt: null,
      lastRefreshAt: null,
      lastAuthAt: null,
      refreshLockHeld: false,
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    repos.rotate.mockResolvedValue({
      connectionKey: 'deployment-default',
      status: 'connected',
      credentialRevision: 3,
      accountFingerprint: fingerprint('acct_raw_123'),
    })

    const same = await handleCodexBrowserCallback(deps(fetchFn), {
      code: 'code-1',
      state: 'state-1',
    })
    expect(same.credentialRevision).toBe(3)
    assertNoLeak(same)

    repos.consumeState.mockResolvedValue({
      safe: {
        state: 'state-2',
        flow: 'browser',
        intent: 'connect',
        status: 'consumed',
        expiresAt: new Date(Date.now() + 1000),
        consumedAt: new Date(),
        cancelledAt: null,
        createdAt: new Date(),
      },
      pkceVerifier: 'verifier',
    })
    fetchFn.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        id_token: idTokenFor('acct_other'),
      }),
    })
    await expect(
      handleCodexBrowserCallback(deps(fetchFn), { code: 'code-2', state: 'state-2' })
    ).rejects.toMatchObject({ code: 'replacement_required' })
    expect(repos.rotate).toHaveBeenCalledTimes(1)
  })

  it('persists a different account only with explicit replace intent', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        id_token: idTokenFor('acct_other'),
      }),
    })
    repos.consumeState.mockResolvedValue({
      safe: {
        state: 'state-r',
        flow: 'browser',
        intent: 'replace',
        status: 'consumed',
        expiresAt: new Date(Date.now() + 1000),
        consumedAt: new Date(),
        cancelledAt: null,
        createdAt: new Date(),
      },
      pkceVerifier: 'verifier',
    })
    repos.getSafe.mockResolvedValue({
      connectionKey: 'deployment-default',
      status: 'connected',
      credentialRevision: 4,
      accountFingerprint: fingerprint('acct_raw_123'),
    })
    repos.rotate.mockResolvedValue({
      connectionKey: 'deployment-default',
      status: 'connected',
      credentialRevision: 5,
      accountFingerprint: fingerprint('acct_other'),
    })
    const replaced = await handleCodexBrowserCallback(deps(fetchFn), {
      code: 'code-r',
      state: 'state-r',
    })
    expect(replaced.credentialRevision).toBe(5)
    expect(replaced.accountFingerprint).toBe(fingerprint('acct_other'))
    assertNoLeak(replaced)
  })

  it('polls device authorization with expiry and backoff', async () => {
    const handle = JSON.stringify({ deviceAuthId: 'deviceauth_secret', userCode: 'ABCD-EFGH' })
    repos.peekState.mockResolvedValue({
      safe: {
        state: 'dev-1',
        flow: 'device',
        intent: 'connect',
        status: 'pending',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
        cancelledAt: null,
        createdAt: new Date(),
      },
      deviceCode: handle,
    })
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: { code: 'slow_down' }, interval: '10' }),
      })
    await expect(pollCodexDevice(deps(fetchFn), 'dev-1')).resolves.toMatchObject({
      status: 'pending',
      intervalSeconds: 5,
    })
    expect(fetchFn.mock.calls[0]?.[0]).toBe(CODEX_OAUTH_DEVICE_TOKEN_URL)
    await expect(pollCodexDevice(deps(fetchFn), 'dev-1')).resolves.toMatchObject({
      status: 'slow_down',
      intervalSeconds: 10,
    })

    repos.peekState.mockResolvedValue({
      safe: {
        state: 'dev-exp',
        flow: 'device',
        intent: 'connect',
        status: 'pending',
        expiresAt: new Date(Date.now() - 1),
        consumedAt: null,
        cancelledAt: null,
        createdAt: new Date(),
      },
      deviceCode: handle,
    })
    await expect(pollCodexDevice(deps(fetchFn), 'dev-exp')).resolves.toEqual({ status: 'expired' })
    expect(repos.expireState).toHaveBeenCalled()
  })

  it('exchanges a completed device poll through the Codex device callback', async () => {
    const handle = JSON.stringify({ deviceAuthId: 'deviceauth_secret', userCode: 'ABCD-EFGH' })
    repos.peekState.mockResolvedValue({
      safe: {
        state: 'dev-ok',
        flow: 'device',
        intent: 'connect',
        status: 'pending',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
        cancelledAt: null,
        createdAt: new Date(),
      },
      deviceCode: handle,
    })
    repos.consumeState.mockResolvedValue({
      safe: {
        state: 'dev-ok',
        flow: 'device',
        intent: 'connect',
        status: 'consumed',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: new Date(),
        cancelledAt: null,
        createdAt: new Date(),
      },
      deviceCode: handle,
    })
    repos.getSafe.mockResolvedValue(null)
    repos.insertInitial.mockResolvedValue({
      connectionKey: 'deployment-default',
      status: 'connected',
      credentialRevision: 1,
      accountFingerprint: fingerprint('acct_raw_123'),
    })
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          authorization_code: 'authz-code',
          code_verifier: 'pkce-from-poll',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'access-secret',
          refresh_token: 'refresh-secret',
          expires_in: 60,
          id_token: idTokenFor('acct_raw_123'),
        }),
      })
    const connected = await pollCodexDevice(deps(fetchFn), 'dev-ok')
    expect(connected.status).toBe('connected')
    expect(fetchFn.mock.calls[1]?.[0]).toContain('/oauth/token')
    expect(String(fetchFn.mock.calls[1]?.[1]?.body)).toContain(
      encodeURIComponent(CODEX_OAUTH_DEVICE_CALLBACK_URI)
    )
    expect(String(fetchFn.mock.calls[1]?.[1]?.body)).toContain('code_verifier=pkce-from-poll')
    assertNoLeak(connected)
    expect(JSON.stringify(connected)).not.toContain('deviceauth_secret')
  })

  it('rejects a stale refresh and persists a rotated refresh token', async () => {
    repos.getSafe.mockResolvedValue({
      connectionKey: 'deployment-default',
      status: 'connected',
      credentialRevision: 7,
    })
    repos.acquireLock.mockResolvedValueOnce(true)
    repos.loadSecrets.mockResolvedValue({
      refreshToken: 'old-refresh',
      accessToken: null,
      accessTokenExpiresAt: null,
      chatgptAccountId: null,
      credentialRevision: 7,
    })
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'access-secret',
        refresh_token: 'rotated-refresh',
        id_token: idTokenFor('acct_raw_123'),
      }),
    })
    repos.rotate.mockRejectedValueOnce(new CodexSubscriptionStaleRevisionError())
    await expect(refreshCodexSubscriptionConnection(deps(fetchFn))).rejects.toMatchObject({
      code: 'stale_revision',
    })
    expect(repos.releaseLock).toHaveBeenCalled()

    repos.acquireLock.mockResolvedValueOnce(true)
    repos.rotate.mockResolvedValueOnce({
      connectionKey: 'deployment-default',
      status: 'connected',
      credentialRevision: 8,
      accountFingerprint: fingerprint('acct_raw_123'),
    })
    const refreshed = await refreshCodexSubscriptionConnection(deps(fetchFn))
    expect(repos.rotate.mock.calls.at(-1)?.[3]).toMatchObject({ refreshToken: 'rotated-refresh' })
    assertNoLeak(refreshed)
  })

  it('refreshes an expiring access token in place without rotating credential_revision', async () => {
    repos.loadSecrets.mockResolvedValue({
      refreshToken: 'refresh-secret',
      accessToken: 'stale-access',
      accessTokenExpiresAt: new Date(Date.now() + 30_000),
      chatgptAccountId: null,
      credentialRevision: 3,
    })
    repos.acquireLock.mockResolvedValue(true)
    repos.updateInPlace.mockResolvedValue({
      connectionKey: 'deployment-default',
      status: 'connected',
      credentialRevision: 3,
      accountFingerprint: 'fp',
    })
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'access-secret',
        id_token: idTokenFor('acct_raw_123', 'acct_live_9'),
      }),
    })
    await ensureFreshCodexAccessToken(deps(fetchFn))
    expect(repos.updateInPlace).toHaveBeenCalledWith(
      expect.anything(),
      KEY,
      3,
      expect.objectContaining({ accessToken: 'access-secret', chatgptAccountId: 'acct_live_9' }),
      'deployment-default'
    )
    expect(repos.rotate).not.toHaveBeenCalled()
    expect(repos.releaseLock).toHaveBeenCalled()
  })

  it('revokes locally even when upstream revoke fails', async () => {
    repos.loadSecrets.mockResolvedValue({
      refreshToken: 'refresh-secret',
      accessToken: 'access-secret',
      accessTokenExpiresAt: null,
      chatgptAccountId: null,
      credentialRevision: 3,
    })
    repos.revokeConnection.mockResolvedValue({
      connectionKey: 'deployment-default',
      status: 'revoked',
      credentialRevision: 4,
      accountFingerprint: null,
    })
    const fetchFn = vi.fn().mockRejectedValue(new Error('upstream down'))
    const revoked = await revokeCodexSubscription(deps(fetchFn))
    expect(revoked.status).toBe('revoked')
    expect(repos.revokeConnection).toHaveBeenCalled()
    assertNoLeak(revoked)
  })

  it('starts device flow without returning the device auth handle', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        device_auth_id: 'deviceauth_secret',
        user_code: 'ABCD-EFGH',
        interval: '5',
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      }),
    })
    repos.insertState.mockImplementation(
      async (_db: unknown, _key: Buffer, input: { state: string; deviceCode?: string }) => ({
        state: input.state,
        flow: 'device',
        intent: 'connect',
        status: 'pending',
        expiresAt: new Date(Date.now() + 600_000),
        consumedAt: null,
        cancelledAt: null,
        createdAt: new Date(),
      })
    )
    const started = await startCodexDeviceConnect(deps(fetchFn), 'connect')
    expect(fetchFn.mock.calls[0]?.[0]).toBe(CODEX_OAUTH_DEVICE_USERCODE_URL)
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({
      client_id: 'app_test_client',
    })
    expect(started.userCode).toBe('ABCD-EFGH')
    expect(started.verificationUri).toBe(CODEX_OAUTH_DEVICE_VERIFICATION_URI)
    expect(started.intervalSeconds).toBe(5)
    expect(repos.insertState.mock.calls[0]?.[2].deviceCode).toContain('deviceauth_secret')
    assertNoLeak(started)
    expect(JSON.stringify(started)).not.toContain('deviceauth_secret')
  })

  it('exposes only bounded error classes', () => {
    const err = new CodexSubscriptionOAuthError('replacement_required', 'need replace')
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('replacement_required')
  })

  it('persists a named browser grant from the OAuth state, not from empty deps', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        expires_in: 60,
        id_token: idTokenFor('acct_raw_123'),
      }),
    })
    repos.consumeState.mockResolvedValue({
      safe: {
        state: 'state-named',
        flow: 'browser',
        intent: 'connect',
        status: 'consumed',
        connectionKey: 'team-plus',
        expiresAt: new Date(Date.now() + 1000),
        consumedAt: new Date(),
        cancelledAt: null,
        createdAt: new Date(),
      },
      pkceVerifier: 'verifier',
    })
    repos.getSafe.mockResolvedValue(null)
    repos.insertInitial.mockResolvedValue({
      connectionKey: 'team-plus',
      status: 'connected',
      credentialRevision: 1,
    })
    const result = await handleCodexBrowserCallback(deps(fetchFn), {
      code: 'code-1',
      state: 'state-named',
    })
    expect(result.connectionKey).toBe('team-plus')
    expect(repos.insertInitial.mock.calls[0]?.[3]).toBe('team-plus')
    expect(repos.getSafe.mock.calls[0]?.[1]).toBe('team-plus')
  })

  it('rejects a device poll whose route key does not match the state', async () => {
    repos.peekState.mockResolvedValue({
      safe: {
        state: 'state-1',
        flow: 'device',
        intent: 'connect',
        status: 'pending',
        connectionKey: 'team-plus',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
        cancelledAt: null,
        createdAt: new Date(),
      },
      deviceCode: JSON.stringify({ deviceAuthId: 'id', userCode: 'ABCD' }),
    })
    await expect(
      pollCodexDevice({ ...deps(vi.fn()), connectionKey: 'deployment-default' }, 'state-1')
    ).rejects.toMatchObject({
      code: 'connection_mismatch',
    })
    expect(repos.consumeState).not.toHaveBeenCalled()
  })

  it('persists a keyed device poll onto the matching state connection', async () => {
    const handle = JSON.stringify({ deviceAuthId: 'deviceauth_secret', userCode: 'ABCD-EFGH' })
    repos.peekState.mockResolvedValue({
      safe: {
        state: 'state-match',
        flow: 'device',
        intent: 'connect',
        status: 'pending',
        connectionKey: 'team-plus',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
        cancelledAt: null,
        createdAt: new Date(),
      },
      deviceCode: handle,
    })
    repos.consumeState.mockResolvedValue({
      safe: {
        state: 'state-match',
        flow: 'device',
        intent: 'connect',
        status: 'consumed',
        connectionKey: 'team-plus',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: new Date(),
        cancelledAt: null,
        createdAt: new Date(),
      },
      deviceCode: handle,
    })
    repos.getSafe.mockResolvedValue(null)
    repos.insertInitial.mockResolvedValue({
      connectionKey: 'team-plus',
      status: 'connected',
      credentialRevision: 1,
    })
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          authorization_code: 'authz-code',
          code_verifier: 'pkce-from-poll',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'access-secret',
          refresh_token: 'refresh-secret',
          expires_in: 60,
          id_token: idTokenFor('acct_raw_123'),
        }),
      })
    const result = await pollCodexDevice(
      { ...deps(fetchFn), connectionKey: 'team-plus' },
      'state-match'
    )
    expect(result).toMatchObject({ status: 'connected' })
    expect(repos.insertInitial.mock.calls[0]?.[3]).toBe('team-plus')
  })
})
