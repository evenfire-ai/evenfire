/**
 * Known-shape OAuth provider adapters supported by control-api. This is the
 * full control-api ADAPTER SET — NOT the recipe-admissible set. The mcpserver
 * CRD (`charts/clerum-crds/crds/mcpserver.yaml` `oauth.provider` enum) admits all
 * of these; the WorkflowRecipe CRD (`workflowrecipe.yaml` `provider` enum)
 * deliberately admits only the five legacy ones, so monday/clickup/vercel are
 * mcpserver-only and are rejected at recipe admission — consumers that gate
 * recipe providers must trust the recipe CRD enum, not this union.
 *
 * Adding a provider requires updating, in lockstep, ALL of:
 *   1. this union + `ADAPTERS` below,
 *   2. `charts/clerum-crds/crds/mcpserver.yaml` `oauth.provider` enum,
 *   3. `workflow-recipes/src/types.ts` `OAuthProvider` (+ `workflowrecipe.yaml`
 *      enum, only if the provider is also recipe-valid),
 *   4. `host-context-controller/src/types.ts` `McpServerOAuth.provider`.
 * Within control-api, `KNOWN_OAUTH_PROVIDERS` is derived from `ADAPTERS` (single
 * source of truth) — no per-call-site provider lists.
 *
 * U2 (spec 06 §U2) adds monday, clickup, vercel. monday + vercel require PKCE
 * (see `usesPkce` / pkce.ts).
 */
export type OAuthProvider =
  | 'salesforce'
  | 'slack'
  | 'notion'
  | 'microsoft-graph'
  | 'google'
  | 'monday'
  | 'clickup'
  | 'vercel'

/**
 * Known-shape OAuth provider adapters. Each adapter encapsulates the
 * provider-specific bits of the auth-code OAuth flow:
 *
 *   - the authorize URL the user gets redirected to
 *   - the token endpoint we POST the code to
 *   - the response shape we parse to extract access/refresh tokens
 *
 * Adding a provider is a code change here — recipes cannot speak OAuth to
 * arbitrary endpoints (CRD CEL O2 enforces the enum). This is deliberate:
 * it keeps the surface auditable and lets us encode per-provider quirks
 * (Notion's basic-auth on the token POST, Slack's split scope/user_scope,
 * Microsoft's tenant authority pattern) in one place.
 *
 * Spec §9.9 / Decision 20.
 */

export interface AuthorizeUrlInput {
  clientId: string
  redirectUri: string
  state: string
  scopes: string[]
  /**
   * PKCE S256 `code_challenge`, present only for adapters with `usesPkce`. The
   * caller (authorizeUrlHelper) derives it from the signed state via
   * `computeCodeChallengeS256(deriveCodeVerifier(secret, state))`. PKCE adapters
   * emit BOTH `code_challenge` AND `code_challenge_method=S256`.
   */
  codeChallenge?: string
}

export interface TokenExchangeInput {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
  /**
   * PKCE `code_verifier`, present only for adapters with `usesPkce`. The callback
   * re-derives it from the exact round-tripped state via
   * `deriveCodeVerifier(secret, state)`. Never present on the refresh path.
   */
  codeVerifier?: string
}

export interface TokenRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
}

export interface RefreshTokenInput {
  refreshToken: string
  clientId: string
  clientSecret: string
}

export interface ParsedTokenResponse {
  accessToken: string
  refreshToken?: string
  /** Seconds until access token expires; provider-supplied. */
  expiresIn?: number
  tokenType: string
  scope?: string
}

export interface OAuthProviderAdapter {
  provider: OAuthProvider
  /**
   * When true, this provider requires PKCE: `buildAuthorizeUrl` emits
   * `code_challenge` + `code_challenge_method=S256`, and `buildTokenRequest`
   * carries the `code_verifier`. Optional so existing (non-PKCE) adapters stay
   * unchanged. Refresh never uses PKCE.
   */
  usesPkce?: boolean
  /** Default scopes if recipe omits them. May be empty for providers that demand explicit scopes. */
  defaultScopes: ReadonlyArray<string>
  buildAuthorizeUrl(input: AuthorizeUrlInput): string
  buildTokenRequest(input: TokenExchangeInput): TokenRequest
  buildRefreshRequest(input: RefreshTokenInput): TokenRequest
  parseTokenResponse(body: unknown): ParsedTokenResponse
}

// ─── Helpers ────────────────────────────────────────────────────────────

function urlEncode(params: Record<string, string>): string {
  const pieces: string[] = []
  for (const [k, v] of Object.entries(params)) {
    pieces.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  }
  return pieces.join('&')
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`OAuth token response missing string field "${field}"`)
  }
  return v
}

function asOptionalString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') {
    throw new Error(`OAuth token response field "${field}" must be a string when present`)
  }
  return v
}

function asOptionalNumber(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`OAuth token response field "${field}" must be a number when present`)
  }
  return v
}

// ─── Standard OAuth2 token-endpoint POST (form-encoded body) ────────────

function standardTokenRequest(
  url: string,
  input: TokenExchangeInput,
  extraHeaders: Record<string, string> = {}
): TokenRequest {
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
  }
  // PKCE: appended only when the adapter set `codeVerifier`. Non-PKCE adapters
  // pass no verifier, so their emitted body stays byte-identical.
  if (input.codeVerifier) params.code_verifier = input.codeVerifier
  return {
    url,
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...extraHeaders,
    },
    body: urlEncode(params),
  }
}

function standardRefreshRequest(
  url: string,
  input: RefreshTokenInput,
  extraHeaders: Record<string, string> = {}
): TokenRequest {
  return {
    url,
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...extraHeaders,
    },
    body: urlEncode({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    }),
  }
}

function parseStandardOAuth2(body: unknown): ParsedTokenResponse {
  if (!isObject(body)) throw new Error('OAuth token response must be an object')
  return {
    accessToken: asString(body['access_token'], 'access_token'),
    refreshToken: asOptionalString(body['refresh_token'], 'refresh_token'),
    expiresIn: asOptionalNumber(body['expires_in'], 'expires_in'),
    tokenType: asOptionalString(body['token_type'], 'token_type') ?? 'Bearer',
    scope: asOptionalString(body['scope'], 'scope'),
  }
}

// ─── Adapter implementations ────────────────────────────────────────────

const SALESFORCE: OAuthProviderAdapter = {
  provider: 'salesforce',
  // No safe default; Salesforce requires explicit scopes.
  defaultScopes: [],
  buildAuthorizeUrl({ clientId, redirectUri, state, scopes }) {
    const params: Record<string, string> = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
    }
    if (scopes.length > 0) params.scope = scopes.join(' ')
    return `https://login.salesforce.com/services/oauth2/authorize?${urlEncode(params)}`
  },
  buildTokenRequest(input) {
    return standardTokenRequest('https://login.salesforce.com/services/oauth2/token', input)
  },
  buildRefreshRequest(input) {
    return standardRefreshRequest('https://login.salesforce.com/services/oauth2/token', input)
  },
  parseTokenResponse: parseStandardOAuth2,
}

const SLACK: OAuthProviderAdapter = {
  provider: 'slack',
  defaultScopes: [],
  buildAuthorizeUrl({ clientId, redirectUri, state, scopes }) {
    const params: Record<string, string> = {
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
    }
    // Slack v2 uses `scope` for bot scopes; user_scope is omitted here and
    // can be added by callers via custom recipes if needed in the future.
    if (scopes.length > 0) params.scope = scopes.join(',')
    return `https://slack.com/oauth/v2/authorize?${urlEncode(params)}`
  },
  buildTokenRequest(input) {
    return standardTokenRequest('https://slack.com/api/oauth.v2.access', input)
  },
  buildRefreshRequest(input) {
    // Slack's classic scopes do not refresh; bot rotations land here when the
    // workspace enables token rotation. The endpoint shape matches standard.
    return standardRefreshRequest('https://slack.com/api/oauth.v2.access', input)
  },
  parseTokenResponse(body) {
    // oauth.v2.access wraps the bot token under `access_token`; the standard
    // parser handles the fields we care about. ok=false → throw.
    if (!isObject(body)) throw new Error('Slack token response must be an object')
    if (body['ok'] === false) {
      const err = asOptionalString(body['error'], 'error') ?? 'unknown'
      throw new Error(`Slack OAuth exchange failed: ${err}`)
    }
    return parseStandardOAuth2(body)
  },
}

const NOTION: OAuthProviderAdapter = {
  provider: 'notion',
  defaultScopes: [],
  buildAuthorizeUrl({ clientId, redirectUri, state }) {
    // Notion ignores scope query param — workspace integrations declare scopes
    // in the integration config rather than per-request.
    const params: Record<string, string> = {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      owner: 'user',
      state,
    }
    return `https://api.notion.com/v1/oauth/authorize?${urlEncode(params)}`
  },
  buildTokenRequest(input) {
    // Notion requires HTTP Basic auth on the token POST instead of client_id /
    // client_secret in the body.
    const basic = Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')
    return {
      url: 'https://api.notion.com/v1/oauth/token',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Basic ${basic}`,
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    }
  },
  buildRefreshRequest() {
    // Notion does not issue refresh tokens for workspace integrations today.
    throw new Error('Notion does not support refresh tokens')
  },
  parseTokenResponse(body) {
    if (!isObject(body)) throw new Error('Notion token response must be an object')
    return {
      accessToken: asString(body['access_token'], 'access_token'),
      refreshToken: undefined,
      expiresIn: undefined,
      tokenType: asOptionalString(body['token_type'], 'token_type') ?? 'Bearer',
    }
  },
}

const MICROSOFT_GRAPH: OAuthProviderAdapter = {
  provider: 'microsoft-graph',
  // openid + offline_access are typical baseline; offline_access is what
  // earns us a refresh token.
  defaultScopes: ['openid', 'profile', 'email', 'offline_access'],
  buildAuthorizeUrl({ clientId, redirectUri, state, scopes }) {
    const effectiveScopes = scopes.length > 0 ? scopes : MICROSOFT_GRAPH.defaultScopes
    const params: Record<string, string> = {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: effectiveScopes.join(' '),
      state,
    }
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${urlEncode(params)}`
  },
  buildTokenRequest(input) {
    return standardTokenRequest('https://login.microsoftonline.com/common/oauth2/v2.0/token', input)
  },
  buildRefreshRequest(input) {
    return standardRefreshRequest(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      input
    )
  },
  parseTokenResponse: parseStandardOAuth2,
}

const GOOGLE: OAuthProviderAdapter = {
  provider: 'google',
  defaultScopes: [],
  buildAuthorizeUrl({ clientId, redirectUri, state, scopes }) {
    const params: Record<string, string> = {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline', // ask for refresh token
      prompt: 'consent', // force refresh-token issuance on re-consent
      state,
    }
    if (scopes.length > 0) params.scope = scopes.join(' ')
    return `https://accounts.google.com/o/oauth2/v2/auth?${urlEncode(params)}`
  },
  buildTokenRequest(input) {
    return standardTokenRequest('https://oauth2.googleapis.com/token', input)
  },
  buildRefreshRequest(input) {
    return standardRefreshRequest('https://oauth2.googleapis.com/token', input)
  },
  parseTokenResponse: parseStandardOAuth2,
}

// ─── monday (OAuth 2.1, PKCE) ───────────────────────────────────────────
//
// Docs: https://developer.monday.com/apps/docs/oauth (authorize) and
//       https://developer.monday.com/apps/docs/migrating-to-the-new-oauth-flow
//       (OAuth 2.1 token exchange + refresh, verified 2026-08-11).
// monday's OAuth 2.1 flow REQUIRES PKCE (code_challenge_method=S256) and issues
// short-lived access tokens + refresh tokens. The token endpoint is the OAuth 2.1
// endpoint `/oauth_ms/oauth/token` (distinct from the legacy `/oauth2/token`),
// and it takes a JSON body (verbatim per the migration doc's curl examples), NOT
// form-urlencoded. Confidential client: client_secret is sent together with
// code_verifier.
const MONDAY: OAuthProviderAdapter = {
  provider: 'monday',
  usesPkce: true,
  // monday requires explicit scopes; no safe default.
  defaultScopes: [],
  buildAuthorizeUrl({ clientId, redirectUri, state, scopes, codeChallenge }) {
    const params: Record<string, string> = {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
    }
    // monday uses space-separated scopes.
    if (scopes.length > 0) params.scope = scopes.join(' ')
    // PKCE is mandatory in monday's OAuth 2.1 flow — always emit BOTH.
    if (codeChallenge) {
      params.code_challenge = codeChallenge
      params.code_challenge_method = 'S256'
    }
    return `https://auth.monday.com/oauth2/authorize?${urlEncode(params)}`
  },
  buildTokenRequest(input) {
    // JSON body per the OAuth 2.1 migration doc (not form-urlencoded).
    const body: Record<string, string> = {
      grant_type: 'authorization_code',
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }
    if (input.codeVerifier) body.code_verifier = input.codeVerifier
    return {
      url: 'https://auth.monday.com/oauth_ms/oauth/token',
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    }
  },
  buildRefreshRequest(input) {
    return {
      url: 'https://auth.monday.com/oauth_ms/oauth/token',
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: input.clientId,
        client_secret: input.clientSecret,
        refresh_token: input.refreshToken,
      }),
    }
  },
  parseTokenResponse: parseStandardOAuth2,
}

// ─── clickup (no PKCE, non-standard token endpoint, no refresh) ─────────
//
// Docs: https://developer.clickup.com/docs/authentication and
//       https://developer.clickup.com/reference/getaccesstoken (verified
//       2026-08-11).
// ClickUp does NOT use PKCE. Its token endpoint is non-standard: the body carries
// ONLY client_id, client_secret, code — there is NO `grant_type` and NO
// `redirect_uri` (per the official Get Access Token reference). Tokens are
// non-expiring with NO refresh token, so buildRefreshRequest throws (like Notion)
// and parseTokenResponse returns no refreshToken/expiresIn. The `state` param IS
// round-tripped back on the redirect (verified) — it is ClickUp's only integrity
// binding, and the callback re-verifies its HMAC signature.
const CLICKUP: OAuthProviderAdapter = {
  provider: 'clickup',
  defaultScopes: [],
  buildAuthorizeUrl({ clientId, redirectUri, state }) {
    // ClickUp's authorize endpoint takes only client_id, redirect_uri, state —
    // no response_type, no scope query param.
    const params: Record<string, string> = {
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
    }
    return `https://app.clickup.com/api?${urlEncode(params)}`
  },
  buildTokenRequest(input) {
    // Bespoke: no grant_type, no redirect_uri — ClickUp accepts a form-encoded
    // body of client_id + client_secret + code only.
    return {
      url: 'https://api.clickup.com/api/v2/oauth/token',
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: urlEncode({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
      }),
    }
  },
  buildRefreshRequest() {
    // ClickUp tokens do not expire and there is no refresh token to exchange.
    throw new Error('ClickUp does not support refresh tokens')
  },
  parseTokenResponse(body) {
    if (!isObject(body)) throw new Error('ClickUp token response must be an object')
    return {
      accessToken: asString(body['access_token'], 'access_token'),
      refreshToken: undefined,
      expiresIn: undefined,
      tokenType: asOptionalString(body['token_type'], 'token_type') ?? 'Bearer',
    }
  },
}

// ─── vercel (Sign in with Vercel, PKCE) ─────────────────────────────────
//
// Docs: https://vercel.com/docs/sign-in-with-vercel/authorization-server-api
//       (verified 2026-08-11, doc last-updated 2026-03-30).
// Vercel REQUIRES `code_challenge` + `code_challenge_method=S256`. It issues a
// refresh token when the `offline_access` scope is requested, so that scope is in
// defaultScopes to earn one (mirrors microsoft-graph's baseline). client_secret is
// optional (confidential client accepted) — we send it. Standard form-encoded
// token + refresh; the shared helper appends code_verifier on the exchange.
const VERCEL: OAuthProviderAdapter = {
  provider: 'vercel',
  usesPkce: true,
  // offline_access earns a refresh token; openid/email/profile are the standard
  // Sign in with Vercel scopes. Recipe-supplied scopes override this baseline.
  defaultScopes: ['openid', 'email', 'profile', 'offline_access'],
  buildAuthorizeUrl({ clientId, redirectUri, state, scopes, codeChallenge }) {
    const effectiveScopes = scopes.length > 0 ? scopes : VERCEL.defaultScopes
    const params: Record<string, string> = {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: effectiveScopes.join(' '),
      state,
    }
    if (codeChallenge) {
      params.code_challenge = codeChallenge
      params.code_challenge_method = 'S256'
    }
    return `https://vercel.com/oauth/authorize?${urlEncode(params)}`
  },
  buildTokenRequest(input) {
    return standardTokenRequest('https://api.vercel.com/login/oauth/token', input)
  },
  buildRefreshRequest(input) {
    return standardRefreshRequest('https://api.vercel.com/login/oauth/token', input)
  },
  parseTokenResponse: parseStandardOAuth2,
}

const ADAPTERS: Record<OAuthProvider, OAuthProviderAdapter> = {
  salesforce: SALESFORCE,
  slack: SLACK,
  notion: NOTION,
  'microsoft-graph': MICROSOFT_GRAPH,
  google: GOOGLE,
  monday: MONDAY,
  clickup: CLICKUP,
  vercel: VERCEL,
}

export function getOAuthProviderAdapter(provider: OAuthProvider): OAuthProviderAdapter {
  return ADAPTERS[provider]
}

/**
 * The single source of truth for "is this a known provider". Derived from
 * `ADAPTERS` so admission, authorize, callback, and refresh can never drift
 * (they previously kept three hand-maintained copies of this set). Iterable for
 * tests via `[...KNOWN_OAUTH_PROVIDERS]`.
 */
export const KNOWN_OAUTH_PROVIDERS: ReadonlySet<OAuthProvider> = new Set(
  Object.keys(ADAPTERS) as OAuthProvider[]
)

export function isKnownOAuthProvider(value: string): value is OAuthProvider {
  return KNOWN_OAUTH_PROVIDERS.has(value as OAuthProvider)
}
