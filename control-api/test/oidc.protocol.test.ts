import { describe, expect, it, vi } from 'vitest'
import { type KeyObject, constants, createHash, createSign, generateKeyPairSync } from 'node:crypto'
import type { DbClient } from '../src/db.js'
import type { PinnedFetchOptions, PinnedTransport } from '../src/http/pinnedFetch.js'
import { loadOidcProviderConfiguration } from '../src/oidc/configuration.js'
import {
  OidcProtocolEngine,
  OidcProviderIncompatibleError,
  OidcProviderUnavailableError,
  isVerifiedOidcIdentityProof,
  parseOidcCallbackUrl,
} from '../src/oidc/protocol.js'

const oidcTestNetwork = vi.hoisted(() => ({
  pinnedFetch: vi.fn(),
  resolveEndpoint: vi.fn(),
}))

vi.mock('../src/http/pinnedFetch.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/http/pinnedFetch.js')>()
  return { ...actual, pinnedFetch: oidcTestNetwork.pinnedFetch }
})

vi.mock('../src/http/validateMcpServerSpec.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/http/validateMcpServerSpec.js')>()
  return { ...actual, resolveValidatedOAuthEndpoint: oidcTestNetwork.resolveEndpoint }
})

const ENCRYPTION_KEY = 'ab'.repeat(32)
const CLIENT_SECRET = 'fixture-client-secret-never-returned'
const CLIENT_ID = 'fixture-client'
const GENERIC_ISSUER = 'https://oidc.example.test/tenant'
const GENERIC_REDIRECT = 'https://api.example.test/api/v1/oidc/callback'
const PUBLIC_IP = '93.184.216.34'

type StoredAttempt = {
  id: string
  stateHash: string
  registrationId: string
  configurationGeneration: string
  issuer: string
  clientId: string
  redirectUri: string
  responseMode: string
  verifierEncrypted: string | null
  nonceEncrypted: string | null
  status: string
  expiresAt: Date
  createdAt: Date
}

class MemoryAttemptDb {
  readonly rows = new Map<string, StoredAttempt>()
  readonly statements: string[] = []

  readonly client: Pick<DbClient, 'query'> = {
    query: async (sql: string, values: unknown[] = []) => {
      this.statements.push(sql)
      if (
        sql.startsWith('DELETE FROM oidc_protocol_attempts') ||
        sql.startsWith('WITH expired_attempts AS')
      ) {
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('INSERT INTO oidc_protocol_attempts')) {
        const row: StoredAttempt = {
          id: String(values[0]),
          stateHash: String(values[1]),
          registrationId: String(values[2]),
          configurationGeneration: String(values[3]),
          issuer: String(values[4]),
          clientId: String(values[5]),
          redirectUri: String(values[6]),
          responseMode: String(values[7]),
          verifierEncrypted: String(values[9]),
          nonceEncrypted: String(values[10]),
          status: 'pending',
          expiresAt: new Date(values[11] as Date),
          createdAt: new Date(),
        }
        this.rows.set(row.id, row)
        return { rows: [{ id: row.id, expires_at: row.expiresAt }], rowCount: 1 }
      }
      if (sql.includes('WITH candidate AS')) {
        const row = [...this.rows.values()].find(
          candidate =>
            candidate.stateHash === values[0] &&
            candidate.registrationId === values[1] &&
            candidate.configurationGeneration === values[2] &&
            candidate.issuer === values[3] &&
            candidate.clientId === values[4] &&
            candidate.redirectUri === values[5] &&
            candidate.responseMode === values[6] &&
            candidate.status === 'pending' &&
            candidate.expiresAt.getTime() > Date.now()
        )
        if (!row) return { rows: [], rowCount: 0 }
        const verifier = row.verifierEncrypted
        const nonce = row.nonceEncrypted
        row.status = 'redeeming'
        row.verifierEncrypted = null
        row.nonceEncrypted = null
        return {
          rows: [
            {
              id: row.id,
              registration_id: row.registrationId,
              configuration_generation: row.configurationGeneration,
              issuer: row.issuer,
              client_id: row.clientId,
              redirect_uri: row.redirectUri,
              response_mode: row.responseMode,
              created_at: row.createdAt,
              expires_at: row.expiresAt,
              pkce_verifier_encrypted: verifier,
              nonce_encrypted: nonce,
            },
          ],
          rowCount: 1,
        }
      }
      if (sql.includes("SET status = 'cancelled'")) {
        const row = [...this.rows.values()].find(candidate => candidate.stateHash === values[0])
        if (!row || row.status !== 'pending') return { rows: [], rowCount: 0 }
        row.status = 'cancelled'
        row.verifierEncrypted = null
        row.nonceEncrypted = null
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('SET status = $2')) {
        const row = this.rows.get(String(values[0]))
        if (!row || row.status !== 'redeeming') return { rows: [], rowCount: 0 }
        row.status = String(values[1])
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unexpected attempt store query: ${sql.slice(0, 60)}`)
    },
  }
}

function providerConfiguration(issuer = GENERIC_ISSUER, clientId = CLIENT_ID) {
  return loadOidcProviderConfiguration(
    {
      CONTROL_API_OIDC_REGISTRATION_ID: 'company-login',
      CONTROL_API_OIDC_DISPLAY_LABEL: 'Company login',
      CONTROL_API_OIDC_ISSUER: issuer,
      CONTROL_API_OIDC_CLIENT_ID: clientId,
      CONTROL_API_OIDC_CLIENT_SECRET: CLIENT_SECRET,
      CONTROL_API_OIDC_CLIENT_AUTH_METHOD: 'client_secret_basic',
      CONTROL_API_OIDC_REDIRECT_URI: GENERIC_REDIRECT,
      CONTROL_API_OIDC_RESPONSE_MODE: 'query',
      CONTROL_API_OIDC_TRUST_GENERATION: 'test-trust-generation',
    },
    ENCRYPTION_KEY
  )!
}

function signIdToken(
  privateKey: KeyObject,
  claims: Record<string, unknown>,
  kid = 'key-1',
  algorithm = 'RS256'
): string {
  const header = Buffer.from(JSON.stringify({ alg: algorithm, kid, typ: 'JWT' })).toString(
    'base64url'
  )
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const input = `${header}.${payload}`
  const signer = createSign('RSA-SHA256')
  signer.update(input)
  signer.end()
  const signature =
    algorithm === 'PS256'
      ? signer.sign({
          key: privateKey,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
        })
      : signer.sign(privateKey)
  return `${input}.${signature.toString('base64url')}`
}

function jwk(
  publicKey: KeyObject,
  kid: string,
  algorithm: string | null = 'RS256'
): Record<string, unknown> {
  return {
    ...(publicKey.export({ format: 'jwk' }) as JsonWebKey),
    kid,
    use: 'sig',
    ...(algorithm ? { alg: algorithm } : {}),
  }
}

function fixture(
  options: {
    issuer?: string
    authorizationEndpoint?: string
    discoveryStatus?: number
    discoveryRedirect?: string
    jwksUri?: string
    jwksBody?: string
    jwksKeyAlgorithm?: string | null
    idTokenSigningAlgorithms?: string[]
    tokenAlgorithm?: string
    tamperSignature?: boolean
    responseTypesSupported?: unknown
    responseModesSupported?: unknown
    scopesSupported?: unknown
    grantTypesSupported?: unknown
    tokenAuthMethodsSupported?: unknown
    codeChallengeMethodsSupported?: unknown
    issuerBindingCapability?: unknown
    omitOptionalCapabilities?: boolean
    initialKeyBits?: number
    tokenStatus?: number
    tokenTimeout?: boolean
    temporaryTokenEndpointDnsFailure?: boolean
    claims?: (nonce: string) => Record<string, unknown>
    beforeTokenResponse?: (code: string) => Promise<void>
  } = {}
) {
  const issuer = options.issuer ?? GENERIC_ISSUER
  const initialKey = generateKeyPairSync('rsa', {
    modulusLength: options.initialKeyBits ?? 2048,
  })
  let signingKey = { privateKey: initialKey.privateKey, kid: 'key-1' }
  let publicKeys = [
    jwk(
      initialKey.publicKey,
      'key-1',
      options.jwksKeyAlgorithm === undefined ? 'RS256' : options.jwksKeyAlgorithm
    ),
  ]
  let nonce = ''
  let codeChallenge = ''
  let tokenRequests = 0
  let jwksRequests = 0
  const requestedUrls: string[] = []
  let currentClientSecret = CLIENT_SECRET
  const metadata = {
    issuer,
    authorization_endpoint: options.authorizationEndpoint ?? `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: options.jwksUri ?? `${issuer}/keys`,
    ...(options.idTokenSigningAlgorithms
      ? { id_token_signing_alg_values_supported: options.idTokenSigningAlgorithms }
      : {}),
    response_types_supported: options.responseTypesSupported ?? ['code'],
    ...(!options.omitOptionalCapabilities
      ? {
          response_modes_supported: options.responseModesSupported ?? [
            'query',
            'fragment',
            'form_post',
          ],
          grant_types_supported: options.grantTypesSupported ?? ['authorization_code'],
          scopes_supported: options.scopesSupported ?? ['openid', 'profile', 'email'],
          token_endpoint_auth_methods_supported: options.tokenAuthMethodsSupported ?? [
            'client_secret_basic',
          ],
          code_challenge_methods_supported: options.codeChallengeMethodsSupported ?? ['S256'],
        }
      : {}),
    authorization_response_iss_parameter_supported: options.issuerBindingCapability ?? true,
  }
  let tokenStatus = options.tokenStatus
  const transport: PinnedTransport = async input => {
    requestedUrls.push(input.url)
    if (input.url.endsWith('/.well-known/openid-configuration')) {
      return {
        status: options.discoveryRedirect ? 302 : (options.discoveryStatus ?? 200),
        headers: options.discoveryRedirect
          ? { location: options.discoveryRedirect }
          : { 'content-type': 'application/json' },
        bodyText: options.discoveryRedirect ? '' : JSON.stringify(metadata),
      }
    }
    if (input.url === metadata.jwks_uri) {
      jwksRequests += 1
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: options.jwksBody ?? JSON.stringify({ keys: publicKeys }),
      }
    }
    if (input.url === metadata.token_endpoint) {
      tokenRequests += 1
      const body = new URLSearchParams(input.body)
      const code = body.get('code') ?? ''
      const verifier = body.get('code_verifier') ?? ''
      const expectedNonce = nonce
      const expectedCodeChallenge = codeChallenge
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(code).not.toBe('')
      expect(body.get('redirect_uri')).toBe(GENERIC_REDIRECT)
      if (createHash('sha256').update(verifier).digest('base64url') !== expectedCodeChallenge) {
        return {
          status: 400,
          headers: { 'content-type': 'application/json' },
          bodyText: JSON.stringify({ error: 'invalid_grant' }),
        }
      }
      expect(input.headers.authorization).toMatch(/^Basic /)
      const basicCredentials = decodeURIComponent(
        Buffer.from(input.headers.authorization.slice('Basic '.length), 'base64').toString('utf8')
      )
      expect(basicCredentials).toBe(`${CLIENT_ID}:${currentClientSecret}`)
      await options.beforeTokenResponse?.(code)
      if (tokenStatus !== undefined) {
        return {
          status: tokenStatus,
          headers: { 'content-type': 'application/json' },
          bodyText: '{}',
        }
      }
      const now = Math.floor(Date.now() / 1000)
      const claims = options.claims?.(expectedNonce) ?? {
        iss: issuer,
        sub: 'opaque-subject-1',
        aud: CLIENT_ID,
        azp: CLIENT_ID,
        exp: now + 300,
        iat: now,
        nonce: expectedNonce,
        auth_time: now,
        email: 'member@example.test',
        email_verified: true,
        name: 'Fixture Member',
        tid: 'provider-specific-and-ignored',
      }
      let idToken = signIdToken(
        signingKey.privateKey,
        claims,
        signingKey.kid,
        options.tokenAlgorithm
      )
      if (options.tamperSignature) {
        const parts = idToken.split('.')
        idToken = `${parts[0]}.${parts[1]}.${Buffer.from('invalid-signature').toString('base64url')}`
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({
          access_token: 'access-token-must-not-escape',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken,
        }),
      }
    }
    throw new Error(`Unexpected OIDC fixture endpoint ${input.url}`)
  }
  oidcTestNetwork.resolveEndpoint.mockReset().mockImplementation(async (url: string) => {
    if (options.temporaryTokenEndpointDnsFailure && url === metadata.token_endpoint) {
      return {
        ok: false,
        classification: 'transient_dns',
        errors: [
          {
            field: 'OIDC token endpoint',
            message: `dns "${new URL(url).hostname}" could not be resolved: EAI_AGAIN`,
          },
        ],
      }
    }
    return { ok: true, addresses: [PUBLIC_IP] }
  })
  oidcTestNetwork.pinnedFetch
    .mockReset()
    .mockImplementation(async (url: string, _field: string, requestOptions: PinnedFetchOptions) => {
      if (options.tokenTimeout && url === metadata.token_endpoint) {
        return {
          ok: false,
          error: { kind: 'transport_failed', detail: 'request deadline exceeded' },
        }
      }
      const raw = await transport({
        url,
        method: requestOptions.method ?? 'GET',
        headers: requestOptions.headers ?? {},
        lookup: (() => undefined) as never,
        signal: requestOptions.signal ?? new AbortController().signal,
        maxBodyBytes: requestOptions.maxBodyBytes ?? 1024 * 1024,
        ...(requestOptions.body !== undefined ? { body: requestOptions.body } : {}),
      })
      return {
        ok: true,
        response: { ...raw, pinnedAddresses: [PUBLIC_IP] },
      }
    })
  const db = new MemoryAttemptDb()
  const engine = new OidcProtocolEngine(providerConfiguration(issuer), {
    db: db.client,
    getClientSecret: () => currentClientSecret,
    encryptionKeyHex: ENCRYPTION_KEY,
    now: () => Date.now(),
  })
  return {
    db,
    engine,
    tokenRequests: () => tokenRequests,
    jwksRequests: () => jwksRequests,
    requestedUrls,
    setNonce(value: string) {
      nonce = value
    },
    setChallenge(value: string) {
      codeChallenge = value
    },
    setClientSecret(value: string) {
      currentClientSecret = value
    },
    setTokenStatus(value: number | undefined) {
      tokenStatus = value
    },
    rotateKey() {
      const next = generateKeyPairSync('rsa', { modulusLength: 2048 })
      signingKey = { privateKey: next.privateKey, kid: 'key-2' }
      publicKeys = [jwk(next.publicKey, 'key-2')]
    },
  }
}

async function begin(f: ReturnType<typeof fixture>) {
  const attempt = await f.engine.beginIdentityProofAttempt()
  const params = new URL(attempt.authorizationUrl).searchParams
  f.setNonce(params.get('nonce') ?? '')
  f.setChallenge(params.get('code_challenge') ?? '')
  return { attempt, params }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('generic OIDC protocol foundation', () => {
  it('uses code + PKCE S256, verifies an issuer-bound ID token, and returns only a proof', async () => {
    const f = fixture()
    const { params } = await begin(f)
    expect(params.get('response_type')).toBe('code')
    expect(params.get('response_mode')).toBe('query')
    expect(params.get('scope')).toBe('openid profile email')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(params.get('redirect_uri')).toBe(GENERIC_REDIRECT)
    const proof = await f.engine.completeIdentityProofAttempt({
      state: params.get('state')!,
      code: 'fixture-code',
      issuer: GENERIC_ISSUER,
    })
    expect(isVerifiedOidcIdentityProof(proof)).toBe(true)
    expect(proof).toMatchObject({
      purpose: 'oidc-identity-proof-v1',
      issuer: GENERIC_ISSUER,
      subject: 'opaque-subject-1',
      registrationId: 'company-login',
      clientId: CLIENT_ID,
      attributes: {
        source: 'validated_id_token',
        email: 'member@example.test',
        emailVerified: true,
      },
    })
    expect(proof).not.toHaveProperty('accessToken')
    expect(JSON.stringify(proof)).not.toContain('access-token-must-not-escape')
    expect(JSON.stringify(proof)).not.toContain(CLIENT_SECRET)
    expect(f.db.statements.every(sql => sql.includes('oidc_protocol_attempts'))).toBe(true)
    expect([...f.db.rows.values()][0]?.status).toBe('completed')
    expect(f.requestedUrls).toContain(`${GENERIC_ISSUER}/keys`)
  })

  it('fails closed for wrong state, callback issuer, and replay without a second exchange', async () => {
    const f = fixture()
    const { params } = await begin(f)
    await expect(
      f.engine.completeIdentityProofAttempt({
        state: 'x'.repeat(48),
        code: 'fixture-code',
        issuer: GENERIC_ISSUER,
      })
    ).rejects.toBeInstanceOf(OidcProviderIncompatibleError)
    await expect(
      f.engine.completeIdentityProofAttempt({
        state: params.get('state')!,
        code: 'fixture-code',
        issuer: 'https://wrong.example.test',
      })
    ).rejects.toBeInstanceOf(OidcProviderIncompatibleError)
    expect(f.tokenRequests()).toBe(0)
    const input = { state: params.get('state')!, code: 'fixture-code', issuer: GENERIC_ISSUER }
    await f.engine.completeIdentityProofAttempt(input)
    await expect(f.engine.completeIdentityProofAttempt(input)).rejects.toBeInstanceOf(
      OidcProviderIncompatibleError
    )
    expect(f.tokenRequests()).toBe(1)
  })

  it('binds an attempt to its registration and invalidates it when the credential generation changes', async () => {
    const f = fixture()
    const { params } = await begin(f)
    const wrongClientEngine = new OidcProtocolEngine(
      providerConfiguration(GENERIC_ISSUER, 'other-client'),
      {
        db: f.db.client,
        getClientSecret: () => CLIENT_SECRET,
        encryptionKeyHex: ENCRYPTION_KEY,
      }
    )
    await expect(
      wrongClientEngine.completeIdentityProofAttempt({
        state: params.get('state')!,
        code: 'fixture-code',
        issuer: GENERIC_ISSUER,
      })
    ).rejects.toBeInstanceOf(OidcProviderIncompatibleError)
    expect(f.tokenRequests()).toBe(0)

    f.setClientSecret(`${CLIENT_SECRET}-rotated`)
    await expect(
      f.engine.completeIdentityProofAttempt({
        state: params.get('state')!,
        code: 'fixture-code',
        issuer: GENERIC_ISSUER,
      })
    ).rejects.toBeInstanceOf(OidcProviderIncompatibleError)
    expect([...f.db.rows.values()][0]?.status).toBe('pending')
    expect(f.tokenRequests()).toBe(0)
  })

  it('rejects an authorization code when its verifier does not match the S256 challenge', async () => {
    const f = fixture()
    const { params } = await begin(f)
    f.setChallenge('a-different-challenge')
    await expect(
      f.engine.completeIdentityProofAttempt({
        state: params.get('state')!,
        code: 'fixture-code',
        issuer: GENERIC_ISSUER,
      })
    ).rejects.toBeInstanceOf(OidcProviderIncompatibleError)
    expect(f.tokenRequests()).toBe(1)
    expect([...f.db.rows.values()][0]?.status).toBe('failed')
  })

  it.each([
    [
      'issuer',
      (nonce: string, now: number) => ({
        iss: 'https://other.example.test',
        sub: 'subject',
        aud: CLIENT_ID,
        exp: now + 300,
        iat: now,
        nonce,
      }),
    ],
    [
      'audience',
      (nonce: string, now: number) => ({
        iss: GENERIC_ISSUER,
        sub: 'subject',
        aud: 'wrong-client',
        exp: now + 300,
        iat: now,
        nonce,
      }),
    ],
    [
      'expiration',
      (nonce: string, now: number) => ({
        iss: GENERIC_ISSUER,
        sub: 'subject',
        aud: CLIENT_ID,
        exp: now - 1,
        iat: now - 60,
        nonce,
      }),
    ],
    [
      'issued-at',
      (nonce: string, now: number) => ({
        iss: GENERIC_ISSUER,
        sub: 'subject',
        aud: CLIENT_ID,
        exp: now + 300,
        iat: now + 600,
        nonce,
      }),
    ],
    [
      'nonce',
      (_nonce: string, now: number) => ({
        iss: GENERIC_ISSUER,
        sub: 'subject',
        aud: CLIENT_ID,
        exp: now + 300,
        iat: now,
        nonce: 'wrong-nonce',
      }),
    ],
    [
      'authorized party',
      (nonce: string, now: number) => ({
        iss: GENERIC_ISSUER,
        sub: 'subject',
        aud: [CLIENT_ID, 'other'],
        azp: 'wrong-client',
        exp: now + 300,
        iat: now,
        nonce,
      }),
    ],
    [
      'subject',
      (nonce: string, now: number) => ({
        iss: GENERIC_ISSUER,
        sub: '',
        aud: CLIENT_ID,
        exp: now + 300,
        iat: now,
        nonce,
      }),
    ],
  ])('produces no proof for invalid ID token %s', async (_label, claims) => {
    const f = fixture({ claims: nonce => claims(nonce, Math.floor(Date.now() / 1000)) })
    const { params } = await begin(f)
    await expect(
      f.engine.completeIdentityProofAttempt({
        state: params.get('state')!,
        code: 'fixture-code',
        issuer: GENERIC_ISSUER,
      })
    ).rejects.toBeInstanceOf(OidcProviderIncompatibleError)
    expect([...f.db.rows.values()][0]?.status).toBe('failed')
  })

  it('rejects metadata redirects, non-public DNS, and incompatible endpoint origins', async () => {
    expect(
      (
        await fixture({
          discoveryRedirect: 'https://metadata.example.test/redirected',
        }).engine.validateProvider()
      ).status
    ).toBe('incompatible')
    expect(
      (
        await fixture({
          authorizationEndpoint: 'https://169.254.169.254/authorize',
        }).engine.validateProvider()
      ).status
    ).toBe('incompatible')
    expect(
      (
        await fixture({
          authorizationEndpoint: 'https://attacker.example.net/authorize',
        }).engine.validateProvider()
      ).status
    ).toBe('incompatible')
    expect((await fixture({ discoveryStatus: 503 }).engine.validateProvider()).status).toBe(
      'unavailable'
    )
    expect(
      (await fixture({ responseTypesSupported: ['token'] }).engine.validateProvider()).status
    ).toBe('incompatible')
  })

  it.each([
    ['query response mode', { responseModesSupported: ['form_post'] }],
    ['email scope', { scopesSupported: ['openid', 'profile'] }],
  ])('rejects explicitly unsupported required %s', async (_label, options) => {
    expect((await fixture(options).engine.validateProvider()).status).toBe('incompatible')
  })

  it.each([
    ['response types', { responseTypesSupported: ['code', 1] }],
    ['response modes', { responseModesSupported: 'query' }],
    ['grant types', { grantTypesSupported: 'authorization_code' }],
    ['scopes', { scopesSupported: 'openid profile email' }],
    ['token authentication methods', { tokenAuthMethodsSupported: 'client_secret_basic' }],
    ['PKCE methods', { codeChallengeMethodsSupported: 'S256' }],
    ['issuer binding capability', { issuerBindingCapability: 'true' }],
  ])('rejects malformed %s capability metadata', async (_label, options) => {
    expect((await fixture(options).engine.validateProvider()).status).toBe('incompatible')
  })

  it('accepts absent optional capability lists without widening the configured flow', async () => {
    const f = fixture({ omitOptionalCapabilities: true })
    expect((await f.engine.validateProvider()).status).toBe('metadata-and-jwks-valid')

    const { params } = await begin(f)
    expect(params.get('response_type')).toBe('code')
    expect(params.get('response_mode')).toBe('query')
    expect(params.get('scope')).toBe('openid profile email')
    expect(params.get('code_challenge_method')).toBe('S256')
    const proof = await f.engine.completeIdentityProofAttempt({
      state: params.get('state')!,
      code: 'fixture-code',
      issuer: GENERIC_ISSUER,
    })
    expect(isVerifiedOidcIdentityProof(proof)).toBe(true)
  })

  it('reports transient token-endpoint DNS failures as unavailable', async () => {
    const f = fixture({ temporaryTokenEndpointDnsFailure: true })
    const status = await f.engine.validateProvider()
    expect(status.status).toBe('unavailable')
    expect(status.reason).toBe('provider-unavailable')
    expect(status.memberAuthenticationActivated).toBe(false)
  })

  it.each([
    ['HTTP 503', { tokenStatus: 503 }],
    ['request timeout', { tokenTimeout: true }],
  ])(
    'preserves provider unavailability on token exchange %s without proof',
    async (_label, options) => {
      const f = fixture(options)
      const { params } = await begin(f)
      await expect(
        f.engine.completeIdentityProofAttempt({
          state: params.get('state')!,
          code: 'fixture-code',
          issuer: GENERIC_ISSUER,
        })
      ).rejects.toBeInstanceOf(OidcProviderUnavailableError)
      expect([...f.db.rows.values()][0]?.status).toBe('failed')
    }
  )

  it('does not reuse a prior transient transport failure for a later invalid token', async () => {
    const f = fixture({
      tokenStatus: 503,
      claims: nonce => ({
        iss: GENERIC_ISSUER,
        sub: 'opaque-subject-1',
        aud: 'wrong-client',
        exp: Math.floor(Date.now() / 1000) + 300,
        iat: Math.floor(Date.now() / 1000),
        nonce,
      }),
    })
    const first = await begin(f)
    await expect(
      f.engine.completeIdentityProofAttempt({
        state: first.params.get('state')!,
        code: 'fixture-code',
        issuer: GENERIC_ISSUER,
      })
    ).rejects.toBeInstanceOf(OidcProviderUnavailableError)

    f.setTokenStatus(undefined)
    const second = await begin(f)
    await expect(
      f.engine.completeIdentityProofAttempt({
        state: second.params.get('state')!,
        code: 'fixture-code',
        issuer: GENERIC_ISSUER,
      })
    ).rejects.toBeInstanceOf(OidcProviderIncompatibleError)
    expect([...f.db.rows.values()].map(row => row.status)).toEqual(['failed', 'failed'])
  })

  it('keeps transport failure classification isolated between concurrent exchanges', async () => {
    const invalidTokenStarted = deferred<void>()
    const releaseInvalidToken = deferred<void>()
    const f = fixture({
      claims: nonce => ({
        iss: GENERIC_ISSUER,
        sub: 'opaque-subject-1',
        aud: 'wrong-client',
        exp: Math.floor(Date.now() / 1000) + 300,
        iat: Math.floor(Date.now() / 1000),
        nonce,
      }),
      beforeTokenResponse: async code => {
        if (code !== 'invalid-token-code') return
        invalidTokenStarted.resolve()
        await releaseInvalidToken.promise
      },
    })

    const invalidAttempt = await begin(f)
    const invalidCompletion = f.engine.completeIdentityProofAttempt({
      state: invalidAttempt.params.get('state')!,
      code: 'invalid-token-code',
      issuer: GENERIC_ISSUER,
    })
    await invalidTokenStarted.promise

    f.setTokenStatus(503)
    const unavailableAttempt = await begin(f)
    await expect(
      f.engine.completeIdentityProofAttempt({
        state: unavailableAttempt.params.get('state')!,
        code: 'transient-failure-code',
        issuer: GENERIC_ISSUER,
      })
    ).rejects.toBeInstanceOf(OidcProviderUnavailableError)

    f.setTokenStatus(undefined)
    releaseInvalidToken.resolve()
    await expect(invalidCompletion).rejects.toBeInstanceOf(OidcProviderIncompatibleError)
    expect([...f.db.rows.values()].map(row => row.status)).toEqual(['failed', 'failed'])
  })

  it.each([
    ['tampered signature', { tamperSignature: true }],
    ['unsupported signing algorithm', { tokenAlgorithm: 'HS256' }],
  ])('rejects an ID token with a %s', async (_label, options) => {
    const f = fixture(options)
    const { params } = await begin(f)
    await expect(
      f.engine.completeIdentityProofAttempt({
        state: params.get('state')!,
        code: 'fixture-code',
        issuer: GENERIC_ISSUER,
      })
    ).rejects.toBeInstanceOf(OidcProviderIncompatibleError)
    if ('tamperSignature' in options) {
      expect(f.requestedUrls).toContain(`${GENERIC_ISSUER}/keys`)
    }
    expect([...f.db.rows.values()][0]?.status).toBe('failed')
  })

  it('accepts a real RS256 token from an alg-less JWK when PS256 is also advertised', async () => {
    const f = fixture({
      tokenAlgorithm: 'RS256',
      jwksKeyAlgorithm: null,
      idTokenSigningAlgorithms: ['RS256', 'PS256'],
    })
    const { params } = await begin(f)

    const proof = await f.engine.completeIdentityProofAttempt({
      state: params.get('state')!,
      code: 'fixture-code',
      issuer: GENERIC_ISSUER,
    })

    expect(isVerifiedOidcIdentityProof(proof)).toBe(true)
    expect(f.jwksRequests()).toBe(1)
  })

  it('rejects a genuinely PS256-signed token when RS256 and PS256 are advertised', async () => {
    const f = fixture({
      tokenAlgorithm: 'PS256',
      jwksKeyAlgorithm: null,
      idTokenSigningAlgorithms: ['RS256', 'PS256'],
    })
    const { params } = await begin(f)

    await expect(
      f.engine.completeIdentityProofAttempt({
        state: params.get('state')!,
        code: 'fixture-code',
        issuer: GENERIC_ISSUER,
      })
    ).rejects.toBeInstanceOf(OidcProviderIncompatibleError)

    expect([...f.db.rows.values()][0]?.status).toBe('failed')
  })

  it('rejects a cross-site JWKS endpoint before fetching it', async () => {
    const crossSiteJwks = 'https://keys.other.test/keys'
    const f = fixture({ jwksUri: crossSiteJwks })

    await expect(f.engine.validateProvider()).resolves.toMatchObject({ status: 'incompatible' })

    expect(f.requestedUrls).not.toContain(crossSiteJwks)
    expect(f.tokenRequests()).toBe(0)
  })

  it('rejects private key material and oversized key sets in JWKS', async () => {
    const undersized = fixture({ initialKeyBits: 1024 })
    expect((await undersized.engine.validateProvider()).status).toBe('incompatible')
    const { params } = await begin(undersized)
    await expect(
      undersized.engine.completeIdentityProofAttempt({
        state: params.get('state')!,
        code: 'fixture-code',
        issuer: GENERIC_ISSUER,
      })
    ).rejects.toBeInstanceOf(OidcProviderIncompatibleError)
    expect([...undersized.db.rows.values()][0]?.status).toBe('failed')

    const publicKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const validSigningKey = jwk(publicKey.publicKey, 'key-1')
    const validBaseline = fixture({ jwksBody: JSON.stringify({ keys: [validSigningKey] }) })
    expect((await validBaseline.engine.validateProvider()).status).toBe('metadata-and-jwks-valid')

    const privateJwk = fixture({
      jwksBody: JSON.stringify({ keys: [{ ...validSigningKey, d: 'AQAB' }] }),
    })
    expect((await privateJwk.engine.validateProvider()).status).toBe('incompatible')

    const oversized = fixture({
      jwksBody: JSON.stringify({
        keys: Array.from({ length: 65 }, (_, i) => ({ ...validSigningKey, kid: `key-${i}` })),
      }),
    })
    expect((await oversized.engine.validateProvider()).status).toBe('incompatible')
  })

  it('refreshes an unknown rotated key after the bounded JWKS cache freshness window', async () => {
    const f = fixture()
    const first = await begin(f)
    await f.engine.completeIdentityProofAttempt({
      state: first.params.get('state')!,
      code: 'fixture-code',
      issuer: GENERIC_ISSUER,
    })
    expect(f.jwksRequests(), f.requestedUrls.join(', ')).toBe(1)

    const originalNow = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(originalNow + 61_000)
    try {
      f.rotateKey()
      const second = await begin(f)
      const proof = await f.engine.completeIdentityProofAttempt({
        state: second.params.get('state')!,
        code: 'fixture-code',
        issuer: GENERIC_ISSUER,
      })
      expect(isVerifiedOidcIdentityProof(proof)).toBe(true)
      expect(f.jwksRequests()).toBe(2)
    } finally {
      clock.mockRestore()
    }
  })

  it('accepts a tenant-specific Entra issuer without making its tenant claim a generic field', async () => {
    const issuer = 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0'
    const f = fixture({ issuer })
    const { params } = await begin(f)
    const proof = await f.engine.completeIdentityProofAttempt({
      state: params.get('state')!,
      code: 'fixture-code',
      issuer,
    })
    expect(proof.issuer).toBe(issuer)
    expect(proof.subject).toBe('opaque-subject-1')
    expect(proof).not.toHaveProperty('tenantId')
    expect(f.db.statements.join('\n')).not.toMatch(/graph|teams|directory/i)
  })

  it('rejects duplicate callback parameters and callback URLs outside the registered path', () => {
    expect(() =>
      parseOidcCallbackUrl(
        `${GENERIC_REDIRECT}?state=one&state=two&code=auth-code`,
        GENERIC_REDIRECT
      )
    ).toThrow(/duplicate protocol parameters/)
    expect(() =>
      parseOidcCallbackUrl(
        'https://attacker.example.test/callback?state=a&code=b',
        GENERIC_REDIRECT
      )
    ).toThrow(/does not match/)
    expect(
      parseOidcCallbackUrl(
        `${GENERIC_REDIRECT}?state=${'x'.repeat(48)}&code=auth-code`,
        GENERIC_REDIRECT
      )
    ).toMatchObject({ code: 'auth-code' })
  })
})
