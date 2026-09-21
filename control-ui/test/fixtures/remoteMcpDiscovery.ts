/**
 * Producer fixtures — the `detected` prefill POST /admin/mcp-servers/remote/discover
 * returns (spec 19 §C5). control-ui cannot run control-api's discovery in this
 * package (its deps — pino, @clerum/image-policy — are not installed here), so the
 * `detected` objects below are DERIVED FROM THE REAL SERVER PROBE BYTES: the raw
 * PRM/AS JSON strings are copied verbatim from control-api's own T1 fixtures
 * (control-api/test/fixtures/remoteOAuthDiscovery.ts — live probes 2026-09-20) and
 * the projection that turns those bytes into `detected` is the one the producer
 * applies (control-api/src/oauth/discovery.ts + src/routes/admin/remoteMcp.ts).
 *
 * The colocated contract test re-parses the verbatim raw bytes and asserts that
 * every `detected` field equals the real server field under the producer's
 * documented rule, so a hand-typed value that drifts from the real bytes fails.
 * This mirrors the repo's existing producer-fixture pattern (test/fixtures/
 * contextResource.ts + its *.contract.test.ts).
 */
import type { RemoteDetected } from '../../lib/remoteMcp.types'

// ─── Verbatim real probe bytes (control-api T1 fixtures, 2026-09-20) ──────────

export const NOTION_PRM_JSON =
  '{"resource":"https://mcp.notion.com","authorization_servers":["https://mcp.notion.com"],"scopes_supported":["default"],"bearer_methods_supported":["header"],"resource_name":"Notion MCP (Beta)"}'
export const NOTION_AS_JSON =
  '{"issuer":"https://mcp.notion.com","authorization_endpoint":"https://mcp.notion.com/authorize","token_endpoint":"https://mcp.notion.com/token","registration_endpoint":"https://mcp.notion.com/register","scopes_supported":["default"],"response_types_supported":["code"],"response_modes_supported":["query"],"grant_types_supported":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"],"authorization_grant_profiles_supported":["urn:ietf:params:oauth:grant-profile:id-jag"],"token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"],"revocation_endpoint":"https://mcp.notion.com/token","code_challenge_methods_supported":["plain","S256"],"client_id_metadata_document_supported":true,"introspection_endpoint":"https://mcp.notion.com/introspect","introspection_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"]}'

export const LINEAR_PRM_JSON =
  '{"resource":"https://mcp.linear.app/mcp","authorization_servers":["https://mcp.linear.app"],"scopes_supported":["read","write"],"bearer_methods_supported":["header"]}'
export const LINEAR_AS_JSON =
  '{"issuer":"https://mcp.linear.app","authorization_endpoint":"https://mcp.linear.app/authorize","token_endpoint":"https://mcp.linear.app/token","registration_endpoint":"https://mcp.linear.app/register","scopes_supported":["read","write","openid","email"],"response_types_supported":["code"],"response_modes_supported":["query"],"grant_types_supported":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"],"authorization_grant_profiles_supported":["urn:ietf:params:oauth:grant-profile:id-jag"],"token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"],"revocation_endpoint":"https://mcp.linear.app/token","code_challenge_methods_supported":["S256"],"client_id_metadata_document_supported":true,"resource":"https://mcp.linear.app/mcp","resource_metadata":"https://mcp.linear.app/.well-known/oauth-protected-resource/mcp"}'

export const SENTRY_PRM_JSON =
  '{"resource":"https://mcp.sentry.dev/mcp","authorization_servers":["https://mcp.sentry.dev"],"scopes_supported":["org:read","project:write","team:write","event:write"],"bearer_methods_supported":["header"]}'
export const SENTRY_AS_JSON =
  '{"issuer":"https://mcp.sentry.dev","authorization_endpoint":"https://mcp.sentry.dev/oauth/authorize","token_endpoint":"https://mcp.sentry.dev/oauth/token","registration_endpoint":"https://mcp.sentry.dev/oauth/register","scopes_supported":["org:read","project:write","team:write","event:write"],"response_types_supported":["code"],"response_modes_supported":["query"],"grant_types_supported":["authorization_code","refresh_token"],"token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"],"revocation_endpoint":"https://mcp.sentry.dev/oauth/token","code_challenge_methods_supported":["S256"],"authorization_response_iss_parameter_supported":true,"client_id_metadata_document_supported":true}'

export const CANVA_PRM_JSON =
  '{"resource":"https://mcp.canva.com","authorization_servers":["https://mcp.canva.com"],"scopes_supported":["profile:read","design:meta:read","design:content:write","design:content:read","folder:read","folder:write","brandtemplate:content:read","brandtemplate:meta:read","brandtemplate:content:write","comment:write","comment:read","asset:read","asset:write","brandkit:read","help:answers:read","help:answers:write"],"bearer_methods_supported":["header"]}'
export const CANVA_AS_JSON =
  '{"issuer":"https://mcp.canva.com","authorization_endpoint":"https://mcp.canva.com/authorize","token_endpoint":"https://mcp.canva.com/token","registration_endpoint":"https://mcp.canva.com/register","response_types_supported":["code"],"response_modes_supported":["query"],"grant_types_supported":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"],"token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"],"revocation_endpoint":"https://mcp.canva.com/token","code_challenge_methods_supported":["plain","S256"],"client_id_metadata_document_supported":true,"authorization_grant_profiles_supported":["urn:ietf:params:oauth:grant-profile:id-jag"]}'

/**
 * DCR-forced AS bytes — same documented subtraction control-api uses (DEC-19):
 * removing `client_id_metadata_document_supported` from the real Notion AS pushes
 * the mode selector off CIMD onto DCR (Notion advertises a `/register` endpoint);
 * additionally dropping `none` from the auth methods forces DCR-confidential.
 * Nothing is invented — the removed fields are exactly the ones Notion emits.
 */
function subtractedNotionAs(mutate: (as: Record<string, unknown>) => void): string {
  const as = JSON.parse(NOTION_AS_JSON) as Record<string, unknown>
  mutate(as)
  return JSON.stringify(as)
}
export const DCR_PUBLIC_AS_JSON = subtractedNotionAs(as => {
  delete as.client_id_metadata_document_supported
})
export const DCR_CONFIDENTIAL_AS_JSON = subtractedNotionAs(as => {
  delete as.client_id_metadata_document_supported
  as.token_endpoint_auth_methods_supported = ['client_secret_basic', 'client_secret_post']
})

// ─── `detected` fixtures (hand-derived; locked to the bytes by the contract test) ─

/** Notion — CIMD (public), refresh supported, no `iss`. */
export const NOTION_DETECTED: RemoteDetected = {
  registrationMode: 'cimd',
  endpoints: {
    authorization: 'https://mcp.notion.com/authorize',
    token: 'https://mcp.notion.com/token',
    registration: 'https://mcp.notion.com/register',
  },
  resource: 'https://mcp.notion.com',
  issuer: 'https://mcp.notion.com',
  scopes: ['default'],
  quirks: { bearerInBody: false, supportsRefresh: true },
}

/** Linear — CIMD, resource carries a `/mcp` path. */
export const LINEAR_DETECTED: RemoteDetected = {
  registrationMode: 'cimd',
  endpoints: {
    authorization: 'https://mcp.linear.app/authorize',
    token: 'https://mcp.linear.app/token',
    registration: 'https://mcp.linear.app/register',
  },
  resource: 'https://mcp.linear.app/mcp',
  issuer: 'https://mcp.linear.app',
  scopes: ['read', 'write'],
  quirks: { bearerInBody: false, supportsRefresh: true },
}

/** Sentry — CIMD, advertises RFC 9207 `iss` (issForCallback present). */
export const SENTRY_DETECTED: RemoteDetected = {
  registrationMode: 'cimd',
  endpoints: {
    authorization: 'https://mcp.sentry.dev/oauth/authorize',
    token: 'https://mcp.sentry.dev/oauth/token',
    registration: 'https://mcp.sentry.dev/oauth/register',
  },
  resource: 'https://mcp.sentry.dev/mcp',
  issuer: 'https://mcp.sentry.dev',
  issForCallback: 'https://mcp.sentry.dev',
  scopes: ['org:read', 'project:write', 'team:write', 'event:write'],
  quirks: { bearerInBody: false, supportsRefresh: true },
}

/** Canva — CIMD; AS has no scopes_supported, so scopes come from the PRM. */
export const CANVA_DETECTED: RemoteDetected = {
  registrationMode: 'cimd',
  endpoints: {
    authorization: 'https://mcp.canva.com/authorize',
    token: 'https://mcp.canva.com/token',
    registration: 'https://mcp.canva.com/register',
  },
  resource: 'https://mcp.canva.com',
  issuer: 'https://mcp.canva.com',
  scopes: [
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
  quirks: { bearerInBody: false, supportsRefresh: true },
}

/** DCR-public (Notion minus CIMD support). */
export const DCR_PUBLIC_DETECTED: RemoteDetected = {
  registrationMode: 'dcr',
  dcr: { available: true, clientMode: 'public', supportsRefresh: true },
  endpoints: {
    authorization: 'https://mcp.notion.com/authorize',
    token: 'https://mcp.notion.com/token',
    registration: 'https://mcp.notion.com/register',
  },
  resource: 'https://mcp.notion.com',
  issuer: 'https://mcp.notion.com',
  scopes: ['default'],
  quirks: { bearerInBody: false, supportsRefresh: true },
}

/** DCR-confidential (Notion minus CIMD support and minus `none`). */
export const DCR_CONFIDENTIAL_DETECTED: RemoteDetected = {
  registrationMode: 'dcr',
  dcr: { available: true, clientMode: 'confidential', supportsRefresh: true },
  endpoints: {
    authorization: 'https://mcp.notion.com/authorize',
    token: 'https://mcp.notion.com/token',
    registration: 'https://mcp.notion.com/register',
  },
  resource: 'https://mcp.notion.com',
  issuer: 'https://mcp.notion.com',
  scopes: ['default'],
  quirks: { bearerInBody: false, supportsRefresh: true },
}
