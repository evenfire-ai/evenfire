/**
 * Wire types for the remote MCP-OAuth admin endpoints consumed by the
 * "Add remote server" wizard (spec 19 §C5). These mirror EXACTLY the request
 * and response shapes control-api's `/admin/mcp-servers/remote` routes emit
 * (control-api/src/routes/admin/remoteMcp.ts). They are the contract boundary,
 * so they live here rather than inline in the wizard component.
 */
import type { RegistryRemoteOAuthBlock } from './api'

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

/**
 * Hosts (hostname plus any non-default port) of the AS endpoints an install
 * would trust. Reported only for a
 * `per-server` callback (no RFC 9207 `iss`), where the same-site rule is all that
 * ties them to the issuer and cannot tell two hosts of one domain apart.
 */
export interface RemoteAsEndpointHosts {
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

/**
 * Closed authorization-server profile control-api recognised from the pinned issuer.
 * `entra-v2` (a Microsoft Entra ID tenant): RFC 8707 `resource` is not sent and
 * `offline_access` is always requested.
 */
export type RemoteAsProfile = 'entra-v2'

/** The `detected` prefill returned by POST /discover (200). */
export interface RemoteDetected {
  registrationMode: RemoteDiscoverRegistrationMode
  dcr?: RemoteDetectedDcr
  endpoints: RemoteDetectedEndpoints
  resource: string
  issuer: string
  issForCallback?: string
  asProfile?: RemoteAsProfile
  /** First advertised scope that would mint a token for another API (warning only). */
  scopeAudienceViolation?: string
  /** Advertised scopes whose API cannot be tied to the server; the install needs them confirmed. */
  unverifiedScopes?: string[]
  /** The advertised scopes name no resource of the server (sign-in scopes only). */
  scopeAudienceMissing?: true
  asEndpointHosts?: RemoteAsEndpointHosts
  scopes: string[]
  quirks: RemoteDetectedQuirks
}

/**
 * Which OAuth callback an install would register: the shared one when the AS
 * returns `iss` (RFC 9207), otherwise one of the server's own.
 */
export type RemoteCallbackVariant = 'shared' | 'per-server'

/** The `/discover` view of the callback an install from this result would use. */
export interface RemoteCallbackPreview {
  /**
   * Whether the deployment has a usable public callback base URL. `false` blocks every
   * `per-server` install. On `shared` only a pre-registered install proceeds (its URI
   * falls back to the request Host at consent); shared CIMD and DCR still answer 503.
   */
  configured: boolean
  variant: RemoteCallbackVariant
  /**
   * Redirect URI the install would register. Per-server URIs carry the literal
   * placeholders `{serverName}` and, for DCR, `{installId}` (minted at install).
   */
  redirectUriTemplate?: string
}

export interface DiscoverRemoteRequest {
  baseUrl: string
  /** A Microsoft Entra ID tenant authority, sent only after a `tenant_required` answer. */
  authorizationServer?: string
}

/**
 * The `reason` an MCP transport probe could not be classified as alive or dead.
 * Mirrors control-api's `mcpTransportProbe.ts` inconclusive reasons. None of
 * these block Detect or Install — they only surface a warning (D3 fail-open).
 */
export type RemoteTransportInconclusiveReason =
  | 'timeout'
  | 'transport_failed'
  | 'redirect'
  | 'unexpected_status'
  | 'content_encoding_rejected'
  | 'kernel_rejected'

/**
 * Result of control-api's MCP transport probe: a token-less `initialize` POST
 * against the typed URL. `alive` = the path speaks MCP (200/202, or a spec
 * 401/403 challenge); `dead` = 404/405, the path serves no MCP (only this blocks
 * Continue/Install) and may carry a verified canonical `suggestedBaseUrl`;
 * `inconclusive` = anything the probe cannot prove either way (never blocks).
 */
export type RemoteTransportProbe =
  | { status: 'alive'; probedUrl: string; httpStatus: number; challenge: boolean }
  | { status: 'dead'; probedUrl: string; httpStatus: 404 | 405; suggestedBaseUrl?: string }
  | {
      status: 'inconclusive'
      probedUrl: string
      reason: RemoteTransportInconclusiveReason
      httpStatus?: number
      detail: string
    }

/** A catalog entry resolved for one slot, ready for the wizard's catalog mode. */
export interface RemoteCatalogInstallTarget {
  entry: RemoteCatalogEntryRef
  grantScope: RemoteGrantScope
  /**
   * The entry's URL, shown read-only. Sent with the install only as a precondition:
   * control-api still installs the entry's own URL and refuses when they differ.
   */
  baseUrl: string
  block: RegistryRemoteOAuthBlock
  /** Curator entry: its verification badge and setup guide are trusted. */
  trusted: boolean
  /** Publishing scope of a non-curator entry, else null. */
  publisher: string | null
}

/** What the wizard page's query selects. */
export type RemoteWizardQuery =
  | { mode: 'manual' }
  | { mode: 'catalog'; entry: RemoteCatalogEntryRef; grantScope: RemoteGrantScope }
  | { mode: 'invalid'; message: string }

/** Loading state of the catalog target the wizard's catalog mode opens on. */
export type RemoteCatalogTargetState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; target: RemoteCatalogInstallTarget }

/** The catalog entry and version a catalog-mode request names, as the registry returned them. */
export interface RemoteCatalogEntryRef {
  name: string
  version: string
}

/**
 * Catalog-mode discovery: the server reads the URL from the entry, so neither a URL
 * nor a server name is sent.
 */
export interface DiscoverCatalogRemoteRequest {
  catalogEntry: RemoteCatalogEntryRef
  grantScope: RemoteGrantScope
  authorizationServer?: string
}

/** Registration the catalog entry expects; informational only. */
export type RemoteCatalogExpectedRegistration = 'cimd' | 'dcr' | 'pre-registered'

/** Discovery resolved another registration mode than the entry expects (warning only). */
export interface RemoteCatalogDrift {
  expected: RemoteCatalogExpectedRegistration
  detected: RemoteDiscoverRegistrationMode
}

export interface DiscoverRemoteResponse {
  /** Catalog mode only: the slot's canonical name, assigned by control-api. */
  serverName?: string
  /** Catalog mode only: present when discovery contradicts the entry's expectation. */
  catalogDrift?: RemoteCatalogDrift
  detected: RemoteDetected
  /**
   * The MCP transport probe result. Optional so the wizard tolerates a
   * control-api older than the probe (a missing `transport` never blocks).
   */
  transport?: RemoteTransportProbe
  /** Absent on a control-api older than the per-server callback. */
  callback?: RemoteCallbackPreview
}

export interface InstallRemoteRequest {
  serverName: string
  baseUrl: string
  mode: RemoteInstallMode
  /** Pre-registered confidential only. */
  clientId?: string
  /** Pre-registered confidential only (sensitive). */
  clientSecret?: string
  grantScope?: RemoteGrantScope
  /** The authorization server the detection used (the Entra tenant authority). */
  authorizationServer?: string
  /** Full override of the requested scopes; absent means the advertised ones. */
  scopes?: string[]
  /** The exact unverifiable scopes the operator confirmed as this server's API. */
  confirmedUnverifiedScopes?: string[]
}

/**
 * Catalog-mode install. `serverName` is never sent: control-api derives it from the
 * slot. `baseUrl` is the entry URL the operator was shown, never one from the link;
 * control-api installs the entry's own URL and refuses the install when the entry
 * now names another, so a registry change after the wizard opened is not installed
 * unseen.
 */
export interface InstallCatalogRemoteRequest {
  catalogEntry: RemoteCatalogEntryRef
  grantScope: RemoteGrantScope
  baseUrl: string
  mode: RemoteInstallMode
  clientId?: string
  clientSecret?: string
  authorizationServer?: string
  scopes?: string[]
  confirmedUnverifiedScopes?: string[]
}

export interface InstallRemoteResponse {
  serverName: string
  namespace: string
  clientMode: RemoteClientMode
  registrationMode: RemoteRegistrationMode
  callbackVariant?: RemoteCallbackVariant
  /**
   * The redirect URI the AS must hold. Authoritative over the `/discover` preview:
   * the AS may have changed its RFC 9207 support in between.
   */
  redirectUri?: string
  clientSecretName?: string
}

/** Why a DCR registration response was refused after the client was minted. */
export type RemoteDcrRejectionKind =
  | 'redirect_uris_mismatch'
  | 'redirect_uris_missing'
  | 'client_id_is_cimd_identity'

/** What already uses a pre-registered client_id (409 `oauth_client_id_in_use`). */
export type RemoteClientIdConflict = 'cimd_client' | 'remote_server' | 'dynamic_client'

/**
 * Detail of the new install-time `400 { error: 'transport_unreachable' }`,
 * emitted before any write when the MCP transport probe finds the typed path
 * dead (404/405). `suggestedBaseUrl` is present only when the backend resolved a
 * reachable canonical URL; `mapRemoteInstallError` surfaces it in the copy.
 */
export interface InstallTransportUnreachableDetail {
  probedUrl: string
  httpStatus: number
  suggestedBaseUrl?: string
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
  | 'as_endpoints_cross_site'
  | 'tenant_required'
  | 'authorization_server_override_rejected'

/**
 * Detail of the `tenant_required` discovery error: the server signs in through Microsoft
 * Entra ID's multi-tenant authority, so the operator must name the tenant.
 * `tenantAuthorityTemplate` carries a literal `{tenantId}` placeholder.
 */
export interface RemoteTenantRequiredDetail {
  kind: 'tenant_required'
  authorizationServer: string
  tenantAuthorityTemplate: string
  detail: string
}

/**
 * `error` codes control-api answers a catalog-mode request with, besides the ones the
 * manual install shares (control-api/src/routes/admin/remoteMcp.ts).
 */
export type RemoteCatalogErrorCode =
  | 'catalog_entry_not_remote_oauth'
  | 'catalog_entry_invalid'
  | 'catalog_entry_name_mismatch'
  | 'catalog_grant_scope_not_allowed'
  | 'catalog_server_name_not_allowed'
  | 'catalog_base_url_mismatch'
  | 'catalog_slot_residue'
  | 'server_name_in_use'
  | 'install_in_progress'
