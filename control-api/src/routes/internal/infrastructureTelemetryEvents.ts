import { Router } from 'express'
import {
  type InfrastructureTelemetrySubmitterPrincipalV1,
  type TracingEventRecord,
  authorizeInfrastructureTelemetryEventBatch,
  identifyTracingEventFamily,
  parseTracingJsonBody,
  requireInfrastructureTelemetrySubmitter,
  requireTracingEventBatch,
} from '../../middleware/tracingSubmitterAuth.js'
import type { TracingSubmissionResult } from './agentRunEvents.js'

export interface InfrastructureTelemetryEventSubmissionService {
  submit(input: {
    principal: InfrastructureTelemetrySubmitterPrincipalV1
    events: readonly TracingEventRecord[]
  }): Promise<TracingSubmissionResult>
}

export function createInternalInfrastructureTelemetryEventsRouter(
  service: InfrastructureTelemetryEventSubmissionService
): Router {
  const router = Router()

  router.post(
    '/internal/tracing/infrastructure-telemetry-events',
    identifyTracingEventFamily('infrastructure_telemetry'),
    requireInfrastructureTelemetrySubmitter,
    parseTracingJsonBody,
    requireTracingEventBatch,
    authorizeInfrastructureTelemetryEventBatch,
    async (req, res, next) => {
      try {
        const result = await service.submit({
          principal: req.infrastructureTelemetrySubmitter!,
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
