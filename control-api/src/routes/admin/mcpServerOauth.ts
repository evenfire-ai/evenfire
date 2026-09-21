import { Router } from 'express'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { RFC1123_RE } from '../../http/rfc1123.js'
import { UiAuthedRequest } from '../../middleware/controlUIAuth.js'
import { deleteOAuthGrant, listUserGrantsForServer } from '../../oauth/store.js'
import { rootLogger } from '../../observability/logger.js'

/**
 * Admin oversight for mcp-server OAuth user-grants (spec 04 U3) — the mirror of
 * the recipe lane (`recipeOauth.ts`) for `owner_kind='mcpserver'`. Mounted under
 * `/admin/*`, so `requireAuthForControlUI` (app.ts) has already authenticated the
 * caller as a control-ui admin.
 *
 * DEC-R2 (re-scope): a remote grant's coordinate (`oauth.id` = self-URL / base64
 * client_id) is NOT an RFC1123 label and is not even representable as a URL path
 * segment. So — unlike the recipe lane, where the client id is an RFC1123 path
 * param — the force-revoke takes the `oauthClientId` in the JSON BODY. Only the
 * server `:name` (a real RFC1123 label) stays in the path.
 *
 * The server namespace is always forced to `config.mcpServersNamespace`, never
 * taken from the request.
 */

const MCP_SERVER_NAMESPACE = config.mcpServersNamespace
const BASE = '/admin/mcp-servers'

function dbClient() {
  return { query: (text: string, values?: unknown[]) => pool.query(text, values) }
}

export function createAdminMcpServerOauthRouter(): Router {
  const router = Router()
  const log = rootLogger.child({ module: 'admin-mcpserver-oauth' })

  // GET /admin/mcp-servers/:name/oauth/user-grants
  // Read-only list of every user with a grant for this server (across clients).
  // Namespace is forced to MCP_SERVER_NAMESPACE — never taken from the request.
  router.get(
    `${BASE}/:name/oauth/user-grants`,
    asyncHandler(async (req: UiAuthedRequest, res) => {
      const { name } = req.params
      if (!RFC1123_RE.test(name)) {
        res.status(400).json({ error: 'invalid_request' })
        return
      }
      const users = await listUserGrantsForServer(dbClient(), {
        namespace: MCP_SERVER_NAMESPACE,
        name,
      })
      res.status(200).json({
        users: users.map(u => ({ ...u, updatedAt: u.updatedAt.toISOString() })),
      })
    })
  )

  // DELETE /admin/mcp-servers/:name/oauth/user-grants/:userId   body: { oauthClientId }
  // Force-revoke one user's grant (admin oversight). The client id is arbitrary
  // (self-URL / base64), so it rides in the body and is NOT RFC1123-validated.
  // Namespace is forced to MCP_SERVER_NAMESPACE. Idempotent: 204 whether or not a
  // row existed.
  //
  // Force-revoke deletes ONLY this user's grant row. It does NOT delete
  // `dynamic_clients` (per-server-CR, shared across users); that teardown lives
  // in the server-CR uninstall (DEC-R2 §3).
  router.delete(
    `${BASE}/:name/oauth/user-grants/:userId`,
    asyncHandler(async (req: UiAuthedRequest, res) => {
      const { name, userId } = req.params
      if (!RFC1123_RE.test(name)) {
        res.status(400).json({ error: 'invalid_request' })
        return
      }
      if (typeof userId !== 'string' || userId.length === 0) {
        res.status(400).json({ error: 'invalid_request' })
        return
      }
      const { oauthClientId } = (req.body ?? {}) as { oauthClientId?: unknown }
      if (typeof oauthClientId !== 'string' || oauthClientId.length === 0) {
        res.status(400).json({ error: 'invalid_request' })
        return
      }
      const adminUserId = req.adminAuth?.sub
      if (!adminUserId) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      await deleteOAuthGrant(dbClient(), {
        grantKind: 'user',
        ownerKind: 'mcpserver',
        recipeNamespace: MCP_SERVER_NAMESPACE,
        recipeName: name,
        userId,
        oauthClientId,
      })
      // Audit trail (sensitive: a revocation). Structured, pino-redacted; the
      // same event the recipe lane emits, parameterised with owner_kind mcpserver.
      log.info(
        {
          event: 'oauth_user_grant_force_revoked',
          ownerKind: 'mcpserver',
          mcpServerNamespace: MCP_SERVER_NAMESPACE,
          mcpServerName: name,
          oauthClientId,
          targetUserId: userId,
          adminUserId,
        },
        'force-revoked user grant'
      )
      res.status(204).end()
    })
  )

  return router
}
