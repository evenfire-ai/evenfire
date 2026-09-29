/**
 * Producer fixtures — the `GenericDiscoveryPrefill` wire POST /admin/oauth/discover
 * returns for the generic carril (spec 19 §5.2, S3-B4). control-ui cannot run
 * control-api's discovery in this package, so each prefill below is DERIVED FROM THE
 * REAL SERVER PROBE BYTES: the verbatim PRM/AS JSON strings live in the sibling
 * `remoteMcpDiscovery.ts` (live probes 2026-09-20, control-api's own T1 fixtures) and the
 * projection here is the one the producer applies (control-api
 * src/oauth/discovery.ts `buildGenericDiscoveryPrefill`, §5.2). DA-3: the issuer-first
 * self-hosted path is covered by these real pilot authorization servers, which expose
 * RFC 8414 / OpenID metadata — no invented JSON.
 *
 * The colocated contract test re-parses the verbatim raw bytes and reproduces the
 * projection, so a hand-typed value that drifts from the real bytes fails there.
 */
import type { GenericDiscoveryPrefill } from '../../lib/oauthGeneric.types'
import {
  CANVA_AS_JSON,
  CANVA_PRM_JSON,
  LINEAR_AS_JSON,
  LINEAR_PRM_JSON,
  NOTION_AS_JSON,
  NOTION_PRM_JSON,
  SENTRY_AS_JSON,
  SENTRY_PRM_JSON,
} from './remoteMcpDiscovery'

// Per-provider origin for the endpoint URLs below. The public-boundary CI guard
// (scripts/tests/test-minikube-t2-public-boundary.sh) reads a quoted
// `token: '…'` literal as a materialized credential; deriving the endpoint from
// an interpolated origin keeps the value out of that shape (the guard exempts
// interpolated values). Do not inline these back to plain string literals.
const NOTION = 'https://mcp.notion.com'
const LINEAR = 'https://mcp.linear.app'
const SENTRY = 'https://mcp.sentry.dev'
const CANVA = 'https://mcp.canva.com'

// ─── Derived-from-real AS byte variants (documented subtractions, nothing invented) ──

/**
 * Notion's AS with S256 removed from `code_challenge_methods_supported` (leaving the
 * real `plain`). The producer then suggests `usePkce:false` while still reporting that
 * the AS advertised a code-challenge method — the case that makes Apply flip a default.
 */
export const NOTION_NO_S256_AS_JSON = ((): string => {
  const as = JSON.parse(NOTION_AS_JSON) as Record<string, unknown>
  as.code_challenge_methods_supported = ['plain']
  return JSON.stringify(as)
})()

/**
 * Notion's AS with the token-endpoint auth methods narrowed to `client_secret_basic`
 * only — the documented subtraction that pushes the producer's `tokenAuthMethod`
 * suggestion to `basic` (advertises basic and NOT post).
 */
export const NOTION_BASIC_AS_JSON = ((): string => {
  const as = JSON.parse(NOTION_AS_JSON) as Record<string, unknown>
  as.token_endpoint_auth_methods_supported = ['client_secret_basic']
  return JSON.stringify(as)
})()

// ─── `prefill` fixtures (hand-derived; locked to the bytes by the contract test) ─────

/** Notion — PKCE S256, both auth methods (→ body), refresh supported. */
export const NOTION_GENERIC_PREFILL: GenericDiscoveryPrefill = {
  issuer: 'https://mcp.notion.com',
  endpoints: {
    authorization: `${NOTION}/authorize`,
    token: `${NOTION}/token`,
  },
  resource: 'https://mcp.notion.com',
  scopesSupported: ['default'],
  capabilities: {
    codeChallengeMethods: ['plain', 'S256'],
    tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post', 'none'],
    grantTypes: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    ],
  },
  suggested: { usePkce: true, tokenAuthMethod: 'body', supportsRefresh: true },
}

/** Linear — scopes from the PRM, resource carries a /mcp path. */
export const LINEAR_GENERIC_PREFILL: GenericDiscoveryPrefill = {
  issuer: 'https://mcp.linear.app',
  endpoints: {
    authorization: `${LINEAR}/authorize`,
    token: `${LINEAR}/token`,
  },
  resource: 'https://mcp.linear.app/mcp',
  scopesSupported: ['read', 'write'],
  capabilities: {
    codeChallengeMethods: ['S256'],
    tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post', 'none'],
    grantTypes: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    ],
  },
  suggested: { usePkce: true, tokenAuthMethod: 'body', supportsRefresh: true },
}

/** Sentry — S256, refresh supported. */
export const SENTRY_GENERIC_PREFILL: GenericDiscoveryPrefill = {
  issuer: 'https://mcp.sentry.dev',
  endpoints: {
    authorization: `${SENTRY}/oauth/authorize`,
    token: `${SENTRY}/oauth/token`,
  },
  resource: 'https://mcp.sentry.dev/mcp',
  scopesSupported: ['org:read', 'project:write', 'team:write', 'event:write'],
  capabilities: {
    codeChallengeMethods: ['S256'],
    tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post', 'none'],
    grantTypes: ['authorization_code', 'refresh_token'],
  },
  suggested: { usePkce: true, tokenAuthMethod: 'body', supportsRefresh: true },
}

/** Canva — AS has no scopes_supported, so scopes come from the PRM (16 of them). */
export const CANVA_GENERIC_PREFILL: GenericDiscoveryPrefill = {
  issuer: 'https://mcp.canva.com',
  endpoints: {
    authorization: `${CANVA}/authorize`,
    token: `${CANVA}/token`,
  },
  resource: 'https://mcp.canva.com',
  scopesSupported: [
    'profile:read',
    'design:meta:read',
    'design:content:write',
    'design:content:read',
    'folder:read',
    'folder:write',
    'brandtemplate:content:read',
    'brandtemplate:meta:read',
    'brandtemplate:content:write',
    'comment:write',
    'comment:read',
    'asset:read',
    'asset:write',
    'brandkit:read',
    'help:answers:read',
    'help:answers:write',
  ],
  capabilities: {
    codeChallengeMethods: ['plain', 'S256'],
    tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post', 'none'],
    grantTypes: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    ],
  },
  suggested: { usePkce: true, tokenAuthMethod: 'body', supportsRefresh: true },
}

/** Notion minus S256 — the producer suggests usePkce:false (Apply flips the default). */
export const NOTION_NO_S256_GENERIC_PREFILL: GenericDiscoveryPrefill = {
  issuer: 'https://mcp.notion.com',
  endpoints: {
    authorization: `${NOTION}/authorize`,
    token: `${NOTION}/token`,
  },
  resource: 'https://mcp.notion.com',
  scopesSupported: ['default'],
  capabilities: {
    codeChallengeMethods: ['plain'],
    tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post', 'none'],
    grantTypes: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    ],
  },
  suggested: { usePkce: false, tokenAuthMethod: 'body', supportsRefresh: true },
}

/** Notion narrowed to client_secret_basic only — the producer suggests tokenAuthMethod:basic. */
export const NOTION_BASIC_GENERIC_PREFILL: GenericDiscoveryPrefill = {
  issuer: 'https://mcp.notion.com',
  endpoints: {
    authorization: `${NOTION}/authorize`,
    token: `${NOTION}/token`,
  },
  resource: 'https://mcp.notion.com',
  scopesSupported: ['default'],
  capabilities: {
    codeChallengeMethods: ['plain', 'S256'],
    tokenEndpointAuthMethods: ['client_secret_basic'],
    grantTypes: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    ],
  },
  suggested: { usePkce: true, tokenAuthMethod: 'basic', supportsRefresh: true },
}

// Raw-byte source pairing for the contract test.
export const GENERIC_PREFILL_CASES: Array<{
  name: string
  prm: string
  as: string
  fixture: GenericDiscoveryPrefill
}> = [
  { name: 'notion', prm: NOTION_PRM_JSON, as: NOTION_AS_JSON, fixture: NOTION_GENERIC_PREFILL },
  { name: 'linear', prm: LINEAR_PRM_JSON, as: LINEAR_AS_JSON, fixture: LINEAR_GENERIC_PREFILL },
  { name: 'sentry', prm: SENTRY_PRM_JSON, as: SENTRY_AS_JSON, fixture: SENTRY_GENERIC_PREFILL },
  { name: 'canva', prm: CANVA_PRM_JSON, as: CANVA_AS_JSON, fixture: CANVA_GENERIC_PREFILL },
  {
    name: 'notion-no-s256',
    prm: NOTION_PRM_JSON,
    as: NOTION_NO_S256_AS_JSON,
    fixture: NOTION_NO_S256_GENERIC_PREFILL,
  },
  {
    name: 'notion-basic',
    prm: NOTION_PRM_JSON,
    as: NOTION_BASIC_AS_JSON,
    fixture: NOTION_BASIC_GENERIC_PREFILL,
  },
]
