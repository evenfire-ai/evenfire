import { Router } from 'express'
import { type UiAuthedRequest, requireAuthForControlUI } from '../middleware/controlUIAuth.js'
import { rateLimitMiddleware } from '../middleware/rateLimitMiddleware.js'
import { findAdminById } from '../services/adminAuthService.js'
import { VoucherUnavailableError, mintIdentityVoucher } from '../services/registryVoucher.js'

/**
 * Issues short-lived identity vouchers that the Control UI can exchange with
 * evenfire-registry for a bearer access token (npm-style auth, spec §B).
 *
 * The voucher is a 60-second RS256 JWT signed with — in preference order —
 * `config.registryVoucherPrivateKey` (a dedicated keypair, recommended for
 * production) or `config.adminJwtPrivateKey` (fallback so existing
 * deployments keep working without a new Secret). The registry verifies it
 * with the matching public key configured via `CONTROL_API_PUBLIC_KEY`.
 *
 * Why a dedicated voucher key matters: the admin JWT key also signs admin
 * session tokens (aud=control-ui, 1h TTL). If those tokens were signed by
 * the SAME key as a voucher (aud=registry-api, 60s TTL), a captured admin
 * session token would become a usable voucher the moment the registry
 * loosens its `aud` check. Provisioning a separate keypair eliminates that
 * confused-deputy class entirely.
 *
 * Claim shape mirrors the spec:
 *   iss: "control-api"
 *   aud: "registry-api"
 *   sub: control-ui admin user id
 *   email / username: derived from `control_admin_users`
 *   jti: random UUID (one-time-use; the registry stores it for replay
 *        protection within the 60s window)
 *   exp: now + 60s
 *
 * Admin users in `control_admin_users` have only `username` (no email
 * column), so we synthesize a deterministic admin-only email of the form
 * `<username>@control-api.local`. The registry treats this as the linking
 * identity for the per-tenant Clerum control plane.
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
          voucher = mintIdentityVoucher(admin)
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
