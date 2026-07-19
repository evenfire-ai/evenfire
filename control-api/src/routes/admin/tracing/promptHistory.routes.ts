import { Router } from 'express'
import type { ApprovalPromptHistoryReadV1 } from '../../../services/tracing/contracts.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface ApprovalPromptHistoryReader {
  read(approvalRequestId: string): Promise<ApprovalPromptHistoryReadV1>
}

export function createAdminTracingPromptHistoryRouter(reader: ApprovalPromptHistoryReader): Router {
  const router = Router()
  router.get(
    '/admin/tracing/approvals/:approvalRequestId/prompt-history',
    async (req, res, next) => {
      try {
        res.setHeader('Cache-Control', 'no-store')
        const approvalRequestId = req.params.approvalRequestId
        if (!UUID_RE.test(approvalRequestId)) {
          res.status(400).json({ error: 'invalid_approval_request_id' })
          return
        }
        res.status(200).json(await reader.read(approvalRequestId.toLowerCase()))
      } catch (error) {
        next(error)
      }
    }
  )
  return router
}
