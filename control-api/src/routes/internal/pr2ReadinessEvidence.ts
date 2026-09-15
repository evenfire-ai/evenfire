import { Router } from 'express'
import { asyncHandler } from '../../http/asyncHandler.js'
import { requirePr2RuntimeReadinessWriter } from '../../middleware/pr2ReadinessWriterAuth.js'
import {
  type Pr2ReadinessEvidenceInput,
  parsePr2ReadinessEvidence,
  writePr2ReadinessEvidence,
} from '../../services/access/pr2ReadinessEvidence.js'

export function createInternalPr2ReadinessEvidenceRouter(): Router {
  const router = Router()
  router.post(
    '/internal/pr2-readiness/runtime-evidence',
    requirePr2RuntimeReadinessWriter,
    asyncHandler(async (req, res) => {
      let evidence: Pr2ReadinessEvidenceInput
      try {
        evidence = parsePr2ReadinessEvidence(req.body, 'runtime', req.pr2RuntimeReadinessWriter!)
      } catch {
        res.status(400).json({
          version: 1,
          status: 'rejected',
          code: 'pr2_readiness_evidence_invalid',
        })
        return
      }

      try {
        const disposition = await writePr2ReadinessEvidence(evidence)
        res.status(disposition === 'inserted' ? 201 : 200).json({
          version: 1,
          status: 'accepted',
          disposition,
        })
      } catch (error) {
        if (error instanceof Error && error.message === 'pr2_readiness_source_inactive') {
          res.status(409).json({
            version: 1,
            status: 'rejected',
            code: 'pr2_readiness_source_inactive',
          })
          return
        }
        throw error
      }
    })
  )
  return router
}
