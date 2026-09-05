import { describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { buildAuthorizeUrl } from '../src/oauth/authorizeUrlHelper.js'
import {
  type CallbackDeps,
  type RecipeReader,
  type RecipeWithOAuthClients,
  type SecretReader,
  handleOAuthCallback,
} from '../src/oauth/callback.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { computeCodeChallengeS256, deriveCodeVerifier } from '../src/oauth/pkce.js'
import type { OAuthProvider } from '../src/oauth/providers.js'

const STATE_SECRET = 'test-state-hmac-secret-32-bytes-padding'
const ENCRYPTION_KEY = deriveOAuthEncryptionKey(
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
)

function base64urlSha256(input: string): string {
  return createHash('sha256').update(input).digest('base64url')
}

// ─── T2: property tests on the pure PKCE helpers ────────────────────────

describe('deriveCodeVerifier (PKCE, T2 properties)', () => {
  it('is deterministic: same secret + state ⇒ same verifier', () => {
    for (let i = 0; i < 2000; i++) {
      const state = randomBytes(24).toString('base64url')
      expect(deriveCodeVerifier(STATE_SECRET, state)).toBe(deriveCodeVerifier(STATE_SECRET, state))
    }
  })

  it('different state ⇒ different verifier (no collisions over a large sample)', () => {
    const seen = new Map<string, string>()
    for (let i = 0; i < 5000; i++) {
      const state = `v1.${randomBytes(24).toString('base64url')}.sig`
      const verifier = deriveCodeVerifier(STATE_SECRET, state)
      const prior = seen.get(verifier)
      // If two distinct states ever map to the same verifier, that's a break.
      if (prior !== undefined) expect(prior).toBe(state)
      seen.set(verifier, state)
    }
  })

  it('a different secret ⇒ different verifier for the same state', () => {
    const state = 'v1.payload.sig'
    expect(deriveCodeVerifier(STATE_SECRET, state)).not.toBe(
      deriveCodeVerifier(`${STATE_SECRET}-other`, state)
    )
  })

  it('verifier is always 43 chars and in the RFC 7636 base64url charset', () => {
    for (let i = 0; i < 2000; i++) {
      const state = randomBytes(1 + (i % 40)).toString('base64url')
      const verifier = deriveCodeVerifier(STATE_SECRET, state)
      expect(verifier).toHaveLength(43)
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    }
  })
})

describe('computeCodeChallengeS256 (PKCE)', () => {
  // RFC 7636 Appendix B.1 test vector — anchors the S256 transform.
  it('matches the RFC 7636 Appendix B.1 vector', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(computeCodeChallengeS256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('agrees with base64url(sha256(verifier)) for arbitrary verifiers', () => {
    for (let i = 0; i < 1000; i++) {
      const verifier = deriveCodeVerifier(STATE_SECRET, randomBytes(20).toString('base64url'))
      expect(computeCodeChallengeS256(verifier)).toBe(base64urlSha256(verifier))
    }
  })
})

// ─── T1: load-bearing round-trip through the REAL authorize + callback ──
//
// Produce a state via the real signOAuthState (inside buildAuthorizeUrl), pull
// the code_challenge off the authorize URL, run the SAME state through the real
// callback with a spy on the token request, and assert
// base64url(sha256(captured_verifier)) === extracted_challenge. The challenge is
// never hand-written — it's whatever the authorize URL emitted.

interface StubDb {
  query: ReturnType<typeof vi.fn>
}

function recipeFor(provider: OAuthProvider): RecipeWithOAuthClients {
  return {
    metadata: { name: 'connectors', namespace: 'sandbox-recipes' },
    spec: {
      oauthClients: [
        {
          id: 'oauth1',
          provider,
          clientIdRef: { name: 'creds', key: 'client-id' },
          clientSecretRef: { name: 'creds', key: 'client-secret' },
          scopes: [],
        },
      ],
    },
  }
}

function readers(provider: OAuthProvider): {
  recipeReader: RecipeReader
  secretReader: SecretReader
} {
  return {
    recipeReader: { read: vi.fn(async () => recipeFor(provider)) },
    secretReader: {
      read: vi.fn(async () => ({ 'client-id': 'CID', 'client-secret': 'CSEC' })),
    },
  }
}

/** Extract the token-exchange `code_verifier` from a captured fetch request. */
function extractCodeVerifier(body: string, contentType: string | undefined): string | undefined {
  if (contentType?.includes('application/json')) {
    return JSON.parse(body).code_verifier
  }
  return new URLSearchParams(body).get('code_verifier') ?? undefined
}

async function roundTrip(provider: OAuthProvider): Promise<{
  challenge: string | null
  verifier: string | undefined
}> {
  const { recipeReader, secretReader } = readers(provider)

  const authResult = await buildAuthorizeUrl(
    {
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'connectors',
      oauthClientId: 'oauth1',
      userId: 'user-1',
      grantKind: 'user',
      redirectUri: 'https://control.example.com/api/v1/oauth-callback/oauth1',
    },
    { recipeReader, secretReader, stateSecret: STATE_SECRET }
  )
  expect(authResult.kind).toBe('ok')
  if (authResult.kind !== 'ok') throw new Error('authorize failed')

  const authUrl = new URL(authResult.authorizeUrl)
  const state = authUrl.searchParams.get('state')
  const challenge = authUrl.searchParams.get('code_challenge')
  expect(state).toBeTruthy()
  expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')

  // Spy on the token request; capture the outgoing verifier.
  let capturedVerifier: string | undefined
  const db: StubDb = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }
  const fetchFn = vi.fn(
    async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      capturedVerifier = extractCodeVerifier(init.body, init.headers['content-type'])
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
    }
  )

  const deps: CallbackDeps = {
    db: db as unknown as CallbackDeps['db'],
    recipeReader,
    secretReader,
    fetchFn: fetchFn as unknown as typeof fetch,
    stateSecret: STATE_SECRET,
    encryptionKey: ENCRYPTION_KEY,
  }

  const cbResult = await handleOAuthCallback(
    {
      oauthClientId: 'oauth1',
      code: 'AUTH_CODE',
      // The EXACT round-tripped state string.
      state: state as string,
      redirectUri: 'https://control.example.com/api/v1/oauth-callback/oauth1',
    },
    deps
  )
  expect(cbResult.kind).toBe('ok')
  expect(fetchFn).toHaveBeenCalledTimes(1)

  return { challenge, verifier: capturedVerifier }
}

describe('PKCE round-trip (T1, load-bearing) — authorize challenge binds to callback verifier', () => {
  for (const provider of ['monday', 'vercel'] as OAuthProvider[]) {
    it(`${provider}: sha256(callback verifier) === authorize code_challenge`, async () => {
      const { challenge, verifier } = await roundTrip(provider)
      expect(challenge).toBeTruthy()
      expect(verifier).toBeTruthy()
      expect(base64urlSha256(verifier as string)).toBe(challenge)
    })
  }
})
