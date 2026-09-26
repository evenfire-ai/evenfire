'use client'

import { apiSend } from './api'
import { isValidK8sName } from './k8sValidation'
import type {
  DiscoverRemoteResponse,
  InstallRemoteRequest,
  InstallRemoteResponse,
  InstallTransportUnreachableDetail,
  RemoteClientMode,
  RemoteDetected,
  RemoteDiscoveryErrorKind,
  RemoteInstallMode,
  RemoteRegistrationMode,
  RemoteTransportProbe,
} from './remoteMcp.types'

/** Real admin prefix for the remote MCP-OAuth routes (control-api). */
export const REMOTE_MCP_BASE = '/api/v1/admin/mcp-servers/remote'

// ── API client (matches lib/api.ts; apiSend attaches the admin bearer) ───────

/**
 * Dry-run discovery for `baseUrl`. Resolves to the full discover response — the
 * `detected` OAuth prefill plus the optional MCP `transport` probe — or throws
 * the `apiSend` error (whose `.code`/`.body` carry the discovery-error detail).
 */
export async function discoverRemoteServer(baseUrl: string): Promise<DiscoverRemoteResponse> {
  return (await apiSend('POST', `${REMOTE_MCP_BASE}/discover`, {
    baseUrl,
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
  kind: RemoteDiscoveryErrorKind | string | undefined
): string {
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
    default:
      return 'OAuth discovery failed for this server.'
  }
}

function discoveryDetailKind(body: Record<string, unknown> | undefined): string | undefined {
  const detail = body?.detail
  if (detail && typeof detail === 'object') {
    const kind = (detail as { kind?: unknown }).kind
    if (typeof kind === 'string') return kind
  }
  return undefined
}

/**
 * Map a discover-step failure (from `discoverRemoteServer`) to UI copy. Covers
 * the typed `discovery_failed` union and the kernel §4 pre-check 400 (whose
 * `error` is a plain message, surfaced verbatim).
 */
export function mapRemoteDiscoverError(error: unknown): string {
  const e = asCodedError(error)
  if (e.code === 'discovery_failed') {
    return describeDiscoveryError(discoveryDetailKind(e.body))
  }
  // Kernel §4 400: `{ error: '<message>', errors }`. formatApiError surfaces the
  // message in `.message`; fall back to it (or a generic line).
  return e.message?.trim() || 'Could not detect the remote server. Check the URL and try again.'
}

/** Map an install-step failure to UI copy across the documented error codes. */
export function mapRemoteInstallError(error: unknown): string {
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
    case 'dcr_registration_failed':
      return `Dynamic client registration failed at the authorization server${
        discoveryDetailKind(body) ? ` (${discoveryDetailKind(body)})` : ''
      }.`
    case 'dcr_persist_failed':
      return 'The client was registered but its credentials could not be stored. Nothing was installed — please try again.'
    case 'callback_base_url_unconfigured':
      return 'The public OAuth callback URL is not configured on this deployment. Set it before installing a remote OAuth server.'
    case 'discovery_failed':
      // D-7: install re-runs discovery server-side, so a discover-time failure
      // reappears here with the same detail kind.
      return describeDiscoveryError(discoveryDetailKind(body))
    case 'invalid_request':
      return 'The install request was rejected as invalid. Reload the page and try again.'
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
  return body
}

type RemoteGrantScopeInput = InstallRemoteRequest['grantScope']
