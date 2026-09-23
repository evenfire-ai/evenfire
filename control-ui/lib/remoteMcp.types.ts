/**
 * Wire types for the remote MCP-OAuth admin endpoints consumed by the
 * "Add remote server" wizard (spec 19 §C5). These mirror EXACTLY the request
 * and response shapes control-api's `/admin/mcp-servers/remote` routes emit
 * (control-api/src/routes/admin/remoteMcp.ts). They are the contract boundary,
 * so they live here rather than inline in the wizard component.
 */

/**
 * Client-registration mode the AS resolves to. The dry-run `/discover` never
 * returns `pre-registered` (that only appears when the install runs with an
 * operator-supplied client), so the discover response is narrowed to the three
 * dry-run values; the install response echoes the full union.
 */
export type RemoteDiscoverRegistrationMode = 'cimd' | 'dcr' | 'manual'
export type RemoteRegistrationMode = RemoteDiscoverRegistrationMode | 'pre-registered'

/** Install mode sent to the install saga. */
export type RemoteInstallMode = 'cimd' | 'pre-registered' | 'dcr'

/** RFC 8707 grant partitioning: a per-user token or a shared per-context one. */
export type RemoteGrantScope = 'user' | 'context'

export type RemoteClientMode = 'public' | 'confidential'

/** DCR sub-block, present in the discover response only when mode is `dcr`. */
export interface RemoteDetectedDcr {
  available: true
  clientMode: RemoteClientMode
  supportsRefresh: boolean
}

export interface RemoteDetectedEndpoints {
  authorization: string
  token: string
  registration?: string
}

export interface RemoteDetectedQuirks {
  /** D-8: token goes in the request body, not the Authorization header. */
  bearerInBody: boolean
  /** D-8: AS advertises refresh; fail-closed false means periodic re-consent. */
  supportsRefresh: boolean
}

/** The `detected` prefill returned by POST /discover (200). */
export interface RemoteDetected {
  registrationMode: RemoteDiscoverRegistrationMode
  dcr?: RemoteDetectedDcr
  endpoints: RemoteDetectedEndpoints
  resource: string
  issuer: string
  issForCallback?: string
  scopes: string[]
  quirks: RemoteDetectedQuirks
}

export interface DiscoverRemoteRequest {
  baseUrl: string
}

export interface DiscoverRemoteResponse {
  detected: RemoteDetected
}

export interface InstallRemoteRequest {
  serverName: string
  contextRef: string
  baseUrl: string
  mode: RemoteInstallMode
  /** Pre-registered confidential only. */
  clientId?: string
  /** Pre-registered confidential only (sensitive). */
  clientSecret?: string
  grantScope?: RemoteGrantScope
}

export interface InstallRemoteResponse {
  serverName: string
  namespace: string
  contextRef: string
  contextUpdated: true
  clientMode: RemoteClientMode
  registrationMode: RemoteRegistrationMode
  clientSecretName?: string
}

/**
 * The typed error union returned by `/discover` (and re-run at install) under
 * `{ error: 'discovery_failed', detail }`. Mirrors control-api's `DiscoveryError`
 * `kind` values so the wizard can map each to actionable copy.
 */
export type RemoteDiscoveryErrorKind =
  | 'fetch_failed'
  | 'content_encoding_rejected'
  | 'kernel_rejected'
  | 'invalid_metadata'
  | 'no_s256'
  | 'no_authorization_server'
  | 'redirect_blocked'
  | 'prm_resource_mismatch'
  | 'issuer_mismatch'
