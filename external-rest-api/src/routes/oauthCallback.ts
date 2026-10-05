import { type Request, Router } from 'express'
import { controlApiPassthroughGet } from '../controlApiClient.js'

// Same shape control-api accepts for a remote MCP server name (a K8s resource
// name): lowercase RFC 1123 label, 1-63 chars, no leading/trailing hyphen.
const REMOTE_SERVER_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
// Lowercase only: control-api mints the nonce with crypto.randomUUID(), which is
// always lowercase, so any other casing is not a redirect URI it ever registered.
const INSTALL_NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// control-api's CIMD_ROUTE_PATH (control-api/src/oauth/cimdIdentity.ts), relative to
// the /api/v1 mount on both sides.
const CIMD_PATH = '/.well-known/evenfire-mcp-client'

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
 * Together with the CIMD document below, these are the only public, unauthenticated
 * routes in this gateway, so they MUST stay thin passthroughs: never read or trust
 * anything beyond the validated path segments and the opaque query string.
 */
export function createOauthCallbackRouter(): Router {
  const router = Router()

  // PUBLIC CIMD Client ID Metadata Document (SEP-991). Its URL on this gateway IS the
  // platform's OAuth client_id for the remote MCP-OAuth lane, so a remote AS must be
  // able to fetch it here (control-api serves it at CIMD_PUBLIC_PATH). Fixed path:
  // nothing from the request — no params, no query — reaches the forward, which
  // carries this gateway's service token. The document holds no secrets.
  router.get(CIMD_PATH, async (_req, res, next) => {
    try {
      const result = await controlApiPassthroughGet(CIMD_PATH, '')
      res.status(result.status).type(result.contentType).send(result.body)
    } catch (err) {
      next(err)
    }
  })

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

  return router
}
