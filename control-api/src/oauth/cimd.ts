import { Router } from 'express'
import { config } from '../config.js'
import { type Logger, rootLogger } from '../observability/logger.js'
import { normalizeConfiguredOrigin } from '../routes/external/oauthCallback.js'
import { REMOTE_CALLBACK_CLIENT_SEGMENT } from './callback.js'

/**
 * Client ID Metadata Document (CIMD, SEP-991), served by control-api as the
 * platform's OAuth client identity for the remote MCP-OAuth lane (spec 19 §5 C1,
 * D-9 / S-6).
 *
 * The document is Evenfire's *identity as an OAuth client*: its `client_id` IS the
 * public URL the document is served at (SEP-991), so a remote Authorization Server
 * can fetch it to learn our redirect URIs and auth method without any per-AS
 * registration. Because the identity lives in versioned deploy code (this module),
 * not in hot-editable config, it is reviewable and immutable at runtime (S-6):
 * there is NO write path here — the router serves a frozen object on GET only.
 */

export interface CimdDocument {
  /** SEP-991: the client_id IS this document's own public URL (byte-identical to the fetch URL). */
  client_id: string
  client_name: string
  /** Stable remote callback segment; server disambiguation rides the signed `state` (C1.5). */
  redirect_uris: readonly string[]
  /** Public client — no client_secret. */
  token_endpoint_auth_method: 'none'
  grant_types: readonly string[]
  response_types: readonly string[]
  application_type: 'web'
}

/** Path the CIMD document is served at, relative to the `/api/v1` mount in app.ts. */
export const CIMD_ROUTE_PATH = '/.well-known/evenfire-mcp-client'

/** Full public path of the served document (what `client_id` must equal, minus origin). */
const CIMD_PUBLIC_PATH = `/api/v1${CIMD_ROUTE_PATH}`

/**
 * Stable remote-lane callback segment. C1.5 honours this exact oauthClientId, and
 * C2 DCR (`dcr.ts`) derives its `redirect_uris` from the same constant so the CIMD
 * document and a dynamically-registered client advertise a byte-identical callback.
 */
export const REMOTE_CALLBACK_PATH = `/api/v1/oauth-callback/${REMOTE_CALLBACK_CLIENT_SEGMENT}`

/**
 * Build the frozen CIMD document for a given public `origin` (scheme://host, no
 * trailing slash — as produced by `normalizeConfiguredOrigin`). `client_id` is the
 * document's own URL (SEP-991); `redirect_uris` carries the stable remote callback
 * segment. The result is `Object.freeze`d so no caller can mutate the served
 * identity in place (S-6).
 */
export function buildCimdDocument(origin: string): Readonly<CimdDocument> {
  return Object.freeze<CimdDocument>({
    client_id: `${origin}${CIMD_PUBLIC_PATH}`,
    client_name: 'Evenfire',
    redirect_uris: Object.freeze([`${origin}${REMOTE_CALLBACK_PATH}`]),
    token_endpoint_auth_method: 'none',
    grant_types: Object.freeze(['authorization_code', 'refresh_token']),
    response_types: Object.freeze(['code']),
    application_type: 'web',
  })
}

/**
 * Router serving the CIMD document. Read-only (GET), no write path (S-6).
 *
 * Fails closed with 503 when no public callback base URL is configured: unlike the
 * OAuth callback, CIMD must NOT fall back to the request Host — a remote AS fetching
 * this document would otherwise be handed the internal proxy Host as our origin,
 * which would break the SEP-991 `client_id == document URL` identity.
 *
 * `getBaseUrl` is injectable for testing both the served document and the
 * fail-closed path without mutating the process-wide config singleton; it defaults
 * to the same `config.oauthCallbackBaseUrl` the callback redirect uses.
 */
export function createCimdRouter(
  deps: { getBaseUrl?: () => string; logger?: Logger } = {}
): Router {
  const getBaseUrl = deps.getBaseUrl ?? (() => config.oauthCallbackBaseUrl)
  const log = (deps.logger ?? rootLogger).child({ module: 'oauth-cimd' })
  const router = Router()

  router.get(CIMD_ROUTE_PATH, (_req, res) => {
    const origin = normalizeConfiguredOrigin(getBaseUrl())
    if (origin === null) {
      log.error('cimd document requested but no public callback base URL configured')
      return res.status(503).json({ error: 'cimd_base_url_unconfigured' })
    }
    const document = buildCimdDocument(origin)
    return res
      .status(200)
      .type('application/json')
      .set('Cache-Control', 'public, max-age=300')
      .json(document)
  })

  return router
}
