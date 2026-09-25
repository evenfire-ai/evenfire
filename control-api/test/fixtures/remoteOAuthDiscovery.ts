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
 * Transport probe (sondeo POST en vivo 2026-09-25): the tokenless `POST initialize` of
 * the four CIMD pilots returns 401 with the same Bearer challenge (transport alive,
 * token required); Vercel's `/mcp` returns 404 (dead) while `/` returns 200
 * `text/event-stream`. Those bytes back the `VERCEL_PILOT` + the `initialize` table
 * below — derived from the real producer, not hand-invented.
 *
 * Provenance: scratchpad/c1-fixtures-provenance.md (sondeo en vivo 2026-09-20,
 * sección "EVIDENCIA GET") + the 2026-09-25 POST probe.
 */
import type { DbClient } from '../../src/db.js'
import type { PinnedTransport } from '../../src/http/pinnedFetch.js'

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
  /**
   * The ROOT PRM (`/.well-known/oauth-protected-resource`, no path suffix) when the
   * server serves a distinct one — the source of the transport probe's canonical-URL
   * suggestion (Vercel: root PRM `resource` is `https://mcp.vercel.com/`).
   */
  prmRoot?: { url: string; json: string }
  /** Additional well-known/PRM URLs the server 404s on (for candidate fallback). */
  prmNotFound?: string[]
  /** WWW-Authenticate header the 401 probe of `mcpUrl` returns, if any. */
  wwwAuthenticate?: string
  /**
   * Per-URL response of the tokenless `POST initialize` transport probe, keyed by the
   * exact URL POSTed (the typed MCP URL and any canonical candidate). Vercel: `/mcp` →
   * 404, `/` → 200 event-stream. The 4 CIMD pilots omit this — the transport defaults
   * their POST to the real 401 challenge (transport alive, token required).
   */
  initialize?: Record<string, { status: number; headers: Record<string, string> }>
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

// ─── Vercel (DCR, NOT CIMD) — transport probe repro (sondeo en vivo 2026-09-25) ──
//
// The exact bytes Vercel returned on 2026-09-25. Vercel serves OAuth metadata
// PER-PATH (both root and `/mcp` PRM answer 200) but its MCP transport lives at the
// ROOT `/`: POST `initialize` to `/mcp` → 404 (Next.js 404 page), to `/` → 200
// `text/event-stream`. This is the exact URL-resolution gap the probe closes. Vercel's
// AS omits `none` from `token_endpoint_auth_methods_supported` → mode `dcr`.
//
// PROVENANCE (curl, 2026-09-25):
//   GET  https://mcp.vercel.com/.well-known/oauth-protected-resource      → 200 (root, resource `/`)
//   GET  https://mcp.vercel.com/.well-known/oauth-protected-resource/mcp  → 200 (path, resource `/mcp`)
//   GET  https://vercel.com/.well-known/oauth-authorization-server        → 200
//   POST initialize https://mcp.vercel.com/mcp → 404 text/html; https://mcp.vercel.com/ → 200 text/event-stream

/** Root PRM: resource is the canonical root `https://mcp.vercel.com/`. */
export const VERCEL_PRM_ROOT_JSON =
  '{"resource":"https://mcp.vercel.com/","authorization_servers":["https://vercel.com"],"scopes_supported":["openid"],"resource_name":"Vercel MCP","resource_documentation":"https://vercel.com/docs/mcp/vercel-mcp","organization_name":"Vercel","organization_uri":"https://vercel.com","description":"Vercel\'s official MCP server — Vercel platform tools, deployment management, and documentation for AI assistants.","logo_uri":"https://mcp.vercel.com/icons/vercel-light.svg"}'
/** Path-suffixed PRM: resource echoes the typed `/mcp` path (what fooled Detect). */
export const VERCEL_PRM_MCP_JSON =
  '{"resource":"https://mcp.vercel.com/mcp","authorization_servers":["https://vercel.com"],"scopes_supported":["openid"],"resource_name":"Vercel MCP","resource_documentation":"https://vercel.com/docs/mcp/vercel-mcp","organization_name":"Vercel","organization_uri":"https://vercel.com","description":"Vercel\'s official MCP server — Vercel platform tools, deployment management, and documentation for AI assistants.","logo_uri":"https://mcp.vercel.com/icons/vercel-light.svg"}'
export const VERCEL_AS_JSON =
  '{"issuer":"https://vercel.com","jwks_uri":"https://vercel.com/.well-known/jwks","subject_types_supported":["public"],"response_types_supported":["code"],"response_modes_supported":["web_message.opener"],"claims_supported":["sub","aud","exp","iat","iss","jti","nbf","nonce","preferred_username","email","picture"],"id_token_signing_alg_values_supported":["RS256"],"scopes_supported":["openid","email","profile","offline_access"],"authorization_endpoint":"https://vercel.com/oauth/authorize","device_authorization_endpoint":"https://api.vercel.com/login/oauth/device-authorization","token_endpoint":"https://api.vercel.com/login/oauth/token","revocation_endpoint":"https://api.vercel.com/login/oauth/token/revoke","userinfo_endpoint":"https://api.vercel.com/login/oauth/userinfo","code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","client_secret_jwt","private_key_jwt"],"grant_types_supported":["authorization_code","client_credentials","refresh_token","urn:ietf:params:oauth:grant-type:device_code"],"registration_endpoint":"https://api.vercel.com/login/oauth/register"}'

/**
 * Vercel pilot — DCR (not CIMD), kept OUT of the `PILOTS` record so the CIMD discovery
 * loop (`oauth.discovery.test.ts`) is untouched. Discovery resolves through the
 * path-suffixed PRM (`resource: …/mcp`), while the transport probe finds `/mcp` dead
 * (404) and suggests the root `/` from the root PRM's `resource`.
 */
export const VERCEL_PILOT: PilotFixture = {
  name: 'vercel',
  mcpUrl: 'https://mcp.vercel.com/mcp',
  prm: {
    url: 'https://mcp.vercel.com/.well-known/oauth-protected-resource/mcp',
    json: VERCEL_PRM_MCP_JSON,
  },
  prmRoot: {
    url: 'https://mcp.vercel.com/.well-known/oauth-protected-resource',
    json: VERCEL_PRM_ROOT_JSON,
  },
  as: {
    url: 'https://vercel.com/.well-known/oauth-authorization-server',
    json: VERCEL_AS_JSON,
  },
  initialize: {
    'https://mcp.vercel.com/mcp': {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
    'https://mcp.vercel.com/': { status: 200, headers: { 'content-type': 'text/event-stream' } },
  },
}

/**
 * Build a {@link PinnedTransport}-shaped mock from a pilot fixture: a 401 (with
 * WWW-Authenticate) on the MCP probe when the fixture has a hint, 200+JSON on the
 * served well-known URLs, and 404 on the URLs the real server does not serve.
 * Mirrors the real HTTP responses so the discovery code path is exercised, not a
 * hand-invented one. Discovery now fetches through the IP-pinned `node:https`
 * transport (H2), so the test double is a transport, not a `fetch`.
 */
// ─── DCR fixtures (spec 02 C2, DEC-19) ──────────────────────────────────────
//
// The GET-able parts (PRM + AS metadata) are derived from the REAL Notion probe
// (above) by DOCUMENTED SUBTRACTION, per DEC-19: removing
// `client_id_metadata_document_supported` pushes the mode selector off CIMD onto
// DCR (Notion advertises a `/register` endpoint). Dropping `none` from the auth
// methods additionally forces DCR-CONFIDENTIAL. Nothing here is hand-invented —
// the fields removed are the exact ones the real Notion AS emits.

function subtractedNotionAs(mutate: (as: Record<string, unknown>) => void): string {
  const as = JSON.parse(NOTION_AS_JSON) as Record<string, unknown>
  mutate(as)
  return JSON.stringify(as)
}

/** Real Notion probe minus CIMD support → DCR, and `none` kept → public client. */
export const DCR_PUBLIC_AS_JSON = subtractedNotionAs(as => {
  delete as.client_id_metadata_document_supported
})

/** Real Notion probe minus CIMD support AND minus `none` → DCR, confidential. */
export const DCR_CONFIDENTIAL_AS_JSON = subtractedNotionAs(as => {
  delete as.client_id_metadata_document_supported
  as.token_endpoint_auth_methods_supported = ['client_secret_basic', 'client_secret_post']
})

/** A DCR-forced pilot (public or confidential) reusing Notion's real PRM + URLs. */
export function dcrPilot(mode: 'public' | 'confidential'): PilotFixture {
  return {
    name: `dcr-${mode}`,
    mcpUrl: 'https://mcp.notion.com/mcp',
    prm: {
      url: 'https://mcp.notion.com/.well-known/oauth-protected-resource',
      json: NOTION_PRM_JSON,
    },
    prmNotFound: ['https://mcp.notion.com/.well-known/oauth-protected-resource/mcp'],
    as: {
      url: 'https://mcp.notion.com/.well-known/oauth-authorization-server',
      json: mode === 'public' ? DCR_PUBLIC_AS_JSON : DCR_CONFIDENTIAL_AS_JSON,
    },
  }
}

/** The registration endpoint Notion advertises (target of the DCR POST). */
export const DCR_REGISTRATION_ENDPOINT = 'https://mcp.notion.com/register'

// The RFC 7591 §3.2.1 registration RESPONSE fixtures below are:
//   NOT probed — derived from RFC 7591 §3.2.1, not a live probe.
// A DCR registration response can only be obtained by a side-effecting POST that
// creates a persistent client at a third party (DEC-19) — not repeatable in CI and
// an external-effect action. These encode the RFC 7591 SHAPE (the contract a real
// AS honours), which is what makes `registerDynamicClient`'s parse path reachable;
// the VALUES are illustrative and no POST is ever made to a third party.

export const DCR_PUBLIC_REGISTRATION_RESPONSE = {
  client_id: 'dyn-public-6f1c2a',
  client_id_issued_at: 1_758_326_400,
  token_endpoint_auth_method: 'none',
  redirect_uris: ['https://control.example.com/api/v1/oauth-callback/remote'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
} as const

export const DCR_CONFIDENTIAL_REGISTRATION_RESPONSE = {
  client_id: 'dyn-conf-9b3d7e',
  // fixture value, not a live secret — DEC-19
  client_secret: 'fixture-client-secret-not-probed',
  client_id_issued_at: 1_758_326_400,
  client_secret_expires_at: 0, // RFC 7591: 0 ⇒ non-expiring ⇒ stored NULL
  // fixture value, not a live RFC 7592 bearer — DEC-19
  registration_access_token: 'fixture-reg-access-token-not-probed',
  registration_client_uri: 'https://mcp.notion.com/register/dyn-conf-9b3d7e',
  token_endpoint_auth_method: 'client_secret_post',
  redirect_uris: ['https://control.example.com/api/v1/oauth-callback/remote'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
} as const

/** Same confidential response but the AS overrides the method to one we cannot present. */
export const DCR_BASIC_REGISTRATION_RESPONSE = {
  ...DCR_CONFIDENTIAL_REGISTRATION_RESPONSE,
  token_endpoint_auth_method: 'client_secret_basic',
} as const

/**
 * The EXACT RFC 7591 §3.2.1 body Vercel returned (HTTP 201) to a confidential
 * (`client_secret_post`) DCR request, captured live from
 * `https://api.vercel.com/login/oauth/register`. Vercel DOWNGRADES the client to
 * public — `token_endpoint_auth_method: "none"`, NO `client_secret` — which is
 * legitimate per RFC 7591 (the AS is the final authority on the auth method): clerum
 * requested confidential only because Vercel's AS metadata omits `none` from
 * `token_endpoint_auth_methods_supported`. Kept as the VERBATIM wire string (not a
 * hand-shaped object) so `registerDynamicClient`'s parse path sees exactly what
 * Vercel emits — the downgrade shape is observed, never invented.
 */
export const DCR_VERCEL_DOWNGRADE_REGISTRATION_JSON =
  '{"client_id":"cl_WbdtcToDrMR4ZHvXLGAmbfoYCsQjMeS8","token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"],"client_name":"Evenfire","redirect_uris":["http://127.0.0.1:8090/api/v1/oauth-callback/remote"]}'

export const DCR_VERCEL_DOWNGRADE_REGISTRATION_RESPONSE = JSON.parse(
  DCR_VERCEL_DOWNGRADE_REGISTRATION_JSON
) as { client_id: string; token_endpoint_auth_method: string; [k: string]: unknown }

/**
 * Adversarial 2xx: a PUBLIC assignment (`token_endpoint_auth_method: "none"`) that
 * ALSO echoes a `client_secret`. The wire shape is the Vercel downgrade body plus an
 * injected `client_secret` — kept as the VERBATIM string, not a hand-shaped object.
 * A public client has no secret, so control-api must classify it public and DISCARD
 * the echoed secret (never persist or log it).
 */
export const DCR_PUBLIC_WITH_ECHOED_SECRET_REGISTRATION_JSON =
  '{"client_id":"cl_PublicWithEchoedSecret_x91","token_endpoint_auth_method":"none","client_secret":"echoed-secret-must-be-discarded","grant_types":["authorization_code","refresh_token"],"response_types":["code"],"client_name":"Evenfire","redirect_uris":["http://127.0.0.1:8090/api/v1/oauth-callback/remote"]}'

export const DCR_PUBLIC_WITH_ECHOED_SECRET_REGISTRATION_RESPONSE = JSON.parse(
  DCR_PUBLIC_WITH_ECHOED_SECRET_REGISTRATION_JSON
) as { client_id: string; token_endpoint_auth_method: string; client_secret: string }

/**
 * Adversarial 2xx: a NON-STRING `token_endpoint_auth_method` (a number) injected by
 * an untrusted AS. Verbatim wire string. Must fail closed to `auth_method_unsupported`
 * rather than let the garbage value flow to the effective-mode derivation.
 */
export const DCR_NONSTRING_AUTH_METHOD_REGISTRATION_JSON =
  '{"client_id":"cl_NonStringAuthMethod","token_endpoint_auth_method":42,"registration_client_uri":"https://mcp.notion.com/register/cl_NonStringAuthMethod","registration_access_token":"fixture-reg-access-token-not-probed"}'

export interface RecordedDcrCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/**
 * A {@link PinnedTransport} stub for the DCR POST (and the RFC 7592 rollback
 * DELETE), recording every call so a test can assert the single-hop POST and the
 * best-effort management DELETE happened. Zero network (DEC-19). The registration
 * endpoint returns `responseJson` at `status`; the management URI answers 204 to a
 * DELETE; anything else 404s.
 */
export function makeDcrTransport(opts: {
  registrationEndpoint?: string
  responseJson: string
  status?: number
  managementUri?: string
}): { transport: PinnedTransport; calls: RecordedDcrCall[] } {
  const registrationEndpoint = opts.registrationEndpoint ?? DCR_REGISTRATION_ENDPOINT
  const status = opts.status ?? 201
  const calls: RecordedDcrCall[] = []
  const transport: PinnedTransport = async ({ url, method, headers, body }) => {
    calls.push({ url, method, headers, body })
    if (url === registrationEndpoint && method === 'POST') {
      return {
        status,
        headers: { 'content-type': 'application/json' },
        bodyText: opts.responseJson,
      }
    }
    if (method === 'DELETE') {
      return { status: 204, headers: {}, bodyText: '' }
    }
    return { status: 404, headers: {}, bodyText: 'unexpected url' }
  }
  return { transport, calls }
}

/**
 * A minimal in-memory `dynamic_clients` DbClient for the store + saga tests. It is
 * a TEST HARNESS (not a cross-layer fixture, T1): it mirrors the exact parameter
 * order of `dynamicClientStore.ts`'s own INSERT/SELECT/DELETE, so a store round-trip
 * (upsert → get) and the saga's rollback (delete) run end-to-end with zero real
 * Postgres. The encrypted envelope it stores is produced by the real
 * `encryptOAuthSecret` inside the store, never hand-written.
 */
export function makeInMemoryDynamicClientsDb(): {
  db: DbClient
  rows: Map<string, Record<string, unknown>>
} {
  const rows = new Map<string, Record<string, unknown>>()
  const keyOf = (owner: unknown, ns: unknown, name: unknown) => `${owner}/${ns}/${name}`
  const db = {
    query: async (text: string, values: unknown[] = []) => {
      if (text.includes('INSERT INTO dynamic_clients')) {
        const [
          owner_kind,
          server_namespace,
          server_name,
          issuer,
          client_id,
          client_mode,
          client_secret_encrypted,
          registration_access_token_encrypted,
          registration_client_uri,
          client_id_issued_at,
          client_secret_expires_at,
        ] = values
        rows.set(keyOf(owner_kind, server_namespace, server_name), {
          owner_kind,
          server_namespace,
          server_name,
          issuer,
          client_id,
          client_mode,
          client_secret_encrypted,
          registration_access_token_encrypted,
          registration_client_uri,
          client_id_issued_at,
          client_secret_expires_at,
          created_at: new Date(),
          updated_at: new Date(),
        })
        return { rows: [], rowCount: 1 }
      }
      if (text.includes('DELETE FROM dynamic_clients')) {
        const [owner_kind, server_namespace, server_name] = values
        const existed = rows.delete(keyOf(owner_kind, server_namespace, server_name))
        return { rows: [], rowCount: existed ? 1 : 0 }
      }
      if (text.includes('FROM dynamic_clients')) {
        const [owner_kind, server_namespace, server_name] = values
        const row = rows.get(keyOf(owner_kind, server_namespace, server_name))
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
      }
      return { rows: [], rowCount: 0 }
    },
  } as unknown as DbClient
  return { db, rows }
}

/**
 * The real POST `initialize` 401 challenge the four CIMD pilots emit (Notion/Canva/
 * Linear/Sentry, sondeo 2026-09-25): a Bearer challenge = transport ALIVE, token
 * required. Only presence matters to the probe's `challenge` classification.
 */
const CIMD_INITIALIZE_CHALLENGE = 'Bearer realm="OAuth", error="invalid_token"'

export function makeDiscoveryTransport(pilot: PilotFixture): PinnedTransport {
  const jsonByUrl = new Map<string, string>([
    [pilot.prm.url, pilot.prm.json],
    [pilot.as.url, pilot.as.json],
    ...(pilot.prmRoot ? ([[pilot.prmRoot.url, pilot.prmRoot.json]] as [string, string][]) : []),
  ])
  const notFound = new Set(pilot.prmNotFound ?? [])
  return async ({ url, method }) => {
    // POST → the transport probe (tokenless `initialize`). Per-URL `initialize` table
    // first (Vercel `/mcp`→404, `/`→200); otherwise the typed MCP URL defaults to the
    // real 401 challenge shape (transport alive). Method is undefined-safe.
    if (method === 'POST') {
      const probe = pilot.initialize?.[url]
      if (probe) return { status: probe.status, headers: probe.headers, bodyText: '' }
      if (url === pilot.mcpUrl) {
        return {
          status: 401,
          headers: { 'www-authenticate': pilot.wwwAuthenticate ?? CIMD_INITIALIZE_CHALLENGE },
          bodyText: '',
        }
      }
      return { status: 404, headers: { 'content-type': 'text/html' }, bodyText: 'not found' }
    }
    // GET (discovery): MCP probe → 401 with the challenge header when the fixture has one.
    if (url === pilot.mcpUrl) {
      if (pilot.wwwAuthenticate) {
        return { status: 401, headers: { 'www-authenticate': pilot.wwwAuthenticate }, bodyText: '' }
      }
      // No challenge advertised — probe returns a plain 401 with no hint.
      return { status: 401, headers: {}, bodyText: '' }
    }
    const body = jsonByUrl.get(url)
    if (body !== undefined) {
      return { status: 200, headers: { 'content-type': 'application/json' }, bodyText: body }
    }
    if (notFound.has(url)) return { status: 404, headers: {}, bodyText: 'not found' }
    return { status: 404, headers: {}, bodyText: 'unexpected url' }
  }
}
