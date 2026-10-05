/**
 * Producer fixtures — the bodies control-api's remote MCP admin routes return
 * (`POST /admin/mcp-servers/remote/discover` and `POST /admin/mcp-servers/remote`).
 *
 * control-api is not importable from this package, so these are the golden wire files
 * control-api's own route test captures from the real router (real discovery and
 * transport probe over recorded probe bytes, the real install saga):
 * control-api/test/routes.adminRemoteMcp.wireGoldens.test.ts →
 * control-api/test/fixtures/wire/remoteMcp.*.json. Loading the same bytes means a
 * producer change breaks the golden there before it can drift here.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatApiError } from '../../lib/api'
import type {
  DiscoverRemoteResponse,
  InstallRemoteResponse,
  RemoteDetected,
} from '../../lib/remoteMcp.types'

export type WireCapture<T = unknown> = { status: number; body: T }

const WIRE_DIR = resolve(__dirname, '../../../control-api/test/fixtures/wire')

function loadGolden<T>(name: string): WireCapture<T> {
  return JSON.parse(readFileSync(resolve(WIRE_DIR, `remoteMcp.${name}.json`), 'utf8'))
}

// ─── /discover 200 ────────────────────────────────────────────────────────────

/** Linear: CIMD + RFC 9207 → CIMD on the shared callback. */
export const LINEAR_DISCOVER = loadGolden<DiscoverRemoteResponse>('discover.linear').body
/** Notion: CIMD + DCR without RFC 9207 → public DCR on a per-server callback. */
export const NOTION_DISCOVER = loadGolden<DiscoverRemoteResponse>('discover.notion').body
/** Atlassian v2: same as Notion, with the issuer under a path of auth.atlassian.com. */
export const ATLASSIAN_DISCOVER = loadGolden<DiscoverRemoteResponse>('discover.atlassian').body
/** Atlassian v2 on a deployment without a public callback base URL. */
export const ATLASSIAN_DISCOVER_UNCONFIGURED = loadGolden<DiscoverRemoteResponse>(
  'discover.atlassianUnconfigured'
).body
/** Linear on a deployment without a public callback base URL (shared, not blocking). */
export const LINEAR_DISCOVER_UNCONFIGURED = loadGolden<DiscoverRemoteResponse>(
  'discover.linearUnconfigured'
).body
/** Notion minus CIMD and `none` → confidential DCR, per-server. */
export const DCR_CONFIDENTIAL_DISCOVER = loadGolden<DiscoverRemoteResponse>(
  'discover.dcrConfidential'
).body
/** Linear minus registration and RFC 9207 → pre-registered client, per-server. */
export const PRE_REGISTERED_PER_SERVER_DISCOVER = loadGolden<DiscoverRemoteResponse>(
  'discover.preRegisteredPerServer'
).body

export const ALL_DISCOVER_BODIES: ReadonlyArray<{ name: string; body: DiscoverRemoteResponse }> = [
  { name: 'linear', body: LINEAR_DISCOVER },
  { name: 'notion', body: NOTION_DISCOVER },
  { name: 'atlassian', body: ATLASSIAN_DISCOVER },
  { name: 'atlassian-unconfigured', body: ATLASSIAN_DISCOVER_UNCONFIGURED },
  { name: 'linear-unconfigured', body: LINEAR_DISCOVER_UNCONFIGURED },
  { name: 'dcr-confidential', body: DCR_CONFIDENTIAL_DISCOVER },
  { name: 'pre-registered-per-server', body: PRE_REGISTERED_PER_SERVER_DISCOVER },
]

// ─── /discover from a control-api older than the per-server callback ─────────
//
// That version answered the same body minus `callback` and `detected.asEndpointHosts`,
// so it is modelled by removing exactly those two fields from a current golden. Only
// servers whose registration mode did not change between the versions are modelled:
// Linear (CIMD with RFC 9207) and the confidential-DCR Notion variant (no CIMD, so the
// older selector also resolved DCR). Notion and Canva as recorded would have resolved
// CIMD there, so their current goldens cannot stand for the older backend.

function asOlderControlApi(body: DiscoverRemoteResponse): DiscoverRemoteResponse {
  const { callback: _callback, detected, ...rest } = body
  const { asEndpointHosts: _hosts, ...olderDetected } = detected
  return { ...rest, detected: olderDetected }
}

export const OLDER_CONTROL_API_LINEAR_DISCOVER = asOlderControlApi(LINEAR_DISCOVER)
/** An AS without RFC 9207: the older control-api answers 422 to every install mode. */
export const OLDER_CONTROL_API_DCR_DISCOVER = asOlderControlApi(DCR_CONFIDENTIAL_DISCOVER)

export const LINEAR_DETECTED: RemoteDetected = LINEAR_DISCOVER.detected
export const NOTION_DETECTED: RemoteDetected = NOTION_DISCOVER.detected
export const ATLASSIAN_DETECTED: RemoteDetected = ATLASSIAN_DISCOVER.detected
export const DCR_CONFIDENTIAL_DETECTED: RemoteDetected = DCR_CONFIDENTIAL_DISCOVER.detected
export const PRE_REGISTERED_PER_SERVER_DETECTED: RemoteDetected =
  PRE_REGISTERED_PER_SERVER_DISCOVER.detected

// ─── install 201 ──────────────────────────────────────────────────────────────

/** Per-server DCR; `redirectUri` ends in the (pinned) install nonce. */
export const ATLASSIAN_INSTALLED = loadGolden<InstallRemoteResponse>('install.atlassian').body
export const LINEAR_INSTALLED = loadGolden<InstallRemoteResponse>('install.linear').body
/** Installed as `linear-pre` from {@link PRE_REGISTERED_PER_SERVER_DISCOVER}. */
export const PRE_REGISTERED_PER_SERVER_INSTALLED = loadGolden<InstallRemoteResponse>(
  'install.preRegisteredPerServer'
).body

/**
 * Same server name, but the AS started returning `iss` (RFC 9207) after the
 * {@link PRE_REGISTERED_PER_SERVER_DISCOVER} detection: the install lands on the
 * shared callback, so its redirect URI differs from the per-server preview.
 */
export const PRE_REGISTERED_SHARED_INSTALLED = loadGolden<InstallRemoteResponse>(
  'install.preRegisteredShared'
).body

// ─── errors ───────────────────────────────────────────────────────────────────

/** Dropbox: token endpoint on dropboxapi.com, issuer on dropbox.com, no RFC 9207. */
export const DROPBOX_DISCOVER_FAILURE = loadGolden('discover.dropbox')
/** Issuer on a public suffix (`github.io`): no registrable domain to compare against. */
export const ISSUER_PUBLIC_SUFFIX_DISCOVER_FAILURE = loadGolden('discover.issuerPublicSuffix')
export const CLIENT_ID_IN_USE_FAILURE = loadGolden('install.clientIdInUse')
export const DCR_REDIRECT_MISMATCH_FAILURE = loadGolden('install.dcrRedirectMismatch')
/** Vercel: the AS refused DCR with an RFC 6749 error (`invalid_redirect_uri`). */
export const DCR_REGISTRATION_REJECTED_FAILURE = loadGolden('install.dcrRegistrationRejected')
export const CIMD_WITHOUT_ISS_BINDING_FAILURE = loadGolden('install.cimdWithoutIssBinding')
export const CALLBACK_UNCONFIGURED_FAILURE = loadGolden('install.callbackUnconfigured')

/**
 * The error `apiSend` throws for a captured failure: the real `formatApiError` over
 * the golden body, so `.code`/`.body`/`.status` are what the wizard really receives.
 */
export function apiErrorFrom(capture: WireCapture): Error {
  const res = { status: capture.status, statusText: 'Error' } as Response
  return formatApiError(res, JSON.stringify(capture.body))
}
