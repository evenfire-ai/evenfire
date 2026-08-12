import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import {
  type ExternalAuthedRequest,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import { deleteOAuthGrant, listUserOAuthGrants } from '../../oauth/store.js'

function dbClient() {
  return { query: (text: string, values?: unknown[]) => pool.query(text, values) }
}

/**
 * User-facing OAuth grant management (Profile UI → external-rest-api → here).
 *
 * Identity comes ONLY from the verified session token (req.externalAuth.userId);
 * a user can only ever see or revoke their own grants. Revocation is fail-closed:
 * the per-user broker returns 404 after the row is deleted.
 *
 * [SEC] userId is never taken from body or path params.
 */
export function createExternalOauthGrantsRouter(): Router {
  const router = Router()
  const externalOauthGrantsRateLimit = rateLimit({
    windowMs: 60_000,
    limit: config.approvalRlExternalPerMin,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })

  // GET /external/oauth/grants
  // Returns all grants for the authenticated user.
  router.get(
    '/external/oauth/grants',
    externalOauthGrantsRateLimit,
    requireValidExternalSessionToken,
    (req: ExternalAuthedRequest, res, next) => {
      void (async () => {
        try {
          const userId = req.externalAuth?.userId
          if (!userId) {
            res.status(401).json({ error: 'Unauthorized' })
            return
          }
          const grants = await listUserOAuthGrants(dbClient(), userId)
          res.status(200).json({
            grants: grants.map(g => ({ ...g, updatedAt: g.updatedAt.toISOString() })),
          })
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // DELETE /external/oauth/grants/:recipeNamespace/:recipeName/:oauthClientId
  // Revokes one grant for the authenticated user. Idempotent: 204 whether or not a
  // row existed (no information leak).
  router.delete(
    '/external/oauth/grants/:recipeNamespace/:recipeName/:oauthClientId',
    externalOauthGrantsRateLimit,
    requireValidExternalSessionToken,
    (req: ExternalAuthedRequest, res, next) => {
      void (async () => {
        try {
          const userId = req.externalAuth?.userId
          if (!userId) {
            res.status(401).json({ error: 'Unauthorized' })
            return
          }
          await deleteOAuthGrant(dbClient(), {
            grantKind: 'user',
            recipeNamespace: String(req.params.recipeNamespace),
            recipeName: String(req.params.recipeName),
            userId,
            oauthClientId: String(req.params.oauthClientId),
          })
          res.status(204).end()
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  return router
}
