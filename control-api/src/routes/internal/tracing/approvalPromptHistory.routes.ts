import express, { Router } from 'express'
import { requireAgentRunEventSubmitter } from '../../../middleware/tracingSubmitterAuth.js'
import type {
  ApprovalPromptCapture,
  ApprovalPromptCaptureResult,
} from '../../../services/tracing/approvalPromptHistoryService.js'

const BODY_KEYS = new Set([
  'approvalRequestId',
  'runId',
  'hostRef',
  'sessionId',
  'origin',
  'prompt',
])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ORIGINS = new Set(['direct_chat', 'channel_event', 'api'])

export interface ApprovalPromptCaptureWriter {
  capture(input: ApprovalPromptCapture): Promise<ApprovalPromptCaptureResult>
}

function boundedString(value: unknown, max: number): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    value.includes('\0')
  ) {
    return null
  }
  return value
}

export function createInternalApprovalPromptHistoryRouter(
  writer: ApprovalPromptCaptureWriter
): Router {
  const router = Router()
  router.post(
    '/internal/tracing/approval-prompt-history',
    requireAgentRunEventSubmitter,
    express.json({ limit: '40kb', strict: true }),
    async (req, res, next) => {
      try {
        const principal = req.agentRunEventSubmitter
        const body = req.body as Record<string, unknown> | null
        if (
          principal?.kind !== 'mcp_host_runtime' ||
          !body ||
          Array.isArray(body) ||
          Object.keys(body).length !== BODY_KEYS.size ||
          Object.keys(body).some(key => !BODY_KEYS.has(key))
        ) {
          res.status(403).json({ error: 'prompt_history_capture_forbidden' })
          return
        }
        const approvalRequestId = boundedString(body.approvalRequestId, 36)
        const runId = boundedString(body.runId, 36)
        const hostRef = boundedString(body.hostRef, 256)
        const sessionId = boundedString(body.sessionId, 256)
        const prompt = boundedString(body.prompt, 32_768)
        const origin = body.origin
        if (
          !approvalRequestId ||
          !UUID_RE.test(approvalRequestId) ||
          !runId ||
          !UUID_RE.test(runId) ||
          !hostRef ||
          !principal.hostRefs.includes(hostRef) ||
          !sessionId ||
          !prompt ||
          typeof origin !== 'string' ||
          !ORIGINS.has(origin)
        ) {
          res.status(400).json({ error: 'invalid_prompt_history_capture' })
          return
        }
        const result = await writer.capture({
          approvalRequestId,
          approvalKind: 'tool',
          runId,
          hostRef,
          sessionId,
          origin: origin as 'direct_chat' | 'channel_event' | 'api',
          prompt,
          sourceKind: 'mcp_host_runtime',
        })
        res.status(result.status === 'rejected' ? 409 : 202).json(result)
      } catch (error) {
        next(error)
      }
    }
  )
  return router
}
