'use client'

import { apiSend } from './api'
import { isValidK8sName } from './k8sValidation'
import type {
  DiscoverRemoteResponse,
  InstallRemoteRequest,
  InstallRemoteResponse,
  InstallTransportUnreachableDetail,
  RemoteCallbackPreview,
  RemoteCallbackVariant,
  RemoteClientIdConflict,
  RemoteClientMode,
  RemoteDcrRejectionKind,
  RemoteDetected,
  RemoteDiscoveryErrorKind,
  RemoteInstallMode,
  RemoteRegistrationMode,
  RemoteTenantRequiredDetail,
  RemoteTransportProbe,
} from './remoteMcp.types'

/** Real admin prefix for the remote MCP-OAuth routes (control-api). */
export const REMOTE_MCP_BASE = '/api/v1/admin/mcp-servers/remote'

// ── API client (matches lib/api.ts; apiSend attaches the admin bearer) ───────

/**
 * Dry-run discovery for `baseUrl`. Resolves to the full discover response — the
 * `detected` OAuth prefill plus the optional MCP `transport` probe — or throws
 * the `apiSend` error (whose `.code`/`.body` carry the discovery-error detail).
 * `authorizationServer` is the Entra tenant authority, sent only after a
 * `tenant_required` answer.
 */
export async function discoverRemoteServer(
  baseUrl: string,
  authorizationServer?: string
): Promise<DiscoverRemoteResponse> {
  return (await apiSend('POST', `${REMOTE_MCP_BASE}/discover`, {
    baseUrl,
    ...(authorizationServer ? { authorizationServer } : {}),
  })) as DiscoverRemoteResponse
}

/** Transactional install saga. Resolves to the names-only summary (201). */
export async function installRemoteServer(
  body: InstallRemoteRequest
): Promise<InstallRemoteResponse> {
  return (await apiSend('POST', REMOTE_MCP_BASE, body)) as InstallRemoteResponse
}

// ── Pure decision logic (D-3/D-5/D-7/D-8), tested independently ───────────────

/**
 * D-3 / D-7: map the AS-resolved registration mode to the install mode.
 * Authority is the backend `registrationMode`; the UI never re-orders it.
 *   cimd → cimd (public client, no credentials)
 *   dcr → dcr (backend registers + manages the client, incl. its secret)
 *   manual → pre-registered (D-7: the only supported degradation is an
 *            operator-supplied pre-registered confidential client)
 *   pre-registered → pre-registered (install-only echo; kept total)
 */
export function installModeForRegistration(mode: RemoteRegistrationMode): RemoteInstallMode {
  switch (mode) {
    case 'cimd':
      return 'cimd'
    case 'dcr':
      return 'dcr'
    case 'manual':
    case 'pre-registered':
      return 'pre-registered'
  }
}

/**
 * D-5: only the pre-registered (manual-degraded) mode asks the operator for a
 * client_id/client_secret. CIMD is public; DCR credentials are backend-managed.
 */
export function requiresPreRegisteredCredentials(mode: RemoteInstallMode): boolean {
  return mode === 'pre-registered'
}

/**
 * D-8: show the persistent re-consent warning iff the AS does not support token
 * refresh. Fail-closed — an absent/false `supportsRefresh` warns.
 */
export function shouldWarnNoRefresh(detected: Pick<RemoteDetected, 'quirks'>): boolean {
  return detected.quirks.supportsRefresh === false
}

/**
 * Whether the MCP transport probe forbids advancing/installing. Only a proven
 * `dead` path (404/405) blocks; `inconclusive` and `alive` never do, and an
 * absent probe (older control-api) never blocks (D3 fail-open).
 */
export function transportBlocksContinue(transport?: RemoteTransportProbe): boolean {
  return transport?.status === 'dead'
}

/**
 * Operator-facing copy for a transport probe. `dead` explains the path serves no
 * MCP (and names the canonical URL when one was verified); `inconclusive`
 * reassures that install can still proceed. `alive` has no banner — the confirm
 * step shows a reachable summary row instead — so it maps to an empty string.
 */
export function describeTransportProbe(transport: RemoteTransportProbe): string {
  switch (transport.status) {
    case 'alive':
      return ''
    case 'dead':
      return transport.suggestedBaseUrl
        ? `OAuth works here, but this URL's MCP endpoint returned ${transport.httpStatus} — nothing is serving MCP at that path. This server's MCP endpoint looks like ${transport.suggestedBaseUrl}.`
        : `OAuth works here, but this URL's MCP endpoint returned ${transport.httpStatus} — nothing is serving MCP at that path. Double-check the URL path.`
    case 'inconclusive':
      switch (transport.reason) {
        case 'timeout':
          return "Couldn't confirm the MCP endpoint — the probe timed out. You can still install; the connector will verify it on first use."
        case 'transport_failed':
          return "Couldn't reach the MCP endpoint to confirm it. You can still install; the connector will verify it on first use."
        case 'redirect':
          return "The MCP endpoint redirected the probe, so it couldn't be confirmed here. You can still install; the connector follows redirects at runtime."
        case 'unexpected_status':
          return transport.httpStatus
            ? `The MCP endpoint returned an unexpected status (${transport.httpStatus}), so it couldn't be confirmed. You can still install.`
            : "The MCP endpoint returned an unexpected response, so it couldn't be confirmed. You can still install."
        case 'content_encoding_rejected':
          return "The MCP endpoint's response encoding couldn't be inspected, so it couldn't be confirmed. You can still install."
        case 'kernel_rejected':
          return "The MCP endpoint couldn't be probed under the security policy. You can still install."
      }
  }
}

/**
 * The client mode to display on the confirm step. Pre-registered is always
 * confidential; CIMD is always public; DCR carries the AS-derived mode in its
 * `dcr` block (default to confidential when the block is somehow absent).
 */
export function displayClientMode(detected: RemoteDetected): RemoteClientMode {
  const installMode = installModeForRegistration(detected.registrationMode)
  if (installMode === 'pre-registered') return 'confidential'
  if (installMode === 'cimd') return 'public'
  return detected.dcr?.clientMode ?? 'confidential'
}

/**
 * Validate the operator-typed server name as a Kubernetes resource name, mirror
 * of the connector-create form. Returns '' when acceptable, else a message.
 * The client uses the stricter RFC1123 DNS label (≤63) — always a subset of the
 * server's acceptance, so a name that passes here never 400s on the name check.
 */
export function getRemoteServerNameError(name: string): string {
  if (!name.trim()) return 'Server name is required.'
  if (!isValidK8sName(name)) {
    return 'Server name must be a valid Kubernetes name: lowercase letters, numbers, and hyphens, starting and ending alphanumeric, max 63 characters.'
  }
  return ''
}

/**
 * The callback variant an install would use. Authority is the backend `callback`
 * preview; a control-api older than it is read with the backend's own rule (shared
 * iff the AS returns `iss`), which that version can only install on the shared path.
 */
export function remoteCallbackVariant(
  discovery: Pick<DiscoverRemoteResponse, 'callback' | 'detected'>
): RemoteCallbackVariant {
  if (discovery.callback) return discovery.callback.variant
  return discovery.detected.issForCallback ? 'shared' : 'per-server'
}

/**
 * Why the detected configuration cannot be installed from here, or '' when it can.
 * A per-server install needs a configured callback origin (control-api answers 503
 * otherwise). A control-api older than the callback preview has no per-server
 * callback at all and rejects every install against an AS without RFC 9207.
 */
export function remoteCallbackBlocker(
  discovery: Pick<DiscoverRemoteResponse, 'callback' | 'detected'>
): string {
  if (remoteCallbackVariant(discovery) !== 'per-server') return ''
  const { callback } = discovery
  if (!callback) {
    return 'This authorization server does not support RFC 9207, and this control-api version can only install servers that do. Update control-api to install it with a redirect URI of its own.'
  }
  if (!callback.configured) {
    return 'The public OAuth callback URL is not configured on this deployment (CONTROL_API_OAUTH_CALLBACK_BASE_URL, a bare origin). This authorization server needs a redirect URI of its own, so it cannot be installed until that is set.'
  }
  return ''
}

/**
 * The redirect URI the operator registers at the provider for a pre-registered
 * client, or null when there is nothing to show yet. The `{serverName}` placeholder
 * is filled only with a name that passes the wizard's validation, and a template
 * still carrying `{installId}` is DCR-only (registered by control-api itself).
 */
export function remotePreRegisteredRedirectUri(
  callback: RemoteCallbackPreview | undefined,
  serverName: string
): string | null {
  const template = callback?.configured ? callback.redirectUriTemplate : undefined
  if (!template || template.includes('{installId}')) return null
  if (!template.includes('{serverName}')) return template
  if (getRemoteServerNameError(serverName) !== '') return null
  return template.split('{serverName}').join(serverName)
}

/**
 * Client-side FORM validation for the remote wizard's base URL (UX only — control-api
 * returns the authoritative 422 and its SSRF guard is what blocks a hostile target).
 * Returns '' when acceptable, else a message. Mirrors the generic lane's endpoint
 * check (absolute https, fully-qualified host, no spaces) so an obviously malformed
 * URL is caught before the detect round-trip rather than after it. Remote requires
 * https to match the CRD's `remote.baseUrl` constraint.
 */
export function getRemoteBaseUrlError(raw: string): string {
  const value = raw.trim()
  if (!value) return 'Remote server URL is required.'
  if (/\s/.test(value)) return 'Remote server URL must not contain spaces.'
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return 'Remote server URL must be an absolute https URL.'
  }
  if (parsed.protocol !== 'https:') return 'Remote server URL must use https.'
  if (!parsed.hostname.includes('.')) {
    return 'Remote server URL must have a fully-qualified hostname.'
  }
  return ''
}

// RFC 6749 §3.3 scope-token. Commas are legal inside a scope, so — unlike the generic
// lane's parser — remote scopes split on whitespace only.
const SCOPE_TOKEN_RE = /^[\x21\x23-\x5B\x5D-\x7E]+$/
const ENTRA_TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Validate the operator-typed Microsoft Entra tenant ID. Only the GUID form works:
 * Entra reports the issuer with the GUID, so a domain name could never match it.
 */
export function getEntraTenantIdError(raw: string): string {
  const value = raw.trim()
  if (!value) return 'Tenant ID is required.'
  if (!ENTRA_TENANT_ID_RE.test(value)) {
    return 'Enter the tenant ID as a GUID (Directory (tenant) ID in the Microsoft Entra admin center), not a domain name.'
  }
  return ''
}

/**
 * Fill the backend's tenant authority template. control-api accepts only the lower-case
 * GUID, so the tenant is normalised here.
 */
export function tenantAuthority(template: string, tenantId: string): string {
  return template.split('{tenantId}').join(tenantId.trim().toLowerCase())
}

/**
 * Parse the space-separated scopes field. An empty field yields no scopes, which the
 * wizard reads as "use the scopes the server advertises".
 */
export function parseRemoteScopesInput(
  raw: string,
  maxScopes: number
): { scopes: string[] } | { error: string } {
  const scopes = [...new Set(raw.split(/\s+/).filter(Boolean))]
  const invalid = scopes.find(scope => !SCOPE_TOKEN_RE.test(scope))
  if (invalid !== undefined) {
    return { error: `Scope "${invalid}" contains characters OAuth does not allow.` }
  }
  if (scopes.length > maxScopes) return { error: `At most ${maxScopes} scopes.` }
  return { scopes }
}

/** The scopes to send on install: undefined when the input is empty or equals the detected list (same order). */
export function remoteScopesOverride(parsed: string[], detected: string[]): string[] | undefined {
  if (parsed.length === 0) return undefined
  const same =
    parsed.length === detected.length && parsed.every((scope, i) => scope === detected[i])
  return same ? undefined : parsed
}

/**
 * The `tenant_required` detail of a discover failure, or null for any other error. The
 * wizard answers it with the tenant prompt instead of an error banner.
 */
export function tenantRequiredDetail(error: unknown): RemoteTenantRequiredDetail | null {
  const e = asCodedError(error)
  if (e.code !== 'discovery_failed') return null
  const detail = e.body?.detail
  if (!detail || typeof detail !== 'object') return null
  const d = detail as Record<string, unknown>
  if (
    d.kind !== 'tenant_required' ||
    typeof d.authorizationServer !== 'string' ||
    typeof d.tenantAuthorityTemplate !== 'string'
  ) {
    return null
  }
  return {
    kind: 'tenant_required',
    authorizationServer: d.authorizationServer,
    tenantAuthorityTemplate: d.tenantAuthorityTemplate,
    detail: typeof d.detail === 'string' ? d.detail : '',
  }
}

/** `scopes` of a 400 scope_audience_unverified install error (strings only), or null for any other error. */
export function unverifiedScopesFromInstallError(error: unknown): string[] | null {
  const e = asCodedError(error)
  if (e.code !== 'scope_audience_unverified') return null
  const scopes = e.body?.scopes
  if (!Array.isArray(scopes)) return null
  const strings = scopes.filter((scope): scope is string => typeof scope === 'string')
  return strings.length > 0 ? strings : null
}

// ── Error mapping to human-readable UI text ──────────────────────────────────

type CodedError = {
  status?: number
  code?: string
  message?: string
  body?: Record<string, unknown>
}

function asCodedError(error: unknown): CodedError {
  if (error && typeof error === 'object') {
    const e = error as CodedError
    return { status: e.status, code: e.code, message: e.message, body: e.body }
  }
  return { message: String(error) }
}

/** Human copy for a `discovery_failed` detail kind (used by discover + install). */
export function describeDiscoveryError(
  kind: RemoteDiscoveryErrorKind | string | undefined,
  field?: string
): string {
  if (kind === 'as_endpoints_cross_site') return describeCrossSite(field)
  switch (kind) {
    case 'fetch_failed':
      return "Couldn't reach the server to read its OAuth metadata. Check the URL and that the host is publicly reachable."
    case 'content_encoding_rejected':
      return 'The server responded with an unsupported content encoding, so its OAuth metadata could not be read safely.'
    case 'kernel_rejected':
      return 'The server URL was rejected by the security policy (it resolves to a private, blocked, or non-HTTPS address).'
    case 'invalid_metadata':
      return "The server's OAuth metadata is missing or malformed."
    case 'no_s256':
      return "The authorization server does not advertise PKCE S256, which is required. This server can't be installed."
    case 'no_authorization_server':
      return 'The server does not point to an OAuth authorization server, so it cannot be installed as a remote OAuth connector.'
    case 'redirect_blocked':
      return 'A redirect while reading the OAuth metadata was blocked by the security policy.'
    case 'prm_resource_mismatch':
      return "The server's protected-resource metadata is inconsistent with its own URL."
    case 'issuer_mismatch':
      return "The authorization server's issuer does not match the address it was fetched from."
    case 'tenant_required':
      return "This server signs in with Microsoft Entra ID through a multi-tenant authority. Enter your organization's tenant ID to continue."
    case 'authorization_server_override_rejected':
      return "This server doesn't accept a Microsoft Entra tenant sign-in address. Check the server URL."
    default:
      return 'OAuth discovery failed for this server.'
  }
}

/**
 * Without RFC 9207 every AS endpoint must share the issuer's registrable domain.
 * `field` names what failed: the issuer itself (a public suffix, IP literal or URL
 * with credentials has no domain to compare against) or one endpoint, which is then
 * either on another domain or has none.
 */
function describeCrossSite(field: string | undefined): string {
  const why =
    'It does not identify itself in OAuth responses (RFC 9207), so the connector only trusts endpoints on the issuer’s own domain, and this server cannot be installed.'
  if (field === 'issuer') {
    return `The authorization server's issuer has no registrable domain of its own (it is a shared hosting suffix, an IP address, or carries credentials). ${why}`
  }
  const subject = field ? `${field} endpoint is` : 'endpoints are'
  return `The authorization server's ${subject} not on the issuer's domain. ${why}`
}

function discoveryDetailKind(body: Record<string, unknown> | undefined): string | undefined {
  return detailString(body, 'kind')
}

function detailString(
  body: Record<string, unknown> | undefined,
  key: 'kind' | 'field'
): string | undefined {
  const detail = body?.detail
  if (detail && typeof detail === 'object') {
    const value = (detail as Record<string, unknown>)[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

const ENTRA_LOGIN_ORIGIN = 'https://login.microsoftonline.com/'

/** Entra answers the metadata of a tenant it does not know with a 400. */
function isUnknownEntraTenant(body: Record<string, unknown> | undefined): boolean {
  const detail = body?.detail
  if (!detail || typeof detail !== 'object') return false
  const d = detail as Record<string, unknown>
  return (
    d.kind === 'fetch_failed' &&
    d.status === 400 &&
    typeof d.url === 'string' &&
    d.url.startsWith(ENTRA_LOGIN_ORIGIN)
  )
}

function describeDiscoveryFailure(body: Record<string, unknown> | undefined): string {
  if (isUnknownEntraTenant(body)) {
    return 'Microsoft Entra ID did not recognize this tenant ID. Check the Directory (tenant) ID and try again.'
  }
  return describeDiscoveryError(discoveryDetailKind(body), detailString(body, 'field'))
}

/** Copy for a DCR response refused after the client was minted (and revoked). */
function describeDcrRejection(kind: RemoteDcrRejectionKind): string {
  switch (kind) {
    case 'redirect_uris_mismatch':
      return 'The authorization server registered a different redirect URI than the one requested, so the new client was discarded and nothing was installed.'
    case 'redirect_uris_missing':
      return "The authorization server did not confirm the redirect URI it registered, which this server's own callback requires, so the new client was discarded and nothing was installed."
    case 'client_id_is_cimd_identity':
      return "The authorization server returned this platform's CIMD identity as the new client ID, so the client was discarded and nothing was installed."
  }
}

const DCR_REJECTION_KINDS: readonly string[] = [
  'redirect_uris_mismatch',
  'redirect_uris_missing',
  'client_id_is_cimd_identity',
] satisfies readonly RemoteDcrRejectionKind[]

function describeClientIdConflict(conflict: unknown): string {
  switch (conflict as RemoteClientIdConflict) {
    case 'remote_server':
      return 'This client ID is already used by another remote server. Register a separate OAuth client for this server at the provider, with its own redirect URI.'
    case 'dynamic_client':
      return 'This client ID belongs to a client this platform registered dynamically. Register a separate OAuth client for this server at the provider.'
    case 'cimd_client':
      return "This client ID is the platform's CIMD identity, which cannot back a single server. Register a separate OAuth client for this server at the provider."
    default:
      return 'This client ID already backs another client. Register a separate OAuth client for this server at the provider.'
  }
}

/**
 * Map a discover-step failure (from `discoverRemoteServer`) to UI copy. Covers
 * the typed `discovery_failed` union and the kernel §4 pre-check 400 (whose
 * `error` is a plain message, surfaced verbatim).
 */
export function mapRemoteDiscoverError(error: unknown): string {
  const e = asCodedError(error)
  if (e.code === 'discovery_failed') {
    return describeDiscoveryFailure(e.body)
  }
  if (e.code === 'invalid_request') {
    return 'The request was rejected as invalid. Reload the page and try again.'
  }
  // Kernel §4 400: `{ error: '<message>', errors }`. formatApiError surfaces the
  // message in `.message`; fall back to it (or a generic line).
  return e.message?.trim() || 'Could not detect the remote server. Check the URL and try again.'
}

/**
 * Map an install-step failure to UI copy across the documented error codes.
 * `callbackVariant` is the variant the wizard previewed, when control-api reported one.
 */
export function mapRemoteInstallError(
  error: unknown,
  context: { callbackVariant?: RemoteCallbackVariant } = {}
): string {
  const e = asCodedError(error)
  const code = e.code
  const body = e.body
  const serverMessage =
    body && typeof body.message === 'string' && body.message.trim() ? body.message.trim() : ''

  switch (code) {
    case 'mode_unsupported':
      // The backend explains exactly which mode the AS actually resolved to.
      return serverMessage || 'The requested registration mode is not supported by this server.'
    case 'auth_method_unsupported':
      return "The authorization server assigned a client authentication method this platform cannot present, so this server can't be installed automatically."
    case 'dcr_registration_failed': {
      const kind = discoveryDetailKind(body)
      if (kind && DCR_REJECTION_KINDS.includes(kind)) {
        return describeDcrRejection(kind as RemoteDcrRejectionKind)
      }
      return `Dynamic client registration failed at the authorization server${
        kind ? ` (${kind})` : ''
      }.`
    }
    case 'dcr_persist_failed':
      return 'The client was registered but its credentials could not be stored. Nothing was installed — please try again.'
    case 'callback_base_url_unconfigured':
      return context.callbackVariant === 'per-server'
        ? 'The public OAuth callback URL is not configured on this deployment (CONTROL_API_OAUTH_CALLBACK_BASE_URL, a bare origin). This authorization server needs a redirect URI of its own, so set it before installing.'
        : 'The public OAuth callback URL is not configured on this deployment. Set CONTROL_API_OAUTH_CALLBACK_BASE_URL (a bare origin) before installing this server.'
    case 'issuer_binding_required':
      return (
        serverMessage ||
        'This authorization server does not advertise RFC 9207, which this install mode requires.'
      )
    case 'oauth_client_id_in_use':
      return describeClientIdConflict(body?.conflict)
    case 'discovery_failed':
      // D-7: install re-runs discovery server-side, so a discover-time failure
      // reappears here with the same detail kind.
      return describeDiscoveryFailure(body)
    case 'invalid_request':
      // Set when the request is well formed but the server refuses it (e.g. a required
      // field for this authorization server, or the scope limit).
      return (
        serverMessage ||
        'The install request was rejected as invalid. Reload the page and try again.'
      )
    case 'scope_audience_mismatch': {
      const scope = typeof body?.scope === 'string' ? body.scope : ''
      return scope
        ? `The scope "${scope}" belongs to another API, so a token for it must not be sent to this server. Remove it or use this server's own scope.`
        : "The scope belongs to another API, so a token for it must not be sent to this server. Remove it or use this server's own scope."
    }
    case 'scope_audience_missing':
      return 'Add this server’s own scope. Sign-in scopes alone (openid, profile, email, offline_access) would send a Microsoft Graph token to the server.'
    case 'scope_audience_unverified':
      // A well-formed answer is turned into the confirmation by the wizard; this copy
      // only covers a body without a usable scope list.
      return 'Some scopes name an API this platform cannot tie to the server. Review the scopes and try again.'
    case 'transport_unreachable': {
      // The MCP transport probe found the typed path dead before any write.
      const detail =
        body?.detail && typeof body.detail === 'object'
          ? (body.detail as Partial<InstallTransportUnreachableDetail>)
          : undefined
      const suggested =
        detail && typeof detail.suggestedBaseUrl === 'string' ? detail.suggestedBaseUrl : ''
      const httpStatus = detail && typeof detail.httpStatus === 'number' ? detail.httpStatus : 404
      return suggested
        ? `This server's MCP endpoint isn't reachable at that URL (HTTP ${httpStatus}). Its MCP endpoint looks like ${suggested} — go back and detect that URL instead.`
        : `This server's MCP endpoint isn't reachable at that URL (HTTP ${httpStatus}). Go back and check the URL.`
    }
    default:
      break
  }

  // Context-not-found and Secret/Context allowlist failures arrive as a plain
  // `{ error: '<string>' }`; formatApiError surfaces that string in `.message`.
  return e.message?.trim() || 'Failed to install the remote server.'
}

// ── Request assembly ─────────────────────────────────────────────────────────

/**
 * Assemble the install request body from wizard state. Credentials are attached
 * only for the pre-registered mode (D-5); grantScope is always sent (default
 * `user`) so the choice is explicit.
 */
export function buildRemoteInstallRequest(input: {
  serverName: string
  contextRef: string
  baseUrl: string
  mode: RemoteInstallMode
  grantScope: RemoteGrantScopeInput
  clientId?: string
  clientSecret?: string
  authorizationServer?: string
  scopes?: string[]
  confirmedUnverifiedScopes?: string[]
}): InstallRemoteRequest {
  const body: InstallRemoteRequest = {
    serverName: input.serverName.trim(),
    contextRef: input.contextRef,
    baseUrl: input.baseUrl.trim(),
    mode: input.mode,
    grantScope: input.grantScope,
  }
  if (input.mode === 'pre-registered') {
    body.clientId = input.clientId?.trim()
    body.clientSecret = input.clientSecret
  }
  if (input.authorizationServer !== undefined) body.authorizationServer = input.authorizationServer
  if (input.scopes !== undefined) body.scopes = input.scopes
  if (input.confirmedUnverifiedScopes && input.confirmedUnverifiedScopes.length > 0) {
    body.confirmedUnverifiedScopes = input.confirmedUnverifiedScopes
  }
  return body
}

type RemoteGrantScopeInput = InstallRemoteRequest['grantScope']
