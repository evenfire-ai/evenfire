import { describe, expect, it, vi } from 'vitest'
import {
  type RecipeReader,
  type RecipeWithOAuthClients,
  type SecretReader,
} from '../src/oauth/callback.js'
import { deriveOAuthEncryptionKey, encryptOAuthSecret } from '../src/oauth/encryption.js'
import { getAccessToken } from '../src/oauth/tokenHelper.js'

// R1-B1 — refresh↔DELETE race. A disconnect (DELETE) can land between the token
// read (`getOAuthGrant`) and the refresh write. Refresh MUST NOT resurrect the
// deleted row: an UPDATE-by-key touches 0 rows and the broker returns no_grant.
//
// This drives the stable public API `getAccessToken` (which exists at the parent
// sha) so the T3 check exercises the behavior, not a missing symbol. At parent
// (314dff6a) the refresh persists via `INSERT … ON CONFLICT DO UPDATE`, which
// recreates the deleted grant and returns `{ kind: 'ok' }` — so both assertions
// below fail there.

const KEY = deriveOAuthEncryptionKey(
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
)

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

const recipeReader: RecipeReader = { read: async () => recipeWithSalesforce() }
const secretReader: SecretReader = {
  read: async () => ({ 'client-id': 'CID', 'client-secret': 'CSEC' }),
}

const okRefreshFetch = vi.fn(
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

/**
 * A db whose SELECT returns a STALE user grant (with a refresh token), but whose
 * refresh WRITE reports 0 affected rows — the grant was DELETEd concurrently.
 * Records every SQL string so the test can assert no INSERT was issued.
 */
function dbDeletedDuringRefresh() {
  const staleRow = {
    owner_kind: 'mcpserver',
    recipe_namespace: 'sandbox-recipes',
    recipe_name: 'gdrive',
    user_id: 'user-1',
    context_id: null,
    bootstrapped_by_user_id: null,
    oauth_client_id: 'salesforce',
    grant_kind: 'user',
    provider: 'salesforce',
    access_token_encrypted: encryptOAuthSecret(KEY, 'AT_STALE'),
    refresh_token_encrypted: encryptOAuthSecret(KEY, 'RT_STALE'),
    access_token_expires_at: new Date(Date.now() - 60_000), // expired → refresh
    updated_at: new Date(),
    background: false,
  }
  const sqls: string[] = []
  const query = vi.fn(async (text: string) => {
    sqls.push(text)
    if (text.trimStart().startsWith('SELECT')) {
      return { rows: [staleRow], rowCount: 1 }
    }
    // The concurrent DELETE already removed the row: the refresh write matches
    // nothing. (At parent, an INSERT … ON CONFLICT would instead re-create it.)
    return { rows: [], rowCount: 0 }
  })
  return { db: { query }, sqls }
}

describe('getAccessToken — refresh↔DELETE race (R1-B1)', () => {
  it('returns no_grant and does NOT resurrect a grant deleted during refresh', async () => {
    const { db, sqls } = dbDeletedDuringRefresh()

    const result = await getAccessToken(
      {
        grantKind: 'user',
        ownerKind: 'mcpserver',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'gdrive',
        userId: 'user-1',
        oauthClientId: 'salesforce',
      },
      {
        db,
        recipeReader,
        secretReader,
        fetchFn: okRefreshFetch as unknown as typeof fetch,
        encryptionKey: KEY,
      }
    )

    // The row is gone: broker must say "needs reauth", never mint against it.
    expect(result.kind).toBe('no_grant')
    // And crucially, the write path must be an UPDATE — never an INSERT that
    // would recreate the disconnected grant.
    expect(sqls.some(s => s.includes('INSERT INTO oauth_grants'))).toBe(false)
    expect(sqls.some(s => s.includes('UPDATE oauth_grants'))).toBe(true)
  })
})
