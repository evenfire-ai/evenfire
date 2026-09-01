import { describe, expect, it, vi } from 'vitest'
import {
  type CallbackDeps,
  type CallbackInput,
  RecipeNotFoundError,
  type RecipeReader,
  type RecipeWithOAuthClients,
  SecretNotFoundError,
  type SecretReader,
  handleOAuthCallback,
} from '../src/oauth/callback.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { signOAuthState } from '../src/oauth/state.js'

const STATE_SECRET = 'test-state-hmac-secret-32-bytes-padding'
const ENCRYPTION_KEY = deriveOAuthEncryptionKey(
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
)
const REDIRECT_URI = 'https://control.example.com/api/v1/oauth-callback/salesforce'
const USER_ID = 'user-uuid-1'

function buildInput(
  overrides: Partial<CallbackInput> = {},
  grantKind: 'user' | 'service' = 'user'
): CallbackInput {
  return {
    oauthClientId: 'salesforce',
    code: 'AUTH_CODE_FROM_PROVIDER',
    state: signOAuthState(STATE_SECRET, {
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'crm',
      userId: USER_ID,
      oauthClientId: 'salesforce',
      grantKind,
      background: false,
    }),
    redirectUri: REDIRECT_URI,
    ...overrides,
  }
}

function tamperStateSignature(state: string): string {
  const parts = state.split('.')
  const signature = parts[2] ?? ''
  const replacement = signature.startsWith('A') ? 'B' : 'A'
  return `${parts[0]}.${parts[1]}.${replacement}${signature.slice(1)}`
}

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
          scopes: ['api'],
        },
      ],
    },
  }
}

interface StubDb {
  query: ReturnType<typeof vi.fn>
}

function buildDeps(opts: {
  recipe?: RecipeWithOAuthClients | null
  recipeError?: unknown
  secrets?: Record<string, Record<string, string>>
  secretError?: unknown
  fetchResponse?: { ok: boolean; status: number; body: unknown; isJson?: boolean }
  fetchError?: unknown
}): { deps: CallbackDeps; db: StubDb } {
  const db: StubDb = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }

  const recipeReader: RecipeReader = {
    read: vi.fn(async () => {
      if (opts.recipeError) throw opts.recipeError
      return opts.recipe ?? null
    }),
  }

  const secretReader: SecretReader = {
    read: vi.fn(async (name: string) => {
      if (opts.secretError) throw opts.secretError
      return opts.secrets?.[name] ?? {}
    }),
  }

  const fetchFn = vi.fn(async () => {
    if (opts.fetchError) throw opts.fetchError
    const r = opts.fetchResponse ?? {
      ok: true,
      status: 200,
      body: {
        access_token: 'AT',
        refresh_token: 'RT',
        expires_in: 3600,
        token_type: 'Bearer',
      },
      isJson: true,
    }
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
      text: async () => (r.isJson === false ? String(r.body) : JSON.stringify(r.body)),
    } as Response
  })

  return {
    deps: {
      db: db as unknown as CallbackDeps['db'],
      recipeReader,
      secretReader,
      fetchFn: fetchFn as unknown as typeof fetch,
      stateSecret: STATE_SECRET,
      encryptionKey: ENCRYPTION_KEY,
    },
    db,
  }
}

describe('handleOAuthCallback (O4.1)', () => {
  it('runs the happy path: verifies state, exchanges code, encrypts + stores tokens', async () => {
    const { deps, db } = buildDeps({
      recipe: recipeWithSalesforce(),
      secrets: {
        'salesforce-creds': { 'client-id': 'CID', 'client-secret': 'CSEC' },
      },
    })

    const result = await handleOAuthCallback(buildInput(), deps)

    expect(result).toEqual({
      kind: 'ok',
      provider: 'salesforce',
      userId: USER_ID,
      grantKind: 'user',
      backgroundRequested: false,
      backgroundEnabled: false,
    })
    expect(db.query).toHaveBeenCalledTimes(1)
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO oauth_grants')
    // owner_kind leads the param list (recipe domain for the recipe callback).
    expect(params[0]).toBe('recipe')
    expect(params[1]).toBe('sandbox-recipes')
    expect(params[2]).toBe('crm')
    expect(params[3]).toBe(USER_ID)
    expect(params[4]).toBe('salesforce')
    expect(params[5]).toBe('salesforce')
    // params[6] is the encrypted access token; should be a non-empty string.
    expect(typeof params[6]).toBe('string')
    expect((params[6] as string).startsWith('v1.')).toBe(true)
    // params[7] is the encrypted refresh token; should also be encrypted.
    expect(typeof params[7]).toBe('string')
    expect((params[7] as string).startsWith('v1.')).toBe(true)
  })

  it('stores a service grant with no user_id when state.grantKind is service', async () => {
    const { deps, db } = buildDeps({
      recipe: recipeWithSalesforce(),
      secrets: {
        'salesforce-creds': { 'client-id': 'CID', 'client-secret': 'CSEC' },
      },
    })

    const result = await handleOAuthCallback(buildInput({}, 'service'), deps)

    // userId in the result is the initiating admin (audit only); the grant
    // itself is recipe-owned.
    expect(result).toEqual({
      kind: 'ok',
      provider: 'salesforce',
      userId: USER_ID,
      grantKind: 'service',
      backgroundRequested: false,
      backgroundEnabled: false,
    })
    expect(db.query).toHaveBeenCalledTimes(1)
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain(
      "ON CONFLICT (recipe_namespace, recipe_name, oauth_client_id) WHERE grant_kind = 'service'"
    )
    // Service INSERT carries 8 params (no user_id): owner_kind, ns, name,
    // oauthClientId, provider, accessToken, refreshToken, expiresAt.
    expect(params).toHaveLength(8)
    expect(params[0]).toBe('recipe')
    expect(params[1]).toBe('sandbox-recipes')
    expect(params[2]).toBe('crm')
    expect(params[3]).toBe('salesforce') // oauthClientId — NOT a userId
  })

  it('rejects a tampered state (signature mismatch)', async () => {
    const { deps } = buildDeps({ recipe: recipeWithSalesforce() })
    const tampered = tamperStateSignature(buildInput().state)
    const result = await handleOAuthCallback(buildInput({ state: tampered }), deps)
    expect(result.kind).toBe('invalid_state')
  })

  it('rejects when the path oauthClientId does not match the signed state', async () => {
    const { deps } = buildDeps({ recipe: recipeWithSalesforce() })
    // State signed for salesforce; the callback path claims a different client.
    const result = await handleOAuthCallback(buildInput({ oauthClientId: 'attacker-client' }), deps)
    expect(result.kind).toBe('invalid_state')
  })

  it('returns recipe_not_found when the K8s read returns null', async () => {
    const { deps } = buildDeps({ recipe: null })
    const result = await handleOAuthCallback(buildInput(), deps)
    expect(result.kind).toBe('recipe_not_found')
  })

  it('returns recipe_not_found when the K8s reader throws RecipeNotFoundError', async () => {
    const { deps } = buildDeps({ recipeError: new RecipeNotFoundError('gone') })
    const result = await handleOAuthCallback(buildInput(), deps)
    expect(result.kind).toBe('recipe_not_found')
  })

  it('returns unknown_oauth_client when the recipe has no matching oauthClient id', async () => {
    const { deps } = buildDeps({
      recipe: {
        spec: { oauthClients: [{ ...recipeWithSalesforce().spec!.oauthClients![0], id: 'slack' }] },
      },
      secrets: { 'salesforce-creds': { 'client-id': 'X', 'client-secret': 'Y' } },
    })
    const result = await handleOAuthCallback(buildInput(), deps)
    expect(result.kind).toBe('unknown_oauth_client')
  })

  it('returns secret_missing when the K8s Secret is absent', async () => {
    const { deps } = buildDeps({
      recipe: recipeWithSalesforce(),
      secretError: new SecretNotFoundError('not found'),
    })
    const result = await handleOAuthCallback(buildInput(), deps)
    expect(result.kind).toBe('secret_missing')
  })

  it('returns secret_missing when the Secret exists but is missing the key', async () => {
    const { deps } = buildDeps({
      recipe: recipeWithSalesforce(),
      // Secret exists but doesn't have the requested key.
      secrets: { 'salesforce-creds': { 'other-key': 'X' } },
    })
    const result = await handleOAuthCallback(buildInput(), deps)
    expect(result.kind).toBe('secret_missing')
  })

  it('returns provider_token_exchange_failed when the provider returns non-2xx', async () => {
    const { deps } = buildDeps({
      recipe: recipeWithSalesforce(),
      secrets: { 'salesforce-creds': { 'client-id': 'CID', 'client-secret': 'CSEC' } },
      fetchResponse: { ok: false, status: 401, body: 'invalid_grant', isJson: false },
    })
    const result = await handleOAuthCallback(buildInput(), deps)
    expect(result.kind).toBe('provider_token_exchange_failed')
    if (result.kind === 'provider_token_exchange_failed') {
      expect(result.status).toBe(401)
      expect(result.body).toBe('invalid_grant')
    }
  })

  it('returns provider_response_invalid when the response cannot be parsed', async () => {
    const { deps } = buildDeps({
      recipe: recipeWithSalesforce(),
      secrets: { 'salesforce-creds': { 'client-id': 'CID', 'client-secret': 'CSEC' } },
      // No access_token in the response → adapter throws.
      fetchResponse: { ok: true, status: 200, body: { token_type: 'Bearer' } },
    })
    const result = await handleOAuthCallback(buildInput(), deps)
    expect(result.kind).toBe('provider_response_invalid')
  })

  it('returns unsupported_provider when the recipe declares an unknown provider', async () => {
    const { deps } = buildDeps({
      recipe: {
        spec: {
          oauthClients: [
            {
              id: 'salesforce',
              provider: 'github', // not in the known set
              clientIdRef: { name: 's', key: 'i' },
              clientSecretRef: { name: 's', key: 's' },
            },
          ],
        },
      },
      secrets: { s: { i: 'X', s: 'Y' } },
    })
    const result = await handleOAuthCallback(buildInput(), deps)
    expect(result.kind).toBe('unsupported_provider')
  })
})
