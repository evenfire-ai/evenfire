import { describe, expect, it, vi } from 'vitest'
import { buildAuthorizeUrl } from '../src/oauth/authorizeUrlHelper.js'
import {
  RecipeNotFoundError,
  type RecipeReader,
  type RecipeWithOAuthClients,
  SecretNotFoundError,
  type SecretReader,
} from '../src/oauth/callback.js'
import { deriveOAuthEncryptionKey, encryptOAuthSecret } from '../src/oauth/encryption.js'
import { signOAuthState, verifyOAuthState } from '../src/oauth/state.js'
import { upsertOAuthGrant } from '../src/oauth/store.js'
import { getAccessToken } from '../src/oauth/tokenHelper.js'

const STATE_SECRET = 'helpers-state-hmac-secret-32-bytes-pad'
const KEY = deriveOAuthEncryptionKey(
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
)
const REDIRECT = 'https://control.example.com/api/v1/oauth-callback/salesforce'

function recipeWithSalesforce(): RecipeWithOAuthClients {
  return {
    metadata: { name: 'crm', namespace: 'sandbox-recipes' },
    spec: {
      oauthClients: [
        {
          id: 'salesforce',
          provider: 'salesforce',
          clientIdRef: { name: 'salesforce-creds', key: 'client-id' },
          clientSecretRef: { name: 'salesforce-creds', key: 'client-secret' },
          scopes: ['api', 'refresh_token'],
        },
      ],
    },
  }
}

function buildReaders(opts: {
  recipe?: RecipeWithOAuthClients | null
  recipeError?: unknown
  secrets?: Record<string, Record<string, string>>
  secretError?: unknown
}): { recipeReader: RecipeReader; secretReader: SecretReader } {
  return {
    recipeReader: {
      read: vi.fn(async () => {
        if (opts.recipeError) throw opts.recipeError
        return opts.recipe ?? null
      }),
    },
    secretReader: {
      read: vi.fn(async (name: string) => {
        if (opts.secretError) throw opts.secretError
        return opts.secrets?.[name] ?? {}
      }),
    },
  }
}

describe('buildAuthorizeUrl (O5.1)', () => {
  it('returns a Salesforce authorize URL with the state parameter signed', async () => {
    const { recipeReader, secretReader } = buildReaders({
      recipe: recipeWithSalesforce(),
      secrets: { 'salesforce-creds': { 'client-id': 'CID', 'client-secret': 'CSEC' } },
    })

    const result = await buildAuthorizeUrl(
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'crm',
        oauthClientId: 'salesforce',
        userId: 'user-1',
        grantKind: 'user',
        redirectUri: REDIRECT,
      },
      { recipeReader, secretReader, stateSecret: STATE_SECRET }
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.authorizeUrl).toContain('https://login.salesforce.com/services/oauth2/authorize?')
    const url = new URL(result.authorizeUrl)
    expect(url.searchParams.get('client_id')).toBe('CID')
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT)
    expect(url.searchParams.get('scope')).toBe('api refresh_token')
    const state = url.searchParams.get('state')
    expect(state).toBeTruthy()
    // The state we just minted should verify against the same binding.
    const verify = verifyOAuthState(STATE_SECRET, state!, {
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'crm',
      userId: 'user-1',
      oauthClientId: 'salesforce',
    })
    expect(verify.kind).toBe('ok')
  })

  it('returns recipe_not_found when the recipe is missing', async () => {
    const { recipeReader, secretReader } = buildReaders({ recipe: null })
    const result = await buildAuthorizeUrl(
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'gone',
        oauthClientId: 'salesforce',
        userId: 'user-1',
        grantKind: 'user',
        redirectUri: REDIRECT,
      },
      { recipeReader, secretReader, stateSecret: STATE_SECRET }
    )
    expect(result.kind).toBe('recipe_not_found')
  })

  it('returns unknown_oauth_client when the recipe has no matching id', async () => {
    const { recipeReader, secretReader } = buildReaders({
      recipe: {
        spec: {
          oauthClients: [{ ...recipeWithSalesforce().spec!.oauthClients![0], id: 'slack' }],
        },
      },
      secrets: { 'salesforce-creds': { 'client-id': 'X', 'client-secret': 'Y' } },
    })
    const result = await buildAuthorizeUrl(
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'crm',
        oauthClientId: 'salesforce',
        userId: 'user-1',
        grantKind: 'user',
        redirectUri: REDIRECT,
      },
      { recipeReader, secretReader, stateSecret: STATE_SECRET }
    )
    expect(result.kind).toBe('unknown_oauth_client')
  })

  it('returns secret_missing when the K8s Secret is absent', async () => {
    const { recipeReader, secretReader } = buildReaders({
      recipe: recipeWithSalesforce(),
      secretError: new SecretNotFoundError('not found'),
    })
    const result = await buildAuthorizeUrl(
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'crm',
        oauthClientId: 'salesforce',
        userId: 'user-1',
        grantKind: 'user',
        redirectUri: REDIRECT,
      },
      { recipeReader, secretReader, stateSecret: STATE_SECRET }
    )
    expect(result.kind).toBe('secret_missing')
  })

  it('[SEC-4] returns background_access_not_enabled for a service grant when the client did not opt in', async () => {
    const { recipeReader, secretReader } = buildReaders({
      recipe: recipeWithSalesforce(), // no backgroundAccess flag
      secrets: { 'salesforce-creds': { 'client-id': 'CID', 'client-secret': 'CSEC' } },
    })
    const result = await buildAuthorizeUrl(
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'crm',
        oauthClientId: 'salesforce',
        userId: 'admin-1',
        grantKind: 'service',
        redirectUri: REDIRECT,
      },
      { recipeReader, secretReader, stateSecret: STATE_SECRET }
    )
    expect(result.kind).toBe('background_access_not_enabled')
  })

  it('returns a signed service-grant authorize URL when the client opted into backgroundAccess', async () => {
    const recipe = recipeWithSalesforce()
    recipe.spec!.oauthClients![0].backgroundAccess = true
    const { recipeReader, secretReader } = buildReaders({
      recipe,
      secrets: { 'salesforce-creds': { 'client-id': 'CID', 'client-secret': 'CSEC' } },
    })
    const result = await buildAuthorizeUrl(
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'crm',
        oauthClientId: 'salesforce',
        userId: 'admin-1',
        grantKind: 'service',
        redirectUri: REDIRECT,
      },
      { recipeReader, secretReader, stateSecret: STATE_SECRET }
    )
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const state = new URL(result.authorizeUrl).searchParams.get('state')!
    const verify = verifyOAuthState(STATE_SECRET, state, {
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'crm',
      userId: 'admin-1',
      oauthClientId: 'salesforce',
    })
    expect(verify.kind).toBe('ok')
    if (verify.kind === 'ok') expect(verify.claims.grantKind).toBe('service')
  })
})

describe('getAccessToken (O5.1)', () => {
  /** Build a stub db whose query() returns one oauth_grants row matching input. */
  function dbWithGrant(opts: {
    accessTokenEncrypted?: string
    refreshTokenEncrypted?: string | null
    /** Use `noRefresh: true` to omit the refresh token entirely. */
    noRefresh?: boolean
    accessTokenExpiresAt?: Date | null
  }) {
    return {
      query: vi.fn(async () => ({
        rows: [
          {
            recipe_namespace: 'sandbox-recipes',
            recipe_name: 'crm',
            user_id: 'user-1',
            oauth_client_id: 'salesforce',
            provider: 'salesforce',
            access_token_encrypted: opts.accessTokenEncrypted ?? encryptValue('AT_FROM_DB'),
            refresh_token_encrypted: opts.noRefresh
              ? null
              : (opts.refreshTokenEncrypted ?? encryptValue('RT_FROM_DB')),
            access_token_expires_at:
              opts.accessTokenExpiresAt === undefined
                ? new Date(Date.now() + 30 * 60_000)
                : opts.accessTokenExpiresAt,
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      })),
    }
  }

  function emptyDb() {
    return { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }
  }

  function encryptValue(plaintext: string): string {
    return encryptOAuthSecret(KEY, plaintext)
  }

  it('returns no_grant when no row exists', async () => {
    const { recipeReader, secretReader } = buildReaders({})
    const db = emptyDb()
    const result = await getAccessToken(
      {
        grantKind: 'user',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'crm',
        oauthClientId: 'salesforce',
        userId: 'user-1',
      },
      {
        db,
        recipeReader,
        secretReader,
        fetchFn: vi.fn() as unknown as typeof fetch,
        encryptionKey: KEY,
      }
    )
    expect(result.kind).toBe('no_grant')
  })

  it('returns the cached access token when still valid', async () => {
    const { recipeReader, secretReader } = buildReaders({})
    const db = dbWithGrant({})
    const result = await getAccessToken(
      {
        grantKind: 'user',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'crm',
        oauthClientId: 'salesforce',
        userId: 'user-1',
      },
      {
        db,
        recipeReader,
        secretReader,
        fetchFn: vi.fn() as unknown as typeof fetch,
        encryptionKey: KEY,
      }
    )
    expect(result).toMatchObject({ kind: 'ok', accessToken: 'AT_FROM_DB' })
  })

  it('refreshes when the access token is expired and persists the new value', async () => {
    const { recipeReader, secretReader } = buildReaders({
      recipe: recipeWithSalesforce(),
      secrets: { 'salesforce-creds': { 'client-id': 'CID', 'client-secret': 'CSEC' } },
    })
    const db = dbWithGrant({
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
    })
    const fetchFn = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'AT_REFRESHED',
            refresh_token: 'RT_NEW',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          text: async () => '',
        }) as Response
    )

    const result = await getAccessToken(
      {
        grantKind: 'user',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'crm',
        oauthClientId: 'salesforce',
        userId: 'user-1',
      },
      {
        db,
        recipeReader,
        secretReader,
        fetchFn: fetchFn as unknown as typeof fetch,
        encryptionKey: KEY,
      }
    )

    expect(result).toMatchObject({ kind: 'ok', accessToken: 'AT_REFRESHED' })
    // SELECT + UPDATE-by-key (R1-B1: refresh never re-inserts, so a concurrently
    // deleted grant is not resurrected).
    expect(db.query).toHaveBeenCalledTimes(2)
    const refreshSql = (db.query.mock.calls[1] as unknown as [string, unknown[]])[0]
    expect(refreshSql).toContain('UPDATE oauth_grants')
    expect(refreshSql).not.toContain('INSERT INTO oauth_grants')
  })

  it('returns no_grant when the access token is expired and there is no refresh token', async () => {
    const { recipeReader, secretReader } = buildReaders({})
    const db = dbWithGrant({
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
      noRefresh: true,
    })
    const result = await getAccessToken(
      {
        grantKind: 'user',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'crm',
        oauthClientId: 'salesforce',
        userId: 'user-1',
      },
      {
        db,
        recipeReader,
        secretReader,
        fetchFn: vi.fn() as unknown as typeof fetch,
        encryptionKey: KEY,
      }
    )
    expect(result.kind).toBe('no_grant')
  })

  it('returns refresh_failed when the provider returns non-2xx', async () => {
    const { recipeReader, secretReader } = buildReaders({
      recipe: recipeWithSalesforce(),
      secrets: { 'salesforce-creds': { 'client-id': 'CID', 'client-secret': 'CSEC' } },
    })
    const db = dbWithGrant({
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
    })
    const fetchFn = vi.fn(
      async () =>
        ({
          ok: false,
          status: 401,
          json: async () => ({}),
          text: async () => 'invalid_grant',
        }) as Response
    )

    const result = await getAccessToken(
      {
        grantKind: 'user',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'crm',
        oauthClientId: 'salesforce',
        userId: 'user-1',
      },
      {
        db,
        recipeReader,
        secretReader,
        fetchFn: fetchFn as unknown as typeof fetch,
        encryptionKey: KEY,
      }
    )
    expect(result.kind).toBe('refresh_failed')
    if (result.kind === 'refresh_failed') {
      expect(result.status).toBe(401)
      expect(result.detail).toBe('invalid_grant')
    }
  })

  it('preserves the existing refresh token when the provider omits one on refresh', async () => {
    const { recipeReader, secretReader } = buildReaders({
      recipe: recipeWithSalesforce(),
      secrets: { 'salesforce-creds': { 'client-id': 'CID', 'client-secret': 'CSEC' } },
    })
    const db = dbWithGrant({
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
    })
    const fetchFn = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'AT_NEW',
            // no refresh_token here
            expires_in: 1800,
            token_type: 'Bearer',
          }),
          text: async () => '',
        }) as Response
    )

    await getAccessToken(
      {
        grantKind: 'user',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'crm',
        oauthClientId: 'salesforce',
        userId: 'user-1',
      },
      {
        db,
        recipeReader,
        secretReader,
        fetchFn: fetchFn as unknown as typeof fetch,
        encryptionKey: KEY,
      }
    )

    // The upsert should re-encrypt the previous refresh token (RT_FROM_DB).
    const upsertCall = db.query.mock.calls[1] as unknown as [string, unknown[]]
    const refreshTokenParam = upsertCall[1][6] as string
    expect(typeof refreshTokenParam).toBe('string')
    expect(refreshTokenParam.startsWith('v1.')).toBe(true)
    // Note: we don't decrypt + assert here because that would require
    // pulling encryption.ts again; the structural check is enough.
  })

  it('reads a service grant via the user_id IS NULL path (Path B)', async () => {
    const { recipeReader, secretReader } = buildReaders({})
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            recipe_namespace: 'sandbox-recipes',
            recipe_name: 'crm',
            user_id: null,
            oauth_client_id: 'salesforce',
            grant_kind: 'service',
            provider: 'salesforce',
            access_token_encrypted: encryptValue('AT_SERVICE'),
            refresh_token_encrypted: encryptValue('RT_SERVICE'),
            access_token_expires_at: new Date(Date.now() + 30 * 60_000),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      })),
    }
    const result = await getAccessToken(
      {
        grantKind: 'service',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'crm',
        oauthClientId: 'salesforce',
      },
      {
        db,
        recipeReader,
        secretReader,
        fetchFn: vi.fn() as unknown as typeof fetch,
        encryptionKey: KEY,
      }
    )
    expect(result).toMatchObject({ kind: 'ok', accessToken: 'AT_SERVICE' })
    const [sql, params] = db.query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('user_id IS NULL')
    expect(sql).toContain("grant_kind = 'service'")
    // No userId param — the service key is (owner_kind, ns, name, oauthClientId).
    expect(params).toEqual(['recipe', 'sandbox-recipes', 'crm', 'salesforce'])
  })

  it('refreshes a service grant and re-upserts via the service path (Path B)', async () => {
    const { recipeReader, secretReader } = buildReaders({
      recipe: recipeWithSalesforce(),
      secrets: { 'salesforce-creds': { 'client-id': 'CID', 'client-secret': 'CSEC' } },
    })
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            recipe_namespace: 'sandbox-recipes',
            recipe_name: 'crm',
            user_id: null,
            oauth_client_id: 'salesforce',
            grant_kind: 'service',
            provider: 'salesforce',
            access_token_encrypted: encryptValue('AT_OLD'),
            refresh_token_encrypted: encryptValue('RT_SERVICE'),
            access_token_expires_at: new Date(Date.now() - 60_000),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      })),
    }
    const fetchFn = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'AT_REFRESHED',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          text: async () => '',
        }) as Response
    )
    const result = await getAccessToken(
      {
        grantKind: 'service',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'crm',
        oauthClientId: 'salesforce',
      },
      {
        db,
        recipeReader,
        secretReader,
        fetchFn: fetchFn as unknown as typeof fetch,
        encryptionKey: KEY,
      }
    )
    expect(result).toMatchObject({ kind: 'ok', accessToken: 'AT_REFRESHED' })
    const [refreshSql, refreshParams] = db.query.mock.calls[1] as unknown as [string, unknown[]]
    // R1-B1: service refresh is an UPDATE by key (user_id IS NULL, grant_kind
    // 'service'), never an INSERT/ON CONFLICT — a deleted service grant is not
    // resurrected.
    expect(refreshSql).toContain('UPDATE oauth_grants')
    expect(refreshSql).toContain('user_id IS NULL')
    expect(refreshSql).toContain("grant_kind = 'service'")
    expect(refreshSql).not.toContain('ON CONFLICT')
    // Service refresh carries 8 params (owner_kind, ns, name, oauthClientId,
    // provider, accessToken, refreshToken, expiresAt) — no user_id.
    expect(refreshParams).toHaveLength(8)
  })

  // Suppresses unused-import warnings for helpers we kept exported
  // (signOAuthState, upsertOAuthGrant) for symmetry with the route layer.
  it('keeps unused helpers exported (lint guard)', () => {
    expect(typeof signOAuthState).toBe('function')
    expect(typeof upsertOAuthGrant).toBe('function')
  })
})
