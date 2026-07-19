import { Router } from 'express'
import { ApprovalPromptHistoryService } from '../../../services/tracing/approvalPromptHistoryService.js'
import { InfrastructureCostReadService } from '../../../services/tracing/costRead/infrastructureCostReadService.js'
import { GovernedEventDetailService } from '../../../services/tracing/governedEventDetailService.js'
import { GovernedEventReadService } from '../../../services/tracing/governedEventReadService.js'
import { GovernedSessionReplayService } from '../../../services/tracing/governedSessionReplayService.js'
import { TracingOperationsSnapshotService } from '../../../services/tracing/operations/tracingOperationsSnapshotService.js'
import { withTraceReadTransaction } from '../../../services/tracing/pools.js'
import { PostgresGovernedEventReadRepository } from '../../../services/tracing/postgresGovernedEventReadRepository.js'
import { PostgresGovernedSessionReplayRepository } from '../../../services/tracing/postgresGovernedSessionReplayRepository.js'
import {
  meterTracingDbClient,
  withTracingQueryMeter,
} from '../../../services/tracing/queryMeter.js'
import { createAdminTracingCostsRouter } from './costs.routes.js'
import type { InfrastructureCostReader } from './costs.routes.js'
import { createAdminTracingDetailsRouter } from './details.routes.js'
import { createAdminTracingEventsRouter } from './events.routes.js'
import { createAdminTracingOperationsRouter } from './operations.routes.js'
import type { TracingOperationsReader } from './operations.routes.js'
import { createAdminTracingPromptHistoryRouter } from './promptHistory.routes.js'
import { createAdminTracingRunsRouter } from './runs.routes.js'
import type { GovernedEventReader } from './runs.routes.js'
import { createAdminTracingSessionsRouter } from './sessions.routes.js'

function createDefaultReader(): GovernedEventReader {
  return {
    read: query => {
      const families = query.families ?? []
      const family = families.length === 1 ? families[0] : 'mixed'
      return withTracingQueryMeter(family, 'event_list', () =>
        withTraceReadTransaction(db =>
          new GovernedEventReadService(
            new PostgresGovernedEventReadRepository(meterTracingDbClient(db))
          ).read(query)
        )
      )
    },
  }
}

function createDefaultCostReader(): InfrastructureCostReader {
  return {
    read: query =>
      withTraceReadTransaction(db => new InfrastructureCostReadService(db).read(query)),
    listScopes: () =>
      withTraceReadTransaction(db => new InfrastructureCostReadService(db).listScopes()),
  }
}

function createDefaultOperationsReader(): TracingOperationsReader {
  return new TracingOperationsSnapshotService()
}

export function createAdminTracingRouter(
  reader: GovernedEventReader = createDefaultReader(),
  costReader: InfrastructureCostReader = createDefaultCostReader(),
  operationsReader: TracingOperationsReader = createDefaultOperationsReader()
): Router {
  const router = Router()
  const sessionReader = {
    list: (input: Parameters<GovernedSessionReplayService['list']>[0]) =>
      withTracingQueryMeter('agent_run', 'session_list', () =>
        withTraceReadTransaction(db =>
          new GovernedSessionReplayService(
            new PostgresGovernedSessionReplayRepository(meterTracingDbClient(db))
          ).list(input)
        )
      ),
    detail: (input: Parameters<GovernedSessionReplayService['detail']>[0]) =>
      withTracingQueryMeter('agent_run', 'session_detail', () =>
        withTraceReadTransaction(db =>
          new GovernedSessionReplayService(
            new PostgresGovernedSessionReplayRepository(meterTracingDbClient(db))
          ).detail(input)
        )
      ),
  }
  router.use(createAdminTracingSessionsRouter(sessionReader))
  const detailReader = {
    administrative: (eventId: string) =>
      withTracingQueryMeter('administrative', 'administrative_detail', () =>
        withTraceReadTransaction(db =>
          new GovernedEventDetailService(meterTracingDbClient(db)).administrative(eventId)
        )
      ),
    infrastructure: (eventId: string) =>
      withTracingQueryMeter('infrastructure_telemetry', 'infrastructure_detail', () =>
        withTraceReadTransaction(db =>
          new GovernedEventDetailService(meterTracingDbClient(db)).infrastructure(eventId)
        )
      ),
  }
  router.use(createAdminTracingDetailsRouter(detailReader))
  router.use(createAdminTracingRunsRouter(reader))
  router.use(createAdminTracingEventsRouter(reader))
  router.use(createAdminTracingCostsRouter(costReader))
  router.use(createAdminTracingOperationsRouter(operationsReader))
  router.use(
    createAdminTracingPromptHistoryRouter({
      read: approvalRequestId =>
        withTracingQueryMeter('agent_run', 'approval_prompt_detail', () =>
          withTraceReadTransaction(db =>
            new ApprovalPromptHistoryService(meterTracingDbClient(db)).read(approvalRequestId)
          )
        ),
    })
  )
  return router
}
