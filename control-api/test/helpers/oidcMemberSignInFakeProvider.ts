import { type KeyObject, createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import type { DbClient } from '../../src/db.js'
import type {
  PinnedRawResponse,
  PinnedTransport,
  PinnedTransportInput,
} from '../../src/http/pinnedFetch.js'
import {
  type OidcProviderConfiguration,
  loadOidcProviderConfiguration,
  readOidcClientSecret,
} from '../../src/oidc/configuration.js'
import { OidcProtocolEngine, type VerifiedOidcIdentityProof } from '../../src/oidc/protocol.js'
import {
  OIDC_R5_PUBLIC_IP,
  OidcR5MemoryAttemptDb,
  createRsaPublicJwk,
  jsonResponse,
  signIdToken,
} from './oidcR5ProtocolFixture.js'

/**
 * A fake OIDC provider that mints real `VerifiedOidcIdentityProof` objects
 * through the real `OidcProtocolEngine`, with ID-token claims chosen by the test.
 *
 * The engine reaches the provider only through `pinnedFetch`, so a test file
 * routes `pinnedFetch` to `oidcMemberSignInFakeTransport` and resolves DNS to
 * `OIDC_MEMBER_SIGN_IN_FAKE_PUBLIC_IP` (see `oidc.memberSignInFakeProvider.test.ts`).
 * The transport, the signing keys and the issued authorization codes are shared
 * by every fake in the test file, keyed by issuer and code. An engine that the
 * fake did not build (a route's default engine, for example) can therefore
 * complete an attempt that `authorize` answered.
 */

/** Merged over the iss/aud/sub/nonce/iat/exp defaults. An `undefined` value removes the default. */
export type FakeIdTokenClaims = Record<string, unknown>

export type OidcMemberSignInFakeSigningKey = 'published-1' | 'published-2' | 'unpublished'

export type OidcMemberSignInFakeSignInOptions = { signWith?: OidcMemberSignInFakeSigningKey }

/** The query-mode callback parameters, ready for `completeIdentityProofAttempt`. */
export type OidcMemberSignInFakeCallback = Readonly<{ state: string; code: string; issuer: string }>

export type OidcMemberSignInFakeProviderOptions = {
  db?: Pick<DbClient, 'query'>
  /** Default `https://member-sign-in.example.test/tenant`, a non-Entra issuer. */
  issuer?: string
  /**
   * Spread last over the full environment, so it can add or replace any
   * `CONTROL_API_OIDC_*` variable. The switch and its guard are set by default;
   * an `undefined` value removes a default variable.
   */
  memberSignInEnv?: Record<string, string | undefined>
}

export type OidcMemberSignInFakeProvider = {
  provider: OidcProviderConfiguration
  /** Built with policyEvidenceClaimNames ['tid','idp','roles','acct']. */
  engine: OidcProtocolEngine
  /** The exact `CONTROL_API_OIDC_*` environment the provider was loaded from. */
  env: Record<string, string>
  /** The shared fake transport; the same function as `oidcMemberSignInFakeTransport`. */
  transport: PinnedTransport
  /** Answers one authorization request: binds a fresh code to its nonce, PKCE challenge and claims. */
  authorize(
    authorizationUrl: string,
    claims: FakeIdTokenClaims,
    opts?: OidcMemberSignInFakeSignInOptions
  ): OidcMemberSignInFakeCallback
  /** begin → authorize → complete; returns the real VerifiedOidcIdentityProof */
  signIn(
    claims: FakeIdTokenClaims,
    opts?: OidcMemberSignInFakeSignInOptions
  ): Promise<VerifiedOidcIdentityProof>
}

export const OIDC_MEMBER_SIGN_IN_FAKE_PUBLIC_IP = OIDC_R5_PUBLIC_IP

const DEFAULT_ISSUER = 'https://member-sign-in.example.test/tenant'
const DEFAULT_SUBJECT = 'fake-member-subject'
const REGISTRATION_ID = 'fake-member-sign-in'
const CLIENT_ID = 'fake-member-sign-in-client'
const CLIENT_SECRET = 'fake-member-sign-in-client-secret'
const REDIRECT_URI = 'https://control.example.test/api/v1/oidc/callback'
const GENERATION_KEY_HEX = 'cd'.repeat(32)
const POLICY_EVIDENCE_CLAIM_NAMES = ['tid', 'idp', 'roles', 'acct'] as const
const ID_TOKEN_LIFETIME_SECONDS = 300

type SigningKey = { privateKey: KeyObject; publicKey: KeyObject; kid: string }

type IssuedCode = {
  issuer: string
  clientId: string
  redirectUri: string
  nonce: string
  codeChallenge: string
  claims: FakeIdTokenClaims
  signWith: OidcMemberSignInFakeSigningKey
}

const registeredIssuers = new Set<string>()
const issuedCodes = new Map<string, IssuedCode>()
let signingKeys: Record<OidcMemberSignInFakeSigningKey, SigningKey> | undefined

/** Generated once per test file: RSA key generation is the slow part of a fake. */
function fakeSigningKeys(): Record<OidcMemberSignInFakeSigningKey, SigningKey> {
  if (!signingKeys) {
    const generate = (kid: string): SigningKey => ({
      ...generateKeyPairSync('rsa', { modulusLength: 2048 }),
      kid,
    })
    signingKeys = {
      'published-1': generate('fake-member-sign-in-key-1'),
      'published-2': generate('fake-member-sign-in-key-2'),
      unpublished: generate('fake-member-sign-in-key-unpublished'),
    }
  }
  return signingKeys
}

function providerMetadata(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/keys`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code'],
    scopes_supported: ['openid', 'profile', 'email'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
  }
}

function redeemCode(issuer: string, input: PinnedTransportInput): PinnedRawResponse {
  const form = new URLSearchParams(input.body ?? '')
  const code = form.get('code') ?? ''
  const issued = issuedCodes.get(code)
  // A code is single-use: any redemption consumes it, as a real provider does.
  issuedCodes.delete(code)
  if (
    !issued ||
    issued.issuer !== issuer ||
    form.get('grant_type') !== 'authorization_code' ||
    form.get('redirect_uri') !== issued.redirectUri ||
    createHash('sha256')
      .update(form.get('code_verifier') ?? '')
      .digest('base64url') !== issued.codeChallenge
  ) {
    return jsonResponse({ error: 'invalid_grant' }, 400)
  }
  const now = Math.floor(Date.now() / 1000)
  const key = fakeSigningKeys()[issued.signWith]
  const idToken = signIdToken(
    key.privateKey,
    {
      iss: issuer,
      aud: issued.clientId,
      sub: DEFAULT_SUBJECT,
      nonce: issued.nonce,
      iat: now,
      exp: now + ID_TOKEN_LIFETIME_SECONDS,
      ...issued.claims,
    },
    key.kid
  )
  return jsonResponse({
    access_token: 'fake-member-sign-in-access-token',
    token_type: 'Bearer',
    expires_in: ID_TOKEN_LIFETIME_SECONDS,
    id_token: idToken,
  })
}

/** Serves discovery, JWKS and token requests for every fake issuer created in this test file. */
export const oidcMemberSignInFakeTransport: PinnedTransport = async input => {
  for (const issuer of registeredIssuers) {
    if (input.url === `${issuer}/.well-known/openid-configuration`) {
      return jsonResponse(providerMetadata(issuer))
    }
    if (input.url === `${issuer}/keys`) {
      const keys = fakeSigningKeys()
      return jsonResponse({
        keys: [
          createRsaPublicJwk(keys['published-1'].publicKey, keys['published-1'].kid),
          createRsaPublicJwk(keys['published-2'].publicKey, keys['published-2'].kid),
        ],
      })
    }
    if (input.url === `${issuer}/token`) return redeemCode(issuer, input)
  }
  throw new Error(`Unexpected fake OIDC provider request to ${input.url}`)
}

export function createOidcMemberSignInFakeProvider(
  options: OidcMemberSignInFakeProviderOptions = {}
): OidcMemberSignInFakeProvider {
  const env = Object.fromEntries(
    Object.entries({
      CONTROL_API_OIDC_REGISTRATION_ID: REGISTRATION_ID,
      CONTROL_API_OIDC_DISPLAY_LABEL: 'Fake member sign-in provider',
      CONTROL_API_OIDC_ISSUER: options.issuer ?? DEFAULT_ISSUER,
      CONTROL_API_OIDC_CLIENT_ID: CLIENT_ID,
      CONTROL_API_OIDC_CLIENT_SECRET: CLIENT_SECRET,
      CONTROL_API_OIDC_CLIENT_AUTH_METHOD: 'client_secret_basic',
      CONTROL_API_OIDC_REDIRECT_URI: REDIRECT_URI,
      CONTROL_API_OIDC_RESPONSE_MODE: 'query',
      CONTROL_API_OIDC_TRUST_GENERATION: 'fake-member-sign-in-generation',
      CONTROL_API_OIDC_MEMBER_SIGN_IN: 'enabled',
      CONTROL_API_OIDC_UNRELEASED: 'acknowledged',
      ...options.memberSignInEnv,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  const provider = loadOidcProviderConfiguration(env, GENERATION_KEY_HEX)
  if (!provider) throw new Error('Fake OIDC provider environment has no registration')
  registeredIssuers.add(provider.issuer)

  const engine = new OidcProtocolEngine(provider, {
    db: options.db ?? new OidcR5MemoryAttemptDb().client,
    getClientSecret: () => readOidcClientSecret(provider, env),
    encryptionKeyHex: GENERATION_KEY_HEX,
    policyEvidenceClaimNames: POLICY_EVIDENCE_CLAIM_NAMES,
    now: () => Date.now(),
  })

  const authorize = (
    authorizationUrl: string,
    claims: FakeIdTokenClaims,
    opts: OidcMemberSignInFakeSignInOptions = {}
  ): OidcMemberSignInFakeCallback => {
    const url = new URL(authorizationUrl)
    if (`${url.origin}${url.pathname}` !== `${provider.issuer}/authorize`) {
      throw new Error('Authorization request is not addressed to this fake OIDC provider')
    }
    const params = url.searchParams
    const state = params.get('state')
    const nonce = params.get('nonce')
    const codeChallenge = params.get('code_challenge')
    if (
      !state ||
      !nonce ||
      !codeChallenge ||
      params.get('code_challenge_method') !== 'S256' ||
      params.get('response_type') !== 'code' ||
      params.get('client_id') !== provider.clientId ||
      params.get('redirect_uri') !== provider.redirectUri
    ) {
      throw new Error('Authorization request does not match the fake OIDC client registration')
    }
    const code = `fake-code-${randomBytes(24).toString('base64url')}`
    issuedCodes.set(code, {
      issuer: provider.issuer,
      clientId: provider.clientId,
      redirectUri: provider.redirectUri,
      nonce,
      codeChallenge,
      claims: { ...claims },
      signWith: opts.signWith ?? 'published-1',
    })
    return Object.freeze({ state, code, issuer: provider.issuer })
  }

  return {
    provider,
    engine,
    env,
    transport: oidcMemberSignInFakeTransport,
    authorize,
    async signIn(claims, opts) {
      const browserBinding = randomBytes(32).toString('base64url')
      const { authorizationUrl } = await engine.beginIdentityProofAttempt({ browserBinding })
      const callback = authorize(authorizationUrl, claims, opts)
      return engine.completeIdentityProofAttempt({ ...callback, browserBinding })
    },
  }
}
