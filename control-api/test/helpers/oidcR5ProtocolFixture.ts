import { type KeyObject, createHash, createSign, generateKeyPairSync } from 'node:crypto'
import type { DbClient } from '../../src/db.js'
import type {
  PinnedRawResponse,
  PinnedTransport,
  PinnedTransportInput,
} from '../../src/http/pinnedFetch.js'
import { loadOidcProviderConfiguration } from '../../src/oidc/configuration.js'
import { OidcProtocolEngine } from '../../src/oidc/protocol.js'

const ENCRYPTION_KEY = 'ab'.repeat(32)
const CLIENT_SECRET = 'r5-fixture-client-secret'
const CLIENT_ID = 'r5-fixture-client'
const REDIRECT_URI = 'https://control.example.test/api/v1/oidc/callback'
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

export class OidcR5MemoryAttemptDb {
  readonly rows = new Map<string, StoredAttempt>()
  readonly client: Pick<DbClient, 'query'> = {
    query: async (sql: string, values: unknown[] = []) => {
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
      throw new Error(`Unexpected protocol-attempt query: ${sql.slice(0, 60)}`)
    },
  }
}

function signIdToken(privateKey: KeyObject, claims: Record<string, unknown>, kid: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString(
    'base64url'
  )
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const input = `${header}.${payload}`
  const signer = createSign('RSA-SHA256')
  signer.update(input)
  signer.end()
  return `${input}.${signer.sign(privateKey).toString('base64url')}`
}

export function createRsaPublicJwk(publicKey: KeyObject, kid: string): Record<string, unknown> {
  return {
    ...(publicKey.export({ format: 'jwk' }) as JsonWebKey),
    kid,
    use: 'sig',
    alg: 'RS256',
  }
}

export type OidcR5FixtureOptions = {
  hostPrefix?: string
  clientAuthenticationMethod?: 'client_secret_basic' | 'client_secret_post'
  advertisedClientAuthenticationMethods?: string[]
  modulusLength?: number
}

export function createOidcR5ProtocolFixture(options: OidcR5FixtureOptions = {}) {
  const prefix = options.hostPrefix ?? 'issuer'
  const issuer = `https://${prefix}.example.test/tenant`
  const authorizationEndpoint = `https://login.${prefix}.example.test/authorize`
  const tokenEndpoint = `https://token.${prefix}.example.test/token`
  const jwksUri = `https://keys.${prefix}.example.test/jwks`
  const clientAuthenticationMethod = options.clientAuthenticationMethod ?? 'client_secret_basic'
  const provider = loadOidcProviderConfiguration(
    {
      CONTROL_API_OIDC_REGISTRATION_ID: `r5-${prefix}`,
      CONTROL_API_OIDC_DISPLAY_LABEL: 'R5 controlled provider',
      CONTROL_API_OIDC_ISSUER: issuer,
      CONTROL_API_OIDC_CLIENT_ID: CLIENT_ID,
      CONTROL_API_OIDC_CLIENT_SECRET: CLIENT_SECRET,
      CONTROL_API_OIDC_CLIENT_AUTH_METHOD: clientAuthenticationMethod,
      CONTROL_API_OIDC_REDIRECT_URI: REDIRECT_URI,
      CONTROL_API_OIDC_RESPONSE_MODE: 'query',
      CONTROL_API_OIDC_TRUST_GENERATION: 'r5-test-generation',
    },
    ENCRYPTION_KEY
  )!
  const keyPair = generateKeyPairSync('rsa', {
    modulusLength: options.modulusLength ?? 2048,
  })
  const keyId = `r5-${prefix}-key`
  let keys: Record<string, unknown>[] = [createRsaPublicJwk(keyPair.publicKey, keyId)]
  let nonce = ''
  let challenge = ''
  let jwksRequests = 0
  const tokenRequests: Array<{ headers: Record<string, string>; body: string }> = []
  const metadata = {
    issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    jwks_uri: jwksUri,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code'],
    scopes_supported: ['openid', 'profile', 'email'],
    token_endpoint_auth_methods_supported: options.advertisedClientAuthenticationMethods ?? [
      clientAuthenticationMethod,
    ],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
  }
  const transport: PinnedTransport = async (input: PinnedTransportInput) => {
    const url = new URL(input.url)
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      return jsonResponse(metadata)
    }
    if (input.url === jwksUri) {
      jwksRequests += 1
      return jsonResponse({ keys })
    }
    if (input.url === tokenEndpoint) {
      const body = input.body ?? ''
      tokenRequests.push({ headers: input.headers, body })
      const form = new URLSearchParams(body)
      if (
        createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url') !== challenge
      ) {
        return jsonResponse({ error: 'invalid_grant' }, 400)
      }
      const now = Math.floor(Date.now() / 1000)
      const idToken = signIdToken(
        keyPair.privateKey,
        {
          iss: issuer,
          sub: `subject-${prefix}`,
          aud: CLIENT_ID,
          azp: CLIENT_ID,
          exp: now + 300,
          iat: now,
          nonce,
          auth_time: now,
        },
        keyId
      )
      return jsonResponse({
        access_token: 'fixture-only-access-token',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken,
      })
    }
    throw new Error(`Unexpected fixture request to ${input.url}`)
  }
  const db = new OidcR5MemoryAttemptDb()
  const engine = new OidcProtocolEngine(provider, {
    db: db.client,
    getClientSecret: () => CLIENT_SECRET,
    encryptionKeyHex: ENCRYPTION_KEY,
    now: () => Date.now(),
  })

  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    metadata,
    provider,
    engine,
    db,
    transport,
    keyPair,
    keyId,
    tokenRequests,
    get jwksRequests() {
      return jwksRequests
    },
    setKeys(next: Record<string, unknown>[]) {
      keys = next
    },
    async begin() {
      const attempt = await engine.beginIdentityProofAttempt()
      const params = new URL(attempt.authorizationUrl).searchParams
      nonce = params.get('nonce') ?? ''
      challenge = params.get('code_challenge') ?? ''
      return { state: params.get('state')! }
    },
    async complete(state: string) {
      return engine.completeIdentityProofAttempt({ state, code: 'r5-fixture-code', issuer })
    },
  }
}

function jsonResponse(body: unknown, status = 200): PinnedRawResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    bodyText: JSON.stringify(body),
  }
}

export const OIDC_R5_PUBLIC_IP = PUBLIC_IP
