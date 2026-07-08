/**
 * Known-shape OAuth provider adapters supported by control-api. The string
 * union mirrors the CRD enum (charts/clerum-crds/crds/workflowrecipe.yaml,
 * spec.oauthClients[].provider) and the workflow-recipes types.ts
 * `OAuthProvider`. Adding a provider requires updating ALL three sites.
 */
export type OAuthProvider = 'salesforce' | 'slack' | 'notion' | 'microsoft-graph' | 'google'

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
}

export interface TokenExchangeInput {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
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
  return {
    url,
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...extraHeaders,
    },
    body: urlEncode({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
    }),
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

const ADAPTERS: Record<OAuthProvider, OAuthProviderAdapter> = {
  salesforce: SALESFORCE,
  slack: SLACK,
  notion: NOTION,
  'microsoft-graph': MICROSOFT_GRAPH,
  google: GOOGLE,
}

export function getOAuthProviderAdapter(provider: OAuthProvider): OAuthProviderAdapter {
  return ADAPTERS[provider]
}
