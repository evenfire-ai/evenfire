import type { Router } from 'express'
import { GFS_READ_SCOPE, GFS_SCOPES, type GfsScope, signGfsToken } from '../../auth/gfsToken.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { type UiAuthedRequest, requireAuthForControlUI } from '../../middleware/controlUIAuth.js'

/** The open-core drive is a cluster singleton; the spec names it "main". */
export const GFS_DEFAULT_DRIVE = 'main'

/**
 * Validate caller-requested scopes against the canonical bit set. P1 operator
 * browse is read-only, so when no scopes are requested we mint `gfs.read`.
 * Resolving the scopes a subject actually holds from the grant store is P2; the
 * token is only an upper bound — gfsc re-checks the permission store on every
 * op, so a too-broad token can never grant access the store denies.
 *
 * Returns null on a malformed request (unknown bit, duplicate, non-string).
 */
export function parseRequestedGfsScopes(input: unknown): GfsScope[] | null {
  if (input === undefined) return [GFS_READ_SCOPE]
  if (!Array.isArray(input) || input.length === 0) return null
  const allowed = new Set<string>(GFS_SCOPES)
  const seen = new Set<string>()
  const scopes: GfsScope[] = []
  for (const entry of input) {
    if (typeof entry !== 'string' || !allowed.has(entry) || seen.has(entry)) return null
    seen.add(entry)
    scopes.push(entry as GfsScope)
  }
  return scopes
}

/**
 * POST /api/v1/gfs/token — the human mint contract. A Control UI operator
 * exchanges their admin session for a short-lived gfs access token
 * (`aud=gfs-controller`). pathBindings are deliberately empty in P1: the
 * permission store is the source of truth and gfsc re-checks it on every op
 * (grant-store-driven scope/pathBinding resolution lands in P2). The
 * provisioner mint for host subjects (HCC / WRC) is a separate contract
 * (P3 / P4), never this route.
 */
export function registerGfsTokenRoute(router: Router): void {
  router.post(
    '/gfs/token',
    requireAuthForControlUI,
    asyncHandler(async (req: UiAuthedRequest, res) => {
      const subject = req.adminAuth?.sub
      if (!subject) {
        res.status(401).json({ error: 'unauthorized' })
        return
      }
      const body = (req.body ?? {}) as { drive?: unknown; scopes?: unknown }
      const drive =
        typeof body.drive === 'string' && body.drive.length > 0 ? body.drive : GFS_DEFAULT_DRIVE
      const scopes = parseRequestedGfsScopes(body.scopes)
      if (scopes === null) {
        res.status(400).json({ error: 'invalid_gfs_scopes' })
        return
      }
      const { token, expiresInSeconds } = signGfsToken({
        subject,
        drive,
        scopes,
        pathBindings: [],
      })
      res.status(200).json({ token, expiresInSeconds })
    })
  )
}
