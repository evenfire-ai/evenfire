/**
 * Raw probe bytes of the remote MCP pilots (PRM + AS metadata), copied verbatim from
 * control-api's own T1 fixtures (control-api/test/fixtures/remoteOAuthDiscovery.ts —
 * live probes 2026-09-20, Linear re-probed 2026-09-29), plus the MCP transport probe
 * fixtures. The generic-lane prefill fixtures project these bytes.
 *
 * The remote wizard's `/discover` and install bodies do NOT live here: they are the
 * producer's own responses, loaded from control-api's golden wire files by the sibling
 * `remoteMcpWire.ts`.
 */
import type { RemoteTransportProbe } from '../../lib/remoteMcp.types'

// ─── Verbatim real probe bytes (control-api T1 fixtures) ──────────────────────

export const NOTION_PRM_JSON =
  '{"resource":"https://mcp.notion.com","authorization_servers":["https://mcp.notion.com"],"scopes_supported":["default"],"bearer_methods_supported":["header"],"resource_name":"Notion MCP (Beta)"}'
export const NOTION_AS_JSON =
  '{"issuer":"https://mcp.notion.com","authorization_endpoint":"https://mcp.notion.com/authorize","token_endpoint":"https://mcp.notion.com/token","registration_endpoint":"https://mcp.notion.com/register","scopes_supported":["default"],"response_types_supported":["code"],"response_modes_supported":["query"],"grant_types_supported":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"],"authorization_grant_profiles_supported":["urn:ietf:params:oauth:grant-profile:id-jag"],"token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"],"revocation_endpoint":"https://mcp.notion.com/token","code_challenge_methods_supported":["plain","S256"],"client_id_metadata_document_supported":true,"introspection_endpoint":"https://mcp.notion.com/introspect","introspection_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"]}'

export const LINEAR_PRM_JSON =
  '{"resource":"https://mcp.linear.app/mcp","authorization_servers":["https://mcp.linear.app"],"scopes_supported":["read","write"],"bearer_methods_supported":["header"]}'
// Re-probed 2026-09-29: Linear now advertises RFC 9207.
export const LINEAR_AS_JSON =
  '{"issuer":"https://mcp.linear.app","authorization_endpoint":"https://mcp.linear.app/authorize","token_endpoint":"https://mcp.linear.app/token","registration_endpoint":"https://mcp.linear.app/register","scopes_supported":["read","write","openid","email"],"response_types_supported":["code"],"response_modes_supported":["query"],"grant_types_supported":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"],"authorization_grant_profiles_supported":["urn:ietf:params:oauth:grant-profile:id-jag"],"token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"],"revocation_endpoint":"https://mcp.linear.app/token","code_challenge_methods_supported":["S256"],"authorization_response_iss_parameter_supported":true,"client_id_metadata_document_supported":true,"resource":"https://mcp.linear.app/mcp","resource_metadata":"https://mcp.linear.app/.well-known/oauth-protected-resource/mcp"}'

export const SENTRY_PRM_JSON =
  '{"resource":"https://mcp.sentry.dev/mcp","authorization_servers":["https://mcp.sentry.dev"],"scopes_supported":["org:read","project:write","team:write","event:write"],"bearer_methods_supported":["header"]}'
export const SENTRY_AS_JSON =
  '{"issuer":"https://mcp.sentry.dev","authorization_endpoint":"https://mcp.sentry.dev/oauth/authorize","token_endpoint":"https://mcp.sentry.dev/oauth/token","registration_endpoint":"https://mcp.sentry.dev/oauth/register","scopes_supported":["org:read","project:write","team:write","event:write"],"response_types_supported":["code"],"response_modes_supported":["query"],"grant_types_supported":["authorization_code","refresh_token"],"token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"],"revocation_endpoint":"https://mcp.sentry.dev/oauth/token","code_challenge_methods_supported":["S256"],"authorization_response_iss_parameter_supported":true,"client_id_metadata_document_supported":true}'

export const CANVA_PRM_JSON =
  '{"resource":"https://mcp.canva.com","authorization_servers":["https://mcp.canva.com"],"scopes_supported":["profile:read","design:meta:read","design:content:write","design:content:read","folder:read","folder:write","brandtemplate:content:read","brandtemplate:meta:read","brandtemplate:content:write","comment:write","comment:read","asset:read","asset:write","brandkit:read","help:answers:read","help:answers:write"],"bearer_methods_supported":["header"]}'
export const CANVA_AS_JSON =
  '{"issuer":"https://mcp.canva.com","authorization_endpoint":"https://mcp.canva.com/authorize","token_endpoint":"https://mcp.canva.com/token","registration_endpoint":"https://mcp.canva.com/register","response_types_supported":["code"],"response_modes_supported":["query"],"grant_types_supported":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"],"token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"],"revocation_endpoint":"https://mcp.canva.com/token","code_challenge_methods_supported":["plain","S256"],"client_id_metadata_document_supported":true,"authorization_grant_profiles_supported":["urn:ietf:params:oauth:grant-profile:id-jag"]}'

// ─── MCP transport probe fixtures (live probes 2026-09-25) ────────────────────
//
// control-ui cannot run control-api's `mcpTransportProbe.ts`, so the
// RemoteTransportProbe values below are DERIVED FROM THE REAL PROBE OUTPUTS: the
// verbatim root-PRM bytes plus the observed `initialize` HTTP statuses. The colocated
// contract test re-applies the producer's decision table + canonical-URL suggestion
// rule to those raw inputs and asserts each fixture equals the projection, so a
// drifted value fails.

/** Vercel serves OAuth PRM per-path; the root `resource` is the canonical URL. */
export const VERCEL_ROOT_PRM_JSON =
  '{"resource":"https://mcp.vercel.com/","authorization_servers":["https://vercel.com"],"scopes_supported":["openid"],"resource_name":"Vercel MCP"}'
export const VERCEL_MCP_PRM_JSON =
  '{"resource":"https://mcp.vercel.com/mcp","authorization_servers":["https://vercel.com"],"scopes_supported":["openid"],"resource_name":"Vercel MCP"}'

/**
 * Observed token-less `initialize` POST responses (status + www-authenticate
 * presence). These are the producer's raw probe outputs; the contract test's
 * `projectTransport` re-derives each RemoteTransportProbe from them.
 */
export interface InitializeProbeObservation {
  url: string
  httpStatus: number
  wwwAuthenticate: boolean
}

/** Vercel `/mcp`: 404 (Next.js 404 page) — the MCP transport is not there. */
export const VERCEL_MCP_INITIALIZE: InitializeProbeObservation = {
  url: 'https://mcp.vercel.com/mcp',
  httpStatus: 404,
  wwwAuthenticate: false,
}
/** Vercel root `/`: 200 text/event-stream — the real MCP transport. */
export const VERCEL_ROOT_INITIALIZE: InitializeProbeObservation = {
  url: 'https://mcp.vercel.com/',
  httpStatus: 200,
  wwwAuthenticate: false,
}
/** Notion `/mcp`: 401 with a Bearer challenge — a live transport requiring auth. */
export const NOTION_MCP_INITIALIZE: InitializeProbeObservation = {
  url: 'https://mcp.notion.com/mcp',
  httpStatus: 401,
  wwwAuthenticate: true,
}

/** Vercel `/mcp` dead, with the verified root as the canonical suggestion. */
export const VERCEL_TRANSPORT_DEAD: RemoteTransportProbe = {
  status: 'dead',
  probedUrl: 'https://mcp.vercel.com/mcp',
  httpStatus: 404,
  suggestedBaseUrl: 'https://mcp.vercel.com/',
}

/** Notion `/mcp` alive: a spec 401 challenge is a live transport that needs auth. */
export const NOTION_TRANSPORT_ALIVE: RemoteTransportProbe = {
  status: 'alive',
  probedUrl: 'https://mcp.notion.com/mcp',
  httpStatus: 401,
  challenge: true,
}

/** A transient probe timeout — inconclusive, never blocks (fail-open). */
export const TRANSPORT_INCONCLUSIVE_TIMEOUT: RemoteTransportProbe = {
  status: 'inconclusive',
  probedUrl: 'https://mcp.example.com/mcp',
  reason: 'timeout',
  detail: 'initialize probe timed out',
}
