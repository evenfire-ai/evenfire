import { type Request, Router } from 'express'
import { controlApiPassthroughGet } from '../controlApiClient.js'

// Same shape control-api accepts for a remote MCP server name (a K8s resource
// name): lowercase RFC 1123 label, 1-63 chars, no leading/trailing hyphen.
const REMOTE_SERVER_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
// Lowercase only: control-api mints the nonce with crypto.randomUUID(), which is
// always lowercase, so any other casing is not a redirect URI it ever registered.
const INSTALL_NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// Client ID Metadata Document (SEP-991) for the remote MCP-OAuth lane. Must equal
// control-api's CIMD_ROUTE_PATH (control-api/src/oauth/cimdIdentity.ts): the CIMD
// client_id is `<public origin>/api/v1` + this path, and a remote Authorization Server
// fetches that URL through this gateway.
const CIMD_ROUTE_PATH = '/.well-known/evenfire-mcp-client'

function rawQueryOf(req: Request): string {
  const queryStart = req.originalUrl.indexOf('?')
  return queryStart >= 0 ? req.originalUrl.slice(queryStart) : ''
}

/**
 * PUBLIC OAuth callback. The provider (Google, …) redirects the user's browser
 * here after consent — there is no Clerum session or bearer token; authentication
 * IS the signed `state`, which control-api re-verifies. We forward the request to
 * control-api's stable callback endpoint verbatim — the raw query string is passed
 * untouched so the signed `state` and `code` are never re-encoded — and relay its
 * response, including the HTML success page that bounces to clerum://oauth-completed.
 *
 * These, together with the CIMD document below, are the only public, unauthenticated
 * routes in this gateway, so they MUST stay thin passthroughs: never read or trust
 * anything beyond the validated path segments and the opaque query string.
 */
export function createOauthCallbackRouter(): Router {
  const router = Router()

  // Per-server remote callback (/remote/<serverName>[/<installNonce>]). The forward
  // carries this gateway's service token, so an unvalidated segment (e.g. a decoded
  // `../admin`) would turn a public URL into an authenticated GET against any
  // control-api path. Segments are therefore allow-listed before anything is sent,
  // and the forwarded path is rebuilt only from them.
  router.get('/oauth-callback/remote/:serverName/:installNonce?', async (req, res, next) => {
    const serverName = String(req.params.serverName)
    const installNonce = req.params.installNonce
    if (
      !REMOTE_SERVER_NAME_RE.test(serverName) ||
      (installNonce !== undefined && !INSTALL_NONCE_RE.test(installNonce))
    ) {
      res.status(404).json({ error: 'Not Found' })
      return
    }
    try {
      const path =
        `/oauth-callback/remote/${encodeURIComponent(serverName)}` +
        (installNonce !== undefined ? `/${encodeURIComponent(installNonce)}` : '')
      const result = await controlApiPassthroughGet(path, rawQueryOf(req))
      res.status(result.status).type(result.contentType).send(result.body)
    } catch (err) {
      next(err)
    }
  })

  router.get('/oauth-callback/:oauthClientId', async (req, res, next) => {
    try {
      const result = await controlApiPassthroughGet(
        `/oauth-callback/${encodeURIComponent(String(req.params.oauthClientId))}`,
        rawQueryOf(req)
      )
      res.status(result.status).type(result.contentType).send(result.body)
    } catch (err) {
      next(err)
    }
  })

  // PUBLIC CIMD document: a remote Authorization Server fetches our OAuth client
  // identity here. Fixed path, no caller-controlled segment and no query string are
  // forwarded (the forward carries this gateway's service token). Express answers
  // HEAD through this GET handler.
  router.get(CIMD_ROUTE_PATH, async (_req, res, next) => {
    try {
      const result = await controlApiPassthroughGet(CIMD_ROUTE_PATH, '')
      res.status(result.status).type(result.contentType).send(result.body)
    } catch (err) {
      next(err)
    }
  })

  return router
}
