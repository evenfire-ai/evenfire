import type { Request, Response, Router } from 'express'
import { GFS_SCOPES, type GfsScope, signGfsToken } from '../../auth/gfsToken.js'
import {
  type HostParty,
  IssuerSubjectClassError,
  assertIssuerMaySubject,
} from '../../auth/issuerSubjectClass.js'
import { config } from '../../config.js'
import { makeHostSubjectId } from '../../gfs/hostSubject.js'
import { GFS_READ_SCOPE, provisionerScopesAllowed } from '../../gfs/provisionerScopePolicy.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { requireInternalControlJwt } from '../../middleware/internalControlJwt.js'

/**
 * Provisioner gfs token mint (spec community.md §Mint: two contracts; plan
 * P3-S01). Only HCC/WRC provisioners (InternalControl JWT iss=hcc|wrc) mint
 * `host` tokens here, and each may mint ONLY its own class — enforced by
 * issuerSubjectClass: hcc→host:1st, wrc→host:3rd. Issuance is further gated by
 * CONTROL_API_ALLOWED_ISSUANCE_NAMESPACES so a provisioner can only mint for a
 * namespace it is authorized to issue into. (The human/session `user` token is
 * minted by the separate /gfs/token route — P1.)
 */

const DEFAULT_DRIVE = 'main'
const LEGACY_STANDALONE_HCC_NAMESPACE = 'mcp-host'
const LEGACY_STANDALONE_HCC_NAME = 'standalone'

/** Validate requested scopes against GFS_SCOPES; default to read-only (P3). */
function parseScopes(value: unknown): GfsScope[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [GFS_READ_SCOPE]
  }
  const scopes: GfsScope[] = []
  for (const s of value) {
    if (typeof s !== 'string' || !(GFS_SCOPES as readonly string[]).includes(s)) {
      throw new IssuerSubjectClassError('invalid_scope', `unknown gfs scope: ${String(s)}`)
    }
    scopes.push(s as GfsScope)
  }
  return Array.from(new Set(scopes))
}

export function registerGfsProvisionerTokenRoute(router: Router): void {
  router.post(
    '/auth/gfs/:subject/tokens',
    requireInternalControlJwt,
    asyncHandler(async (req: Request, res: Response) => {
      const provisioner = req.internalControl
      if (!provisioner) {
        res.status(401).json({ error: 'unauthorized' })
        return
      }
      // Issuer → subject class. Provisioners mint only `host`; party is fixed by
      // the issuer (hcc→1st, wrc→3rd). An unknown issuer is rejected explicitly
      // (review finding: do not silently map an unknown issuer to '3rd').
      const ISSUER_PARTY: Partial<Record<string, HostParty>> = { hcc: '1st', wrc: '3rd' }
      const party = ISSUER_PARTY[provisioner.iss]
      if (!party) {
        res.status(403).json({ error: 'unknown_issuer' })
        return
      }
      try {
        assertIssuerMaySubject({ issuer: provisioner.iss, subjectType: 'host', party })
      } catch (err) {
        if (err instanceof IssuerSubjectClassError) {
          res.status(403).json({ error: err.code })
          return
        }
        throw err
      }

      const name = String(req.params.subject ?? '').trim()
      const body = (req.body ?? {}) as { namespace?: unknown; scopes?: unknown; drive?: unknown }
      const namespace = String(body.namespace ?? '')
        .trim()
        .toLowerCase()
      if (!name || !namespace) {
        res.status(400).json({ error: 'subject_invalid' })
        return
      }
      // `host:1st:mcp-host/standalone` is historical fleet-wide grant state,
      // not an individual Host identity. Keep it readable for the bounded
      // cleanup/migration flow, but never mint a new HCC credential for it.
      if (
        provisioner.iss === 'hcc' &&
        namespace === LEGACY_STANDALONE_HCC_NAMESPACE &&
        name === LEGACY_STANDALONE_HCC_NAME
      ) {
        res.status(409).json({ error: 'subject_reserved' })
        return
      }
      if (!config.allowedIssuanceNamespaces.includes(namespace)) {
        res.status(400).json({ error: 'invalid_issuance_namespace' })
        return
      }

      let scopes: GfsScope[]
      try {
        scopes = parseScopes(body.scopes)
      } catch (err) {
        if (err instanceof IssuerSubjectClassError) {
          res.status(400).json({ error: err.code })
          return
        }
        throw err
      }
      if (!provisionerScopesAllowed(party, scopes)) {
        res.status(403).json({ error: 'scope_forbidden' })
        return
      }
      const drive =
        typeof body.drive === 'string' && body.drive.length > 0 ? body.drive : DEFAULT_DRIVE
      const subjectId = makeHostSubjectId(party, namespace, name)
      if (!subjectId) {
        res.status(400).json({ error: 'subject_invalid' })
        return
      }
      const subject = `host:${subjectId}`
      const { token, expiresInSeconds } = signGfsToken({ subject, drive, scopes })
      res.status(200).json({ token, expiresInSeconds, subject })
    })
  )
}
