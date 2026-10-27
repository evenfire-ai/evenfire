/**
 * Authorization-server profiles: closed, code-defined behaviour for authorization
 * servers whose published metadata omits capabilities they document elsewhere. A
 * profile is recognised ONLY from an issuer that already passed the strict RFC 8414
 * §3.3 comparison, so it never widens which issuers are trusted.
 *
 * `entra-v2` — Microsoft Entra ID v2, tenant authority. Why each rule exists:
 * - Entra's OIDC metadata omits `code_challenge_methods_supported` and
 *   `grant_types_supported`, yet its authorization code flow reference
 *   (learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow) states that
 *   it supports both `plain` and `S256`, that the `refresh_token` is "only provided if
 *   `offline_access` scope was requested", and that the refresh request accepts a
 *   `scope` "equivalent to or a subset of" the scopes of the authorize request. Hence
 *   PKCE S256 and refresh are assumed, and `offline_access` is always requested.
 * - Entra v2 resolves the token audience from `scope` and rejects an RFC 8707
 *   `resource` that disagrees with it (AADSTS9010010), so `resource` is never sent and
 *   the scopes alone decide which API the token is for.
 * - A scope without a resource prefix (`Mail.Read`) is read by Entra as a Microsoft
 *   Graph scope. Every resource scope must therefore name the MCP server's own host,
 *   or be the GUID form of an API this module can tie to that host.
 * - Entra allows dynamic consent to permissions the app registration does not declare
 *   (learn.microsoft.com/entra/identity-platform/consent-types-developer), so the app
 *   registration does not cap which API a GUID-form scope can reach. That is why
 *   high-impact first-party APIs are rejected outright and any other GUID the host
 *   cannot be tied to needs the operator's explicit confirmation.
 * - Requesting only OIDC scopes returns a Microsoft Graph token for UserInfo
 *   (learn.microsoft.com/entra/identity-platform/scopes-oidc), so at least one resource
 *   scope is required.
 */

export type AsProfileId = 'entra-v2'
export const AS_PROFILE_IDS: readonly AsProfileId[] = Object.freeze(['entra-v2'] as const)

export interface AsProfile {
  id: AsProfileId
  /** Supports PKCE S256 although its metadata omits code_challenge_methods_supported. */
  pkceS256: true
  /** Issues refresh tokens when `offline_access` is requested. */
  supportsRefresh: true
  /** Scopes always added to the requested set (order kept, no duplicates). */
  requiredScopes: readonly string[]
}

export interface RemoteWire {
  /** Send RFC 8707 `resource` on authorize, token and refresh. */
  sendResource: boolean
  /** Send the requested scopes as `scope` on every token-endpoint request (code exchange and refresh). */
  scopeOnTokenRequests: boolean
}

/** The CEL-compatible issuer pattern; the CRD rule and `detectAsProfile` share this exact text. */
export const ENTRA_TENANT_ISSUER_PATTERN =
  '^https://login[.]microsoftonline[.]com/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/v2[.]0$'

export const ENTRA_TENANT_AUTHORITY_TEMPLATE = 'https://login.microsoftonline.com/{tenantId}/v2.0'

/** RFC 6749 §3.3 scope-token; remoteMcp.ts imports it from here. */
export const SCOPE_TOKEN_RE = /^[\x21\x23-\x5B\x5D-\x7E]+$/

/**
 * First-party APIs whose GUID-form scopes are always rejected, whatever the operator confirms:
 * a GUID names no host, so a confirmed one would let Entra mint a token for these high-impact
 * APIs and hand it to whatever MCP host the CR points at.
 *
 * Only the GUID form is blocked. A first-party MCP server whose audience lives on its own host
 * (for example Dataverse at <org>.crm.dynamics.com/api/mcp) is connected with that host's
 * URL-form scope, which the host rule already accepts.
 *
 * Left out on purpose, because their URL-form audience lives on a host other than their MCP
 * server, so the GUID form (confirmed by the operator) is the only way to connect them:
 * - Azure DevOps (499b84ac-1321-427f-aa17-267ca6975798), MCP server at mcp.dev.azure.com;
 * - Power BI Service (00000009-0000-0000-c000-000000000000), MCP server at
 *   api.fabric.microsoft.com while its URL audience is analysis.windows.net.
 */
export const ENTRA_BLOCKED_RESOURCE_APPS: ReadonlyMap<string, string> = new Map([
  ['00000003-0000-0000-c000-000000000000', 'Microsoft Graph'],
  ['00000003-0000-0ff1-ce00-000000000000', 'SharePoint Online'],
  ['00000002-0000-0ff1-ce00-000000000000', 'Exchange Online'],
  ['797f4846-ba00-4fd7-ba43-dac1f8f63013', 'Azure Service Management'],
  ['00000002-0000-0000-c000-000000000000', 'Azure AD Graph'],
  ['cfa8b339-82a2-471a-a3c9-0fc0be7a4093', 'Azure Key Vault'],
  ['e406a681-f3d4-42a8-90b6-c2b029497af1', 'Azure Storage'],
  ['c5393580-f805-4401-95e8-94b7a6ef2fc2', 'Office 365 Management APIs'],
  ['0000000a-0000-0000-c000-000000000000', 'Microsoft Intune'],
  ['fc780465-2017-40d4-a0c5-307022471b92', 'WindowsDefenderATP'],
  ['00000004-0000-0ff1-ce00-000000000000', 'Skype for Business Online'],
  ['00000007-0000-0000-c000-000000000000', 'Dynamics CRM'],
  ['022907d3-0f1b-48f7-badc-1ba6abab6d66', 'Azure SQL Database'],
  ['ca7f3f0b-7d91-482c-8e09-c5d840d0eac5', 'Log Analytics API'],
  ['48ac35b8-9aa8-4d74-927d-1f4a14a0b239', 'Skype and Teams Tenant Admin API'],
  ['cc15fd57-2c6c-4117-a88c-83b1d56b4bbe', 'Microsoft Teams Services'],
])

/** First-party MCP APIs tied to the only host allowed to receive their tokens. */
export const ENTRA_KNOWN_RESOURCE_APPS: ReadonlyMap<string, string> = new Map([
  ['fdcc1f02-fc51-4226-8753-f668596af7f7', 'workiq.svc.cloud.microsoft'],
  ['05879165-0320-489e-b644-f72b33f3edf0', 'agent365.svc.cloud.microsoft'],
])

const ENTRA_V2: AsProfile = Object.freeze({
  id: 'entra-v2',
  pkceS256: true,
  supportsRefresh: true,
  requiredScopes: Object.freeze(['offline_access']),
})

const WIRE_DEFAULT: RemoteWire = Object.freeze({ sendResource: true, scopeOnTokenRequests: false })
const WIRE_ENTRA_V2: RemoteWire = Object.freeze({ sendResource: false, scopeOnTokenRequests: true })

const ENTRA_TENANT_ISSUER_RE = new RegExp(ENTRA_TENANT_ISSUER_PATTERN)
const ENTRA_LOGIN_HOST = 'login.microsoftonline.com'
const ENTRA_MULTI_TENANT_PATHS: ReadonlySet<string> = new Set([
  '/common/v2.0',
  '/organizations/v2.0',
])
const OIDC_SCOPES: ReadonlySet<string> = new Set(['openid', 'profile', 'email', 'offline_access'])
const GUID_SCOPE_RE =
  /^(api:\/\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[^/]+$/

export function isAsProfileId(value: unknown): value is AsProfileId {
  return value === 'entra-v2'
}

export function detectAsProfile(issuer: string): AsProfile | null {
  return ENTRA_TENANT_ISSUER_RE.test(issuer) ? ENTRA_V2 : null
}

/** The profile constant for an id (the same object detectAsProfile returns). */
export function asProfileById(id: AsProfileId): AsProfile {
  switch (id) {
    case 'entra-v2':
      return ENTRA_V2
  }
}

export function remoteWireForProfile(id: AsProfileId | undefined): RemoteWire {
  return id === 'entra-v2' ? WIRE_ENTRA_V2 : WIRE_DEFAULT
}

/** `scopes` plus the profile's required scopes, first occurrence wins; `scopes` as-is without a profile. */
export function withProfileScopes(
  scopes: readonly string[],
  id: AsProfileId | undefined
): string[] {
  if (id === undefined) return [...scopes]
  return [...new Set([...scopes, ...asProfileById(id).requiredScopes])]
}

type ScopeClass = 'invalid' | 'oidc' | 'blocked-guid' | 'guid' | 'host-url' | 'foreign'

/** The `entra-v2` audience rule, applied to one scope; `host` is the MCP server's hostname. */
function classifyEntraScope(scope: string, host: string): { kind: ScopeClass; guid?: string } {
  if (!SCOPE_TOKEN_RE.test(scope)) return { kind: 'invalid' }
  if (OIDC_SCOPES.has(scope)) return { kind: 'oidc' }
  const guidForm = GUID_SCOPE_RE.exec(scope)
  if (guidForm) {
    const guid = guidForm[2]
    if (ENTRA_BLOCKED_RESOURCE_APPS.has(guid)) return { kind: 'blocked-guid', guid }
    // A known API has one legitimate host, so on any other host its token is a leak, not
    // something the operator could confirm; this also catches a base URL edited after the
    // install, which the runtime re-check classifies with the same rule.
    const knownHost = ENTRA_KNOWN_RESOURCE_APPS.get(guid)
    return { kind: knownHost === undefined || knownHost === host ? 'guid' : 'foreign', guid }
  }
  // A literal prefix, never `new URL`: WHATWG parsing accepts userinfo and a port, so
  // `api://<graph-guid>@<host>/x` would otherwise report the MCP host.
  if (scope.startsWith(`https://${host}/`) || scope.startsWith(`api://${host}/`)) {
    return { kind: 'host-url' }
  }
  return { kind: 'foreign' }
}

function isRejected(kind: ScopeClass): boolean {
  return kind === 'invalid' || kind === 'blocked-guid' || kind === 'foreign'
}

/**
 * The first scope that breaks the profile's audience rule, or null. `null` too without a
 * profile. An empty scope is itself a violation and comes back as `''`, so callers must
 * test `!== null`, never truthiness.
 */
export function profileScopeViolation(
  id: AsProfileId | undefined,
  mcpBaseUrl: string,
  scopes: readonly string[]
): string | null {
  if (id === undefined) return null
  const host = new URL(mcpBaseUrl).hostname
  return scopes.find(scope => isRejected(classifyEntraScope(scope, host).kind)) ?? null
}

/** False when, with a profile, no scope names a resource (only OIDC scopes → a Microsoft Graph token). True without a profile. */
export function profileHasResourceScope(
  id: AsProfileId | undefined,
  mcpBaseUrl: string,
  scopes: readonly string[]
): boolean {
  if (id === undefined) return true
  const host = new URL(mcpBaseUrl).hostname
  return scopes.some(scope => {
    const { kind } = classifyEntraScope(scope, host)
    return kind === 'guid' || kind === 'host-url'
  })
}

/**
 * Scopes in GUID form whose API the platform does not know, so it cannot tie them to the
 * MCP host: accepted only when the operator confirms each one. A known API on another
 * host is a violation instead. Empty without a profile. Order kept, no duplicates.
 */
export function profileUnverifiedScopes(
  id: AsProfileId | undefined,
  mcpBaseUrl: string,
  scopes: readonly string[]
): string[] {
  if (id === undefined) return []
  const host = new URL(mcpBaseUrl).hostname
  const unverified = scopes.filter(scope => {
    const { kind, guid } = classifyEntraScope(scope, host)
    return kind === 'guid' && !ENTRA_KNOWN_RESOURCE_APPS.has(guid as string)
  })
  return [...new Set(unverified)]
}

export function isEntraMultiTenantAuthority(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    url.hostname === ENTRA_LOGIN_HOST &&
    url.port === '' &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === '' &&
    ENTRA_MULTI_TENANT_PATHS.has(url.pathname.replace(/\/+$/, ''))
  )
}

/** True for exactly `https://login.microsoftonline.com/<lower-case guid>/v2.0` (no trailing slash, query, fragment, port or userinfo). */
export function isEntraTenantAuthority(value: string): boolean {
  return detectAsProfile(value) !== null
}
