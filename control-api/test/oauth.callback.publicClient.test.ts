import { describe, expect, it, vi } from 'vitest'
import {
  type CallbackDeps,
  type RecipeReader,
  type RecipeWithOAuthClients,
  type SecretReader,
  handleOAuthCallback,
} from '../src/oauth/callback.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { signOAuthState } from '../src/oauth/state.js'

/**
 * T5 (E-19.2): a PUBLIC OAuth client (no clientSecretRef) exchanges the auth code
 * WITHOUT reading a client_secret Secret and WITHOUT sending `client_secret` in
 * the token POST. The state/decl fixtures are derived from the real minter
 * (`signOAuthState`) and the real reader shape, not hand-built protocol bytes.
 */
const STATE_SECRET = 'test-state-hmac-secret-32-bytes-padding'
const ENCRYPTION_KEY = deriveOAuthEncryptionKey(
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
)
const REDIRECT_URI = 'https://control.example.com/api/v1/oauth-callback/salesforce'
const USER_ID = 'user-uuid-1'

// A recipe whose salesforce oauthClient declares NO clientSecretRef (public).
function recipeWithPublicSalesforce(): RecipeWithOAuthClients {
  return {
    metadata: { name: 'crm', namespace: 'sandbox-recipes' },
    spec: {
      oauthClients: [
        {
          id: 'salesforce',
          provider: 'salesforce',
          clientIdRef: { name: 'salesforce-creds', key: 'client-id' },
          // no clientSecretRef → public client
          scopes: ['api'],
        },
      ],
    },
  }
}

it('public client: exchanges without reading or sending a client_secret', async () => {
  const db = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }

  const recipeReader: RecipeReader = { read: vi.fn(async () => recipeWithPublicSalesforce()) }

  // Only the client-id Secret exists; count reads to prove the secret read is skipped.
  const secretReader: SecretReader = {
    read: vi.fn(async (name: string) =>
      name === 'salesforce-creds' ? { 'client-id': 'CID' } : {}
    ),
  }

  let capturedBody = ''
  const fetchFn = vi.fn(async (_url: string, init: { body?: string }) => {
    capturedBody = init.body ?? ''
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'AT',
        refresh_token: 'RT',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
      text: async () => '',
    } as Response
  })

  const deps: CallbackDeps = {
    db: db as unknown as CallbackDeps['db'],
    recipeReader,
    secretReader,
    fetchFn: fetchFn as unknown as typeof fetch,
    stateSecret: STATE_SECRET,
    encryptionKey: ENCRYPTION_KEY,
  }

  const state = signOAuthState(STATE_SECRET, {
    recipeNamespace: 'sandbox-recipes',
    recipeName: 'crm',
    userId: USER_ID,
    oauthClientId: 'salesforce',
    grantKind: 'user',
    background: false,
  })

  const result = await handleOAuthCallback(
    { oauthClientId: 'salesforce', code: 'AUTH_CODE', state, redirectUri: REDIRECT_URI },
    deps
  )

  expect(result.kind).toBe('ok')
  // Only the client-id Secret is read — the second (client_secret) read is skipped.
  expect(secretReader.read).toHaveBeenCalledTimes(1)
  expect(secretReader.read).toHaveBeenCalledWith('salesforce-creds', 'sandbox-recipes')
  // The token POST carries no client_secret.
  expect(capturedBody).not.toContain('client_secret')
  expect(capturedBody).toContain('grant_type=authorization_code')
  expect(capturedBody).toContain('client_id=CID')
})

describe('confidential client (control) still reads + sends client_secret', () => {
  it('reads both Secrets and sends client_secret when clientSecretRef is present', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }
    const recipeReader: RecipeReader = {
      read: vi.fn(
        async (): Promise<RecipeWithOAuthClients> => ({
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
        })
      ),
    }
    const secretReader: SecretReader = {
      read: vi.fn(async () => ({ 'client-id': 'CID', 'client-secret': 'CSEC' })),
    }
    let capturedBody = ''
    const fetchFn = vi.fn(async (_url: string, init: { body?: string }) => {
      capturedBody = init.body ?? ''
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'AT', token_type: 'Bearer' }),
        text: async () => '',
      } as Response
    })
    const deps: CallbackDeps = {
      db: db as unknown as CallbackDeps['db'],
      recipeReader,
      secretReader,
      fetchFn: fetchFn as unknown as typeof fetch,
      stateSecret: STATE_SECRET,
      encryptionKey: ENCRYPTION_KEY,
    }
    const state = signOAuthState(STATE_SECRET, {
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'crm',
      userId: USER_ID,
      oauthClientId: 'salesforce',
      grantKind: 'user',
      background: false,
    })
    const result = await handleOAuthCallback(
      { oauthClientId: 'salesforce', code: 'AUTH_CODE', state, redirectUri: REDIRECT_URI },
      deps
    )
    expect(result.kind).toBe('ok')
    expect(secretReader.read).toHaveBeenCalledTimes(2)
    expect(capturedBody).toContain('client_secret=CSEC')
  })
})
