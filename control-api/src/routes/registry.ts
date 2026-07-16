import { Router } from 'express'
import { type UiAuthedRequest, requireAuthForControlUI } from '../middleware/controlUIAuth.js'
import { rateLimitMiddleware } from '../middleware/rateLimitMiddleware.js'
import { findAdminById } from '../services/adminAuthService.js'
import { VoucherUnavailableError, mintIdentityVoucher } from '../services/registryVoucher.js'

/**
 * Issues short-lived identity vouchers the Control UI exchanges with
 * evenfire-registry for a bearer token (POST /api/v1/user/exchange).
 *
 * VOUCHER V2 (spec §6.4/§14.6): a 60s RS256 JWT whose header carries `kid`
 * (the registry-assigned key_id) and whose payload is EXACTLY
 * {iss:'control-api', aud:'registry-api', sub, jti, exp} — no email, no
 * username, no iat. The kid + signing key are resolved mode-aware
 * (managed = env Secret; self-hosted = the registry_connection DB row); the
 * registry resolves kid → deployment key and derives identity from
 * (deployment_id, sub). See services/registryVoucher.ts.
 */
export function createRegistryRouter(): Router {
  const router = Router()

  router.post(
    '/registry/identity-voucher',
    requireAuthForControlUI,
    // Per-admin token bucket — voucher signing does RS256 (CPU-expensive),
    // so cap each admin at 30/min. Matches the per-key bucket pattern used
    // by recipeOauth and other sensitive admin endpoints in this service.
    rateLimitMiddleware({
      bucketType: 'registry_identity_voucher',
      maxPerMinute: 30,
      getBucketKey: req => {
        const sub = (req as UiAuthedRequest).adminAuth?.sub
        return sub ? `voucher:${sub}` : null
      },
    }),
    async (req: UiAuthedRequest, res, next) => {
      try {
        const claims = req.adminAuth
        if (!claims?.sub) {
          res.status(401).json({ error: 'unauthorized' })
          return
        }

        const admin = await findAdminById(claims.sub)
        if (!admin || admin.status !== 'active') {
          res.status(401).json({ error: 'unauthorized' })
          return
        }

        let voucher: string
        try {
          voucher = await mintIdentityVoucher(admin)
        } catch (err) {
          if (err instanceof VoucherUnavailableError) {
            res.status(500).json({ error: 'registry_voucher_unavailable' })
            return
          }
          throw err
        }

        res.status(200).json({ voucher })
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}
