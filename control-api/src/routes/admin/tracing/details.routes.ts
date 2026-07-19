import { type NextFunction, type Request, type Response, Router } from 'express'
import type {
  AdministrativeEventDetailV1,
  InfrastructureEventDetailV1,
} from '../../../services/tracing/contracts.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface GovernedEventDetailReader {
  administrative(eventId: string): Promise<AdministrativeEventDetailV1 | null>
  infrastructure(eventId: string): Promise<InfrastructureEventDetailV1 | null>
}

export function createAdminTracingDetailsRouter(reader: GovernedEventDetailReader): Router {
  const router = Router()
  const route =
    (kind: 'administrative' | 'infrastructure') =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const eventId = req.params.eventId
        if (!UUID_RE.test(eventId)) {
          res.status(400).json({ error: 'invalid_event_id' })
          return
        }
        const detail = await reader[kind](eventId.toLowerCase())
        if (!detail) {
          res.status(404).json({ error: `${kind}_event_not_found` })
          return
        }
        res.status(200).json(detail)
      } catch (error) {
        next(error)
      }
    }
  router.get('/admin/tracing/administrative/:eventId', route('administrative'))
  router.get('/admin/tracing/infrastructure/:eventId', route('infrastructure'))
  return router
}
