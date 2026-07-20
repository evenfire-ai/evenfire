import { Router } from 'express'
import {
  type AdministrativeEventSubmitterPrincipalV1,
  type TracingEventRecord,
  authorizeAdministrativeEventBatch,
  identifyTracingEventFamily,
  parseTracingJsonBody,
  requireAdministrativeEventSubmitter,
  requireTracingEventBatch,
} from '../../middleware/tracingSubmitterAuth.js'
import type { TracingSubmissionResult } from './agentRunEvents.js'

export interface AdministrativeEventSubmissionService {
  submit(input: {
    principal: AdministrativeEventSubmitterPrincipalV1
    events: readonly TracingEventRecord[]
  }): Promise<TracingSubmissionResult>
}

export function createInternalAdministrativeEventsRouter(
  service: AdministrativeEventSubmissionService
): Router {
  const router = Router()

  router.post(
    '/internal/tracing/administrative-events',
    identifyTracingEventFamily('administrative'),
    requireAdministrativeEventSubmitter,
    parseTracingJsonBody,
    requireTracingEventBatch,
    authorizeAdministrativeEventBatch,
    async (req, res, next) => {
      try {
        const result = await service.submit({
          principal: req.administrativeEventSubmitter!,
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
