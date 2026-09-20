/**
 * T1 fixtures — remote MCP-OAuth discovery (spec 19 §7 T1).
 *
 * These are the EXACT bytes returned by the real production servers on 2026-09-20
 * (curl, `Accept: application/json`), copied verbatim from the live probe. They are
 * NOT hand-authored — a PRM/AS shape the real server cannot emit would leave the
 * discovery code unreachable. Each entry cites its probe URL. Parsing the raw string
 * (mirroring `Response.json()`) is what the discovery client consumes.
 *
 * Probe method — the discovery client probes the MCP URL with GET; re-sondeo
 * 2026-09-20 confirmed the four pilots emit the same `WWW-Authenticate:
 * resource_metadata` challenge on GET as on POST (all pointing at the
 * path-suffixed well-known), so the GET probe is derived from the real producer,
 * not invented. Real GET responses (2026-09-20):
 *   GET https://mcp.notion.com/mcp → 401  www-authenticate: Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp", error="invalid_token", …
 *   GET https://mcp.linear.app/mcp → 401  www-authenticate: Bearer realm="OAuth", resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", error="invalid_token", …
 *   GET https://mcp.sentry.dev/mcp → 401  www-authenticate: Bearer realm="OAuth", resource_metadata="https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp"
 *   GET https://mcp.canva.com/mcp  → 401  www-authenticate: Bearer realm="OAuth", resource_metadata="https://mcp.canva.com/.well-known/oauth-protected-resource/mcp", error="invalid_token", …
 * (POST initialize returns the identical header on all four.)
 *
 * Provenance: scratchpad/c1-fixtures-provenance.md (sondeo en vivo 2026-09-20,
 * sección "EVIDENCIA GET").
 */

// ─── Notion (resource base sin path) ────────────────────────────────────────
// PRM: GET https://mcp.notion.com/.well-known/oauth-protected-resource → 200
export const NOTION_PRM_JSON =
  '{"resource":"https://mcp.notion.com","authorization_servers":["https://mcp.notion.com"],"scopes_supported":["default"],"bearer_methods_supported":["header"],"resource_name":"Notion MCP (Beta)"}'
// AS: GET https://mcp.notion.com/.well-known/oauth-authorization-server → 200
export const NOTION_AS_JSON =
  '{"issuer":"https://mcp.notion.com","authorization_endpoint":"https://mcp.notion.com/authorize","token_endpoint":"https://mcp.notion.com/token","registration_endpoint":"https://mcp.notion.com/register","scopes_supported":["default"],"response_types_supported":["code"],"response_modes_supported":["query"],"grant_types_supported":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"],"authorization_grant_profiles_supported":["urn:ietf:params:oauth:grant-profile:id-jag"],"token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"],"revocation_endpoint":"https://mcp.notion.com/token","code_challenge_methods_supported":["plain","S256"],"client_id_metadata_document_supported":true,"introspection_endpoint":"https://mcp.notion.com/introspect","introspection_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"]}'

// ─── Linear (resource con path /mcp; PRM en root Y path-suffixed) ───────────
// PRM (root): GET https://mcp.linear.app/.well-known/oauth-protected-resource → 200
export const LINEAR_PRM_JSON =
  '{"resource":"https://mcp.linear.app/mcp","authorization_servers":["https://mcp.linear.app"],"scopes_supported":["read","write"],"bearer_methods_supported":["header"]}'
// AS: GET https://mcp.linear.app/.well-known/oauth-authorization-server → 200
export const LINEAR_AS_JSON =
  '{"issuer":"https://mcp.linear.app","authorization_endpoint":"https://mcp.linear.app/authorize","token_endpoint":"https://mcp.linear.app/token","registration_endpoint":"https://mcp.linear.app/register","scopes_supported":["read","write","openid","email"],"response_types_supported":["code"],"response_modes_supported":["query"],"grant_types_supported":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"],"authorization_grant_profiles_supported":["urn:ietf:params:oauth:grant-profile:id-jag"],"token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"],"revocation_endpoint":"https://mcp.linear.app/token","code_challenge_methods_supported":["S256"],"client_id_metadata_document_supported":true,"resource":"https://mcp.linear.app/mcp","resource_metadata":"https://mcp.linear.app/.well-known/oauth-protected-resource/mcp"}'

// ─── Sentry (PRM SOLO path-suffixed; root → 404; 401 trae WWW-Authenticate) ─
// 401 header emitted identically on GET and POST of https://mcp.sentry.dev/mcp
// (the client probes with GET; POST initialize returns the same header).
export const SENTRY_WWW_AUTHENTICATE =
  'Bearer realm="OAuth", resource_metadata="https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp"'
// PRM: GET https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp → 200
export const SENTRY_PRM_JSON =
  '{"resource":"https://mcp.sentry.dev/mcp","authorization_servers":["https://mcp.sentry.dev"],"scopes_supported":["org:read","project:write","team:write","event:write"],"bearer_methods_supported":["header"]}'
// AS: GET https://mcp.sentry.dev/.well-known/oauth-authorization-server → 200
export const SENTRY_AS_JSON =
  '{"issuer":"https://mcp.sentry.dev","authorization_endpoint":"https://mcp.sentry.dev/oauth/authorize","token_endpoint":"https://mcp.sentry.dev/oauth/token","registration_endpoint":"https://mcp.sentry.dev/oauth/register","scopes_supported":["org:read","project:write","team:write","event:write"],"response_types_supported":["code"],"response_modes_supported":["query"],"grant_types_supported":["authorization_code","refresh_token"],"token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"],"revocation_endpoint":"https://mcp.sentry.dev/oauth/token","code_challenge_methods_supported":["S256"],"authorization_response_iss_parameter_supported":true,"client_id_metadata_document_supported":true}'

// ─── Canva (resource base sin path) ─────────────────────────────────────────
// PRM: GET https://mcp.canva.com/.well-known/oauth-protected-resource → 200
export const CANVA_PRM_JSON =
  '{"resource":"https://mcp.canva.com","authorization_servers":["https://mcp.canva.com"],"scopes_supported":["profile:read","design:meta:read","design:content:write","design:content:read","folder:read","folder:write","brandtemplate:content:read","brandtemplate:meta:read","brandtemplate:content:write","comment:write","comment:read","asset:read","asset:write","brandkit:read","help:answers:read","help:answers:write"],"bearer_methods_supported":["header"]}'
// AS: GET https://mcp.canva.com/.well-known/oauth-authorization-server → 200
export const CANVA_AS_JSON =
  '{"issuer":"https://mcp.canva.com","authorization_endpoint":"https://mcp.canva.com/authorize","token_endpoint":"https://mcp.canva.com/token","registration_endpoint":"https://mcp.canva.com/register","response_types_supported":["code"],"response_modes_supported":["query"],"grant_types_supported":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"],"token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"],"revocation_endpoint":"https://mcp.canva.com/token","code_challenge_methods_supported":["plain","S256"],"client_id_metadata_document_supported":true,"authorization_grant_profiles_supported":["urn:ietf:params:oauth:grant-profile:id-jag"]}'

export interface PilotFixture {
  name: string
  /** MCP server URL discovery is entered with. */
  mcpUrl: string
  prm: { url: string; json: string }
  /** Additional well-known/PRM URLs the server 404s on (for candidate fallback). */
  prmNotFound?: string[]
  /** WWW-Authenticate header the 401 probe of `mcpUrl` returns, if any. */
  wwwAuthenticate?: string
  as: { url: string; json: string }
}

/** The 4 CIMD-ready pilots, keyed by the real well-known URLs they serve. */
export const PILOTS: Record<'notion' | 'linear' | 'sentry' | 'canva', PilotFixture> = {
  notion: {
    name: 'notion',
    mcpUrl: 'https://mcp.notion.com/mcp',
    // Notion serves PRM only at root; the path-suffixed candidate 404s.
    prm: {
      url: 'https://mcp.notion.com/.well-known/oauth-protected-resource',
      json: NOTION_PRM_JSON,
    },
    prmNotFound: ['https://mcp.notion.com/.well-known/oauth-protected-resource/mcp'],
    as: {
      url: 'https://mcp.notion.com/.well-known/oauth-authorization-server',
      json: NOTION_AS_JSON,
    },
  },
  linear: {
    name: 'linear',
    mcpUrl: 'https://mcp.linear.app/mcp',
    prm: {
      url: 'https://mcp.linear.app/.well-known/oauth-protected-resource/mcp',
      json: LINEAR_PRM_JSON,
    },
    as: {
      url: 'https://mcp.linear.app/.well-known/oauth-authorization-server',
      json: LINEAR_AS_JSON,
    },
  },
  sentry: {
    name: 'sentry',
    mcpUrl: 'https://mcp.sentry.dev/mcp',
    wwwAuthenticate: SENTRY_WWW_AUTHENTICATE,
    prm: {
      url: 'https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp',
      json: SENTRY_PRM_JSON,
    },
    // Sentry root well-known 404s — only the path-suffixed form (or the hint) works.
    prmNotFound: ['https://mcp.sentry.dev/.well-known/oauth-protected-resource'],
    as: {
      url: 'https://mcp.sentry.dev/.well-known/oauth-authorization-server',
      json: SENTRY_AS_JSON,
    },
  },
  canva: {
    name: 'canva',
    mcpUrl: 'https://mcp.canva.com/mcp',
    prm: {
      url: 'https://mcp.canva.com/.well-known/oauth-protected-resource',
      json: CANVA_PRM_JSON,
    },
    prmNotFound: ['https://mcp.canva.com/.well-known/oauth-protected-resource/mcp'],
    as: {
      url: 'https://mcp.canva.com/.well-known/oauth-authorization-server',
      json: CANVA_AS_JSON,
    },
  },
}

/**
 * Build a `fetch`-shaped mock from a pilot fixture: a 401 (with WWW-Authenticate)
 * on the MCP probe when the fixture has a hint, 200+JSON on the served well-known
 * URLs, and 404 on the URLs the real server does not serve. Mirrors the real HTTP
 * responses so the discovery code path is exercised, not a hand-invented one.
 */
export function makeDiscoveryFetch(pilot: PilotFixture): typeof fetch {
  const jsonByUrl = new Map<string, string>([
    [pilot.prm.url, pilot.prm.json],
    [pilot.as.url, pilot.as.json],
  ])
  const notFound = new Set(pilot.prmNotFound ?? [])
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    // MCP probe (GET) → 401 with the challenge header when the fixture has one.
    if (url === pilot.mcpUrl && (init?.method ?? 'GET') === 'GET') {
      if (pilot.wwwAuthenticate) {
        return new Response(null, {
          status: 401,
          headers: { 'www-authenticate': pilot.wwwAuthenticate },
        })
      }
      // No challenge advertised — probe returns a plain 401 with no hint.
      return new Response(null, { status: 401 })
    }
    const body = jsonByUrl.get(url)
    if (body !== undefined) {
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (notFound.has(url)) return new Response('not found', { status: 404 })
    return new Response('unexpected url', { status: 404 })
  }
  return fn as unknown as typeof fetch
}
