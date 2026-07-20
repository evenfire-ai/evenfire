import { Router } from 'express'
import {
  type AgentRunEventSubmitterPrincipalV1,
  type TracingEventRecord,
  authorizeAgentRunEventBatch,
  identifyTracingEventFamily,
  parseTracingJsonBody,
  requireAgentRunEventSubmitter,
  requireTracingEventBatch,
} from '../../middleware/tracingSubmitterAuth.js'

export type TracingSubmissionResult = {
  accepted: number
  replayed: number
}

export interface AgentRunEventSubmissionService {
  submit(input: {
    principal: AgentRunEventSubmitterPrincipalV1
    events: readonly TracingEventRecord[]
  }): Promise<TracingSubmissionResult>
}

export function createInternalAgentRunEventsRouter(
  service: AgentRunEventSubmissionService
): Router {
  const router = Router()

  router.post(
    '/internal/tracing/agent-run-events',
    identifyTracingEventFamily('agent_run'),
    requireAgentRunEventSubmitter,
    parseTracingJsonBody,
    requireTracingEventBatch,
    authorizeAgentRunEventBatch,
    async (req, res, next) => {
      try {
        const result = await service.submit({
          principal: req.agentRunEventSubmitter!,
          events: req.tracingEvents!,
        })
        res.status(200).json(result)
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}
