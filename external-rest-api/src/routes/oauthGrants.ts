import type { NextFunction, Response } from 'express'
import { Router } from 'express'
import { ControlApiError } from '../controlApiClient.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'
import {
  type OauthGrantSummary,
  listOauthGrants,
  revokeOauthGrant,
} from '../services/oauthGrantsService.js'

const PROPAGATED_STATUSES = new Set([400, 401, 403, 404, 409, 422])

/**
 * Project a control-api grant onto the exact public wire shape (spec 04 U2).
 * This is an explicit allowlist — NOT a blind spread — so a new field added to
 * control-api's response can never silently become public API here. The key set
 * is anchored by a contract test (`__tests__/oauthGrants.contract.test.ts`).
 */
function toGrantView(g: OauthGrantSummary): OauthGrantSummary {
  const view: OauthGrantSummary = {
    ownerKind: g.ownerKind,
    recipeNamespace: g.recipeNamespace,
    recipeName: g.recipeName,
    oauthClientId: g.oauthClientId,
    provider: g.provider,
    background: g.background,
    updatedAt: g.updatedAt,
  }
  if (g.mcpServerName !== undefined) view.mcpServerName = g.mcpServerName
  return view
}

function forwardControlApiError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ControlApiError && PROPAGATED_STATUSES.has(error.status)) {
    const body =
      error.body && typeof error.body === 'object' ? error.body : { error: String(error.message) }
    res.status(error.status).json(body)
    return
  }
  next(error)
}

export function createOauthGrantsRouter(): Router {
  const router = Router()

  router.get('/oauth/grants', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const { grants } = await listOauthGrants(extractAuthToken(req))
      res.json({ grants: grants.map(toGrantView) })
    } catch (err) {
      forwardControlApiError(err, res, next)
    }
  })

  router.delete(
    '/oauth/grants/:recipeNamespace/:recipeName/:oauthClientId',
    requireAuth,
    async (req: AuthedRequest, res, next) => {
      try {
        const ownerKind =
          req.query.ownerKind === undefined ? undefined : String(req.query.ownerKind)
        await revokeOauthGrant(
          extractAuthToken(req),
          String(req.params.recipeNamespace),
          String(req.params.recipeName),
          String(req.params.oauthClientId),
          ownerKind
        )
        res.status(204).send()
      } catch (err) {
        forwardControlApiError(err, res, next)
      }
    }
  )

  return router
}
