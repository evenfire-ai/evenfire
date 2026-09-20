import {
  type DnsResolver,
  type ValidationError,
  validateOAuthEndpointUrl,
} from '../http/validateMcpServerSpec.js'
import { type Logger, rootLogger } from '../observability/logger.js'

/**
 * Remote MCP-OAuth discovery client (spec 19 §4/§5 C1, D-3/D-8).
 *
 * Implements the client side of RFC 9728 (Protected Resource Metadata) → RFC 8414
 * (Authorization Server Metadata), carrying RFC 8707 (`resource`) and RFC 9207
 * (`iss`) forward for the exchange/callback. Every URL fetched or pinned passes the
 * policy kernel (`validateOAuthEndpointUrl`, spec §4) BEFORE the fetch — the AS/PRM
 * are third-party data (§0), so discovery is fail-closed on internal/blocked hosts.
 *
 * Nothing here re-discovers at runtime: C1.5 pins the resolved endpoints on the CR.
 */

const DISCOVERY_TIMEOUT_MS = 15_000

/**
 * Max redirect hops discovery follows manually. undici's default
 * `redirect:'follow'` would let an untrusted AS/PRM 3xx us into an internal host
 * (IMDS/cluster) with only the FIRST hop kernel-checked, so we follow by hand and
 * re-validate every hop; this bounds the chain to a fail-closed limit.
 */
const MAX_DISCOVERY_REDIRECTS = 5

// ─── Metadata shapes (third-party data — every field is untrusted) ──────────

export interface ProtectedResourceMetadata {
  resource: string
  authorization_servers?: string[]
  scopes_supported?: string[]
  /** RFC 9728: how the resource accepts the bearer token (D-8 bearer-in-body). */
  bearer_methods_supported?: string[]
  resource_name?: string
  [key: string]: unknown
}

export interface AuthorizationServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  scopes_supported?: string[]
  response_types_supported?: string[]
  grant_types_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
  code_challenge_methods_supported?: string[]
  /** SEP-991: AS accepts a Client ID Metadata Document as the client_id. */
  client_id_metadata_document_supported?: boolean
  /** RFC 9207: AS returns `iss` on the authorization response. */
  authorization_response_iss_parameter_supported?: boolean
  revocation_endpoint?: string
  resource?: string
  resource_metadata?: string
  [key: string]: unknown
}

// ─── Registration mode selection (D-3, pure) ────────────────────────────────

export type RegistrationMode = 'pre-registered' | 'cimd' | 'dcr' | 'manual'

export interface SelectRegistrationModeInput {
  hasPreRegisteredClient: boolean
  cimdSupported: boolean
  tokenEndpointAuthMethods: string[]
  hasRegistrationEndpoint: boolean
}

/**
 * Choose the client-registration mode in the normative order
 * `pre-registered > CIMD > DCR > manual` (D-3), returning the FIRST applicable one.
 *
 * The classic industry bug is inverting this order (Claude Code × Slack), so the
 * ordering is an invariant with a property test (T2): CIMD requires the DOUBLE
 * condition (`cimdSupported` AND `none` ∈ auth methods — a public client); DCR
 * requires a registration endpoint; otherwise the operator registers manually.
 */
export function selectRegistrationMode(input: SelectRegistrationModeInput): RegistrationMode {
  if (input.hasPreRegisteredClient) return 'pre-registered'
  if (input.cimdSupported && input.tokenEndpointAuthMethods.includes('none')) return 'cimd'
  if (input.hasRegistrationEndpoint) return 'dcr'
  return 'manual'
}

// ─── Transport quirks derived from metadata (D-8, pure) ─────────────────────

export interface RemoteQuirks {
  /** Token goes in the request body, not the Authorization header (SEMrush). */
  bearerInBody: boolean
  /** AS advertises `refresh_token` in grant_types — fail-closed on absence. */
  supportsRefresh: boolean
}

/**
 * Derive transport quirks from metadata (D-8).
 *
 * `bearerInBody` is a Protected Resource Metadata property (RFC 9728
 * `bearer_methods_supported`), NOT an AS field. The safe rule: only use the body
 * when the resource does NOT accept the header — i.e. `["body"]` without
 * `"header"`. When the resource advertises `"header"` (the RFC 6750 default) or
 * says nothing, we keep the token in the Authorization header, which is where a
 * bearer belongs unless the resource explicitly refuses it.
 *
 * `supportsRefresh` is fail-closed (invariant 8): a missing `grant_types_supported`
 * or one without `refresh_token` means we never attempt a refresh.
 */
export function deriveQuirks(
  as: AuthorizationServerMetadata,
  prm: ProtectedResourceMetadata
): RemoteQuirks {
  const methods = prm.bearer_methods_supported
  const bearerInBody =
    Array.isArray(methods) && methods.includes('body') && !methods.includes('header')
  const supportsRefresh = as.grant_types_supported?.includes('refresh_token') ?? false
  return { bearerInBody, supportsRefresh }
}

// ─── Discovery flow ─────────────────────────────────────────────────────────

export interface DiscoveryDeps {
  fetchFn: typeof fetch
  resolveDns?: DnsResolver
  logger?: Logger
}

export type DiscoveryError =
  | { kind: 'kernel_rejected'; field: string; errors: ValidationError[] }
  | { kind: 'fetch_failed'; url: string; status?: number; detail: string }
  | { kind: 'invalid_metadata'; url: string; detail: string }
  | { kind: 'no_s256'; detail: string }
  | { kind: 'no_authorization_server'; detail: string }
  /** A redirect the kernel could not clear was blocked (missing/invalid Location, or the hop bound was hit). */
  | { kind: 'redirect_blocked'; url: string; detail: string }
  /** PRM `resource` (RFC 9728 §3.3) is not consistent with the MCP URL it describes. */
  | { kind: 'prm_resource_mismatch'; url: string; detail: string }
  /** AS metadata `issuer` (RFC 8414 §3.3) does not match the AS base it was fetched from. */
  | { kind: 'issuer_mismatch'; detail: string }

export interface DiscoveryResult {
  prm: ProtectedResourceMetadata
  as: AuthorizationServerMetadata
  /** RFC 8707 value to send in authorize + token requests. */
  resource: string
  /** AS issuer (RFC 8414). */
  issuer: string
  /**
   * Issuer to validate the callback `iss` against (RFC 9207), present ONLY when the
   * AS advertises `authorization_response_iss_parameter_supported`. When present,
   * the callback MUST reject a response whose `iss` != this value; when absent, the
   * AS does not return `iss` and there is nothing to compare.
   */
  issForCallback?: string
  /** Endpoints pinned after passing the kernel — safe to persist on the CR (C1.5). */
  endpoints: {
    authorization: string
    token: string
    registration?: string
  }
  registrationMode: RegistrationMode
  quirks: RemoteQuirks
}

export type DiscoveryOutcome =
  | { ok: true; result: DiscoveryResult }
  | { ok: false; error: DiscoveryError }

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/**
 * Kernel-guard a URL and fetch it, following redirects MANUALLY (`redirect:'manual'`).
 *
 * The default `redirect:'follow'` only lets the kernel veto the FIRST hop — undici
 * then follows a `302 Location: http://169.254.169.254/…` from an untrusted AS/PRM
 * (§0) straight to IMDS/an internal host (SSRF). Here every hop — the initial URL
 * AND each `Location` (resolved against the current URL) — passes
 * `validateOAuthEndpointUrl` (§4, DNS-resolved) BEFORE it is fetched. A `Location`
 * the kernel rejects, a missing/invalid `Location`, or exceeding
 * {@link MAX_DISCOVERY_REDIRECTS} is a typed fail-closed error, never followed.
 */
async function guardedFetch(
  url: string,
  field: string,
  deps: DiscoveryDeps
): Promise<
  { ok: true; response: Response; finalUrl: string } | { ok: false; error: DiscoveryError }
> {
  let currentUrl = url
  for (let hop = 0; ; hop++) {
    const errors = await validateOAuthEndpointUrl(currentUrl, field, {
      resolveDns: deps.resolveDns,
    })
    if (errors.length > 0) {
      return { ok: false, error: { kind: 'kernel_rejected', field, errors } }
    }
    let response: Response
    try {
      response = await deps.fetchFn(currentUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      })
    } catch (e) {
      return { ok: false, error: { kind: 'fetch_failed', url: currentUrl, detail: errMessage(e) } }
    }
    if (!isRedirectStatus(response.status)) {
      return { ok: true, response, finalUrl: currentUrl }
    }
    if (hop >= MAX_DISCOVERY_REDIRECTS) {
      return {
        ok: false,
        error: {
          kind: 'redirect_blocked',
          url: currentUrl,
          detail: `exceeded ${MAX_DISCOVERY_REDIRECTS} redirects`,
        },
      }
    }
    const location = response.headers.get('location')
    if (!location) {
      return {
        ok: false,
        error: {
          kind: 'redirect_blocked',
          url: currentUrl,
          detail: `HTTP ${response.status} redirect without a Location header`,
        },
      }
    }
    try {
      currentUrl = new URL(location, currentUrl).toString()
    } catch {
      return {
        ok: false,
        error: {
          kind: 'redirect_blocked',
          url: currentUrl,
          detail: 'redirect Location is not a valid URL',
        },
      }
    }
  }
}

/**
 * Kernel-guard a URL and only then fetch it as JSON, following redirects through
 * the kernel (see {@link guardedFetch}). Structurally guarantees the spec §4
 * invariant: `validateOAuthEndpointUrl` runs BEFORE every `fetchFn`, and a URL the
 * kernel rejects is never fetched.
 */
async function guardedFetchJson(
  url: string,
  field: string,
  deps: DiscoveryDeps
): Promise<{ ok: true; json: unknown } | { ok: false; error: DiscoveryError }> {
  const fetched = await guardedFetch(url, field, deps)
  if (!fetched.ok) return fetched
  const { response, finalUrl } = fetched
  if (!response.ok) {
    return {
      ok: false,
      error: {
        kind: 'fetch_failed',
        url: finalUrl,
        status: response.status,
        detail: `HTTP ${response.status}`,
      },
    }
  }
  try {
    return { ok: true, json: await response.json() }
  } catch (e) {
    return { ok: false, error: { kind: 'invalid_metadata', url: finalUrl, detail: errMessage(e) } }
  }
}

/**
 * Extract the `resource_metadata` hint from a `WWW-Authenticate` challenge
 * (RFC 9728 §5.1). The value is third-party data — the caller kernel-guards it
 * before fetching.
 */
export function parseResourceMetadataChallenge(
  header: string | null | undefined
): string | undefined {
  if (!header) return undefined
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header)
  return match?.[1]
}

/**
 * Build the RFC 9728 §3.1 well-known PRM URL candidates for an MCP URL. Root form
 * for a resource without a path (Notion/Canva); path-suffixed for a resource with a
 * path (Sentry serves only this form; Linear serves both). Both are tried, in the
 * order most likely to hit for the given path.
 */
export function wellKnownPrmUrls(mcpUrl: URL): string[] {
  const path = mcpUrl.pathname.replace(/\/+$/, '')
  const root = `${mcpUrl.origin}/.well-known/oauth-protected-resource`
  if (path === '') return [root]
  // Path-suffixed inserts the well-known between host and path.
  return [`${root}${path}`, root]
}

/**
 * Build the RFC 8414 AS-metadata URL candidates for an authorization server URL.
 * `oauth-authorization-server` first, then the OIDC `openid-configuration` fallback.
 *
 * The two forms differ when the AS URL carries a path (RFC 8414 §3.1 vs §5):
 * `oauth-authorization-server` is path-INSERTED between host and path
 * (`{host}/.well-known/oauth-authorization-server{path}`), while OIDC
 * `openid-configuration` is path-APPENDED after the issuer including its path
 * (`{host}{path}/.well-known/openid-configuration`). For a path-less AS both
 * collapse to the root form.
 */
export function asMetadataUrls(asUrl: URL): string[] {
  const path = trimmedPath(asUrl)
  const oauthInserted =
    path === ''
      ? `${asUrl.origin}/.well-known/oauth-authorization-server`
      : `${asUrl.origin}/.well-known/oauth-authorization-server${path}`
  const oidcAppended =
    path === ''
      ? `${asUrl.origin}/.well-known/openid-configuration`
      : `${asUrl.origin}${path}/.well-known/openid-configuration`
  return [oauthInserted, oidcAppended]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Path with any trailing slashes stripped (so `/mcp/` and `/mcp` compare equal). */
function trimmedPath(url: URL): string {
  return url.pathname.replace(/\/+$/, '')
}

/**
 * RFC 9728 §3.3: the PRM `resource` must be the resource the metadata describes.
 * A hostile PRM could otherwise name a *different* resource and make us carry that
 * value as the RFC 8707 `resource`, minting tokens scoped to another destination.
 *
 * Consistency = same origin AND the MCP URL path is within the resource path: the
 * `resource` is either the bare origin (path empty — Notion `https://mcp.notion.com`
 * for MCP `…/mcp`) or a path prefix of the MCP URL at a segment boundary (Linear
 * `…/mcp` for MCP `…/mcp`). A cross-origin or unrelated-path `resource` is rejected.
 */
function isResourceConsistentWithMcpUrl(resource: string, mcpUrl: URL): boolean {
  let resourceUrl: URL
  try {
    resourceUrl = new URL(resource)
  } catch {
    return false
  }
  if (resourceUrl.origin !== mcpUrl.origin) return false
  const resPath = trimmedPath(resourceUrl)
  if (resPath === '') return true
  const mcpPath = trimmedPath(mcpUrl)
  return mcpPath === resPath || mcpPath.startsWith(`${resPath}/`)
}

/**
 * RFC 8414 §3.3: the AS metadata `issuer` must be identical to the authorization
 * server it was retrieved from. Otherwise a hostile AS response could hand us an
 * `issuer` we then trust for the RFC 9207 callback `iss` check. Compared as
 * origin+path with trailing slashes normalized.
 */
function isIssuerConsistentWithBase(issuer: string, base: URL): boolean {
  let issuerUrl: URL
  try {
    issuerUrl = new URL(issuer)
  } catch {
    return false
  }
  return issuerUrl.origin === base.origin && trimmedPath(issuerUrl) === trimmedPath(base)
}

/**
 * Resolve the Protected Resource Metadata for an MCP server URL: prefer the
 * `WWW-Authenticate: resource_metadata` hint from a 401 probe, then fall back to
 * the RFC 9728 well-known candidates. Every candidate URL (including the untrusted
 * hint) passes the kernel before it is fetched.
 */
async function resolvePrm(
  mcpUrl: string,
  deps: DiscoveryDeps
): Promise<{ ok: true; prm: ProtectedResourceMetadata } | { ok: false; error: DiscoveryError }> {
  let parsed: URL
  try {
    parsed = new URL(mcpUrl)
  } catch {
    return {
      ok: false,
      error: {
        kind: 'invalid_metadata',
        url: mcpUrl,
        detail: 'mcpUrl is not a valid absolute URL',
      },
    }
  }

  const candidates: string[] = []

  // Best-effort probe for the challenge hint. The probe URL is kernel-guarded
  // first; a probe failure is non-fatal — the well-known candidates follow.
  const probeGuard = await validateOAuthEndpointUrl(mcpUrl, 'mcpUrl', {
    resolveDns: deps.resolveDns,
  })
  if (probeGuard.length > 0) {
    return { ok: false, error: { kind: 'kernel_rejected', field: 'mcpUrl', errors: probeGuard } }
  }
  try {
    // `redirect:'manual'`: the probe URL is kernel-guarded above, but a 3xx from an
    // untrusted MCP server must NOT be auto-followed to an internal host. A redirect
    // simply yields no 401 hint here — the kernel-guarded well-known candidates below
    // are the fallback.
    const probe = await deps.fetchFn(mcpUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    })
    if (probe.status === 401) {
      const hint = parseResourceMetadataChallenge(probe.headers.get('www-authenticate'))
      if (hint) candidates.push(hint)
    }
  } catch {
    // Probe failure is expected for some servers; fall back to well-known.
  }

  for (const wk of wellKnownPrmUrls(parsed)) {
    if (!candidates.includes(wk)) candidates.push(wk)
  }

  let lastError: DiscoveryError = {
    kind: 'fetch_failed',
    url: mcpUrl,
    detail: 'no protected-resource-metadata candidate resolved',
  }
  for (const url of candidates) {
    const fetched = await guardedFetchJson(url, 'prmUrl', deps)
    if (!fetched.ok) {
      lastError = fetched.error
      continue
    }
    if (!isRecord(fetched.json) || typeof fetched.json.resource !== 'string') {
      lastError = { kind: 'invalid_metadata', url, detail: 'PRM missing string "resource"' }
      continue
    }
    // RFC 9728 §3.3: the advertised `resource` must describe the MCP URL we asked
    // about. A mismatch (hostile hint PRM naming another destination) is dropped and
    // the next candidate — a legitimate well-known — is tried.
    if (!isResourceConsistentWithMcpUrl(fetched.json.resource, parsed)) {
      lastError = {
        kind: 'prm_resource_mismatch',
        url,
        detail: `PRM resource "${fetched.json.resource}" is not consistent with MCP URL "${mcpUrl}"`,
      }
      continue
    }
    return { ok: true, prm: fetched.json as ProtectedResourceMetadata }
  }
  return { ok: false, error: lastError }
}

/**
 * Full RFC 9728 → 8414 discovery for a remote MCP server URL. Returns the pinned
 * endpoints, `resource` (RFC 8707), issuer/`iss` handling (RFC 9207), the
 * registration mode (D-3) and transport quirks (D-8). Fail-closed if the AS does
 * not advertise S256 (invariant 3).
 *
 * `hasPreRegisteredClient` reflects operator config (a pre-registered Secret),
 * defaulting to false — the C1 pilots (Notion/Canva/Linear/Sentry) have none and
 * resolve to CIMD.
 */
export async function discoverRemoteOAuth(
  mcpUrl: string,
  deps: DiscoveryDeps,
  opts: { hasPreRegisteredClient?: boolean } = {}
): Promise<DiscoveryOutcome> {
  const log = (deps.logger ?? rootLogger).child({ module: 'oauth-discovery' })

  const prmResult = await resolvePrm(mcpUrl, deps)
  if (!prmResult.ok) {
    log.warn({ discovery: prmResult.error.kind }, 'protected resource metadata discovery failed')
    return { ok: false, error: prmResult.error }
  }
  const prm = prmResult.prm

  const asBase = prm.authorization_servers?.[0]
  if (typeof asBase !== 'string' || asBase.length === 0) {
    return {
      ok: false,
      error: { kind: 'no_authorization_server', detail: 'PRM has no authorization_servers[0]' },
    }
  }

  let asBaseUrl: URL
  try {
    asBaseUrl = new URL(asBase)
  } catch {
    return {
      ok: false,
      error: {
        kind: 'invalid_metadata',
        url: asBase,
        detail: 'authorization_servers[0] is not a valid URL',
      },
    }
  }

  let as: AuthorizationServerMetadata | undefined
  let lastAsError: DiscoveryError = {
    kind: 'fetch_failed',
    url: asBase,
    detail: 'no AS-metadata candidate resolved',
  }
  for (const url of asMetadataUrls(asBaseUrl)) {
    const fetched = await guardedFetchJson(url, 'asMetadataUrl', deps)
    if (!fetched.ok) {
      lastAsError = fetched.error
      continue
    }
    if (!isRecord(fetched.json)) {
      lastAsError = { kind: 'invalid_metadata', url, detail: 'AS metadata is not an object' }
      continue
    }
    const candidate = fetched.json as AuthorizationServerMetadata
    if (
      typeof candidate.issuer !== 'string' ||
      typeof candidate.authorization_endpoint !== 'string' ||
      typeof candidate.token_endpoint !== 'string'
    ) {
      lastAsError = {
        kind: 'invalid_metadata',
        url,
        detail: 'AS metadata missing issuer/authorization_endpoint/token_endpoint',
      }
      continue
    }
    // RFC 8414 §3.3: `issuer` must match the AS we fetched the metadata from. The
    // `issuer` feeds the RFC 9207 callback `iss` check, so a hostile mismatch is
    // rejected here rather than trusted downstream.
    if (!isIssuerConsistentWithBase(candidate.issuer, asBaseUrl)) {
      lastAsError = {
        kind: 'issuer_mismatch',
        detail: `AS issuer "${candidate.issuer}" does not match authorization server "${asBase}"`,
      }
      continue
    }
    as = candidate
    break
  }
  if (!as) {
    log.warn({ discovery: lastAsError.kind }, 'authorization server metadata discovery failed')
    return { ok: false, error: lastAsError }
  }

  // Invariant 3: fail closed unless S256 is advertised (ignore `plain`).
  const challengeMethods = as.code_challenge_methods_supported
  if (!Array.isArray(challengeMethods) || !challengeMethods.includes('S256')) {
    return {
      ok: false,
      error: {
        kind: 'no_s256',
        detail: 'AS does not advertise code_challenge_methods_supported=S256',
      },
    }
  }

  // Kernel-guard every endpoint BEFORE pinning it (spec §4). These are validated
  // (DNS-resolved) but not fetched here — authorize is a browser redirect and
  // token is used at exchange time.
  const endpointChecks: Array<{ field: string; url: string }> = [
    { field: 'spec.oauth.authorizationEndpoint', url: as.authorization_endpoint },
    { field: 'spec.oauth.tokenEndpoint', url: as.token_endpoint },
  ]
  if (typeof as.registration_endpoint === 'string') {
    endpointChecks.push({ field: 'spec.oauth.registrationEndpoint', url: as.registration_endpoint })
  }
  for (const check of endpointChecks) {
    const errors = await validateOAuthEndpointUrl(check.url, check.field, {
      resolveDns: deps.resolveDns,
    })
    if (errors.length > 0) {
      return { ok: false, error: { kind: 'kernel_rejected', field: check.field, errors } }
    }
  }

  const registrationMode = selectRegistrationMode({
    hasPreRegisteredClient: opts.hasPreRegisteredClient ?? false,
    cimdSupported: as.client_id_metadata_document_supported === true,
    tokenEndpointAuthMethods: as.token_endpoint_auth_methods_supported ?? [],
    hasRegistrationEndpoint: typeof as.registration_endpoint === 'string',
  })

  return {
    ok: true,
    result: {
      prm,
      as,
      resource: prm.resource,
      issuer: as.issuer,
      issForCallback:
        as.authorization_response_iss_parameter_supported === true ? as.issuer : undefined,
      endpoints: {
        authorization: as.authorization_endpoint,
        token: as.token_endpoint,
        registration:
          typeof as.registration_endpoint === 'string' ? as.registration_endpoint : undefined,
      },
      registrationMode,
      quirks: deriveQuirks(as, prm),
    },
  }
}
