import express, { NextFunction, Request, Response } from 'express'
import { config } from './config.js'
import type { DbClient } from './db.js'
import { K8sGateway } from './k8s.js'
import { type UiAuthedRequest, requireAuthForControlUI } from './middleware/controlUIAuth.js'
import { correlationIdMiddleware } from './middleware/correlationId.js'
import { requireInternalService, requireInternalToken } from './middleware/internalServiceAuth.js'
import {
  createTracingInFlightLimiter,
  getTracingMaxInFlight,
} from './middleware/tracingSubmitterAuth.js'
import { rootLogger } from './observability/logger.js'
import { createAdminAuthRouter } from './routes/admin/auth.js'
import { createAdminRouter } from './routes/admin/index.js'
import { createWorkflowsAdminRouter } from './routes/admin/workflows/index.js'
import { createAuthRoutes } from './routes/auth/index.js'
import { createIdentityProviderCallbackRouter } from './routes/external/identityProviderCallback.js'
import { createExternalRouter } from './routes/external/index.js'
import { createOAuthCallbackRouter } from './routes/external/oauthCallback.js'
import { createGfsRouter } from './routes/gfs/index.js'
import { createHealthRouter } from './routes/health.js'
import { createInternalAdministrativeEventsRouter } from './routes/internal/administrativeEvents.js'
import { createInternalAgentRunEventsRouter } from './routes/internal/agentRunEvents.js'
import { createInternalAuthCallbackRouter } from './routes/internal/authCallback.js'
import { createInternalBudgetsCheckRouter } from './routes/internal/budgetsCheck.js'
import { createInternalInfrastructureTelemetryEventsRouter } from './routes/internal/infrastructureTelemetryEvents.js'
import { createInternalOAuthRouter } from './routes/internal/oauth.js'
import { createInternalPluginWorkloadSdkRouter } from './routes/internal/pluginWorkloadSdk.js'
import { createInternalSandboxUiRouter } from './routes/internal/sandboxUi.js'
import { createInternalApprovalPromptHistoryRouter } from './routes/internal/tracing/approvalPromptHistory.routes.js'
import { createInternalUsageEventsRouter } from './routes/internal/usageEvents.js'
import { createInternalWebhooksRouter } from './routes/internal/webhooks.js'
import { createInternalWorkflowApprovalReaderRouter } from './routes/internal/workflowApprovalReader.js'
import { createMcpHostRoutes } from './routes/mcp-host/index.js'
import { createMetricsRouter } from './routes/metrics.js'
import { createRecipeOauthRouter } from './routes/recipeOauth.js'
import { createRegistryRouter } from './routes/registry.js'
import { createRpcAccessRouter } from './routes/rpc-access/index.js'
import { memberRegistrationErrorResponse } from './services/memberRegistrationErrors.js'
import { setAdministrativeOperationService } from './services/resourceService.js'
import { HccAdministrativeOutcomeBindingResolver } from './services/tracing/adminOperationBindingResolver.js'
import { runWithAdministrativeRequestContext } from './services/tracing/adminOperationContext.js'
import {
  ControlApiAdministrativeOperationService,
  PostgresAdministrativeIntentLookup,
} from './services/tracing/adminOperationService.js'
import { ApprovalPromptHistoryService } from './services/tracing/approvalPromptHistoryService.js'
import { DirectRunAttributionBindingService } from './services/tracing/directRunAttributionBindingService.js'
import { HccHealthTransitionBindingResolver } from './services/tracing/hccHealthTransitionBindingResolver.js'
import { getTracingPools, withTraceIngestTransaction } from './services/tracing/pools.js'
import { meterTracingDbClient } from './services/tracing/queryMeter.js'
import { RouteTracingSubmissionService } from './services/tracing/routeSubmissionService.js'
import {
  AgentRunBindingResolverChain,
  HostReferencedRunBindingResolver,
  WorkflowRunBindingResolver,
} from './services/tracing/workflowRunBindingResolver.js'
import {
  InfrastructureBindingResolverChain,
  WrcInfrastructureBindingResolver,
} from './services/tracing/wrcInfrastructureBindingResolver.js'

const TRACING_INTERNAL_PATH_PREFIX = '/api/v1/internal/tracing/'
const RPC_HOST_ACCESS_PATH = /^\/api\/v1\/rpc\/access\/users\/[^/]+\/mcp-hosts\/[^/]+\/?$/i

// Only errors we construct with these codes are ever forwarded verbatim by the
// global handler (see below). Keeps the blast radius tight: every other
// status-less or non-allowlisted error still collapses to a 500.
const FORWARDABLE_INTEGRATION_CODES = new Set([
  'registry_unavailable',
  'registry_integration_error',
])

export function createApp(gateway: K8sGateway) {
  const traceIngestDb: DbClient = meterTracingDbClient({
    query: (text, params) => getTracingPools().traceIngestPool.query(text, params),
  })
  const app = express()
  app.set('trust proxy', 1)
  const jsonBodyParser = express.json({ limit: config.jsonBodyLimit })
  const tracingInFlightLimiter = createTracingInFlightLimiter(getTracingMaxInFlight())
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.path.startsWith(TRACING_INTERNAL_PATH_PREFIX)) {
      tracingInFlightLimiter(req, res, next)
      return
    }
    if (req.method === 'POST' && RPC_HOST_ACCESS_PATH.test(req.path)) {
      next()
      return
    }
    jsonBodyParser(req, res, next)
  })

  // Correlation ID must be the very first middleware so every downstream log
  // line (including JSON parse errors) carries the id.
  app.use(correlationIdMiddleware)

  // /metrics served without auth (Prometheus scrape, internal only) and
  // outside the /api/v1 mount point so it is not fronted by any auth gate.
  app.use(createMetricsRouter())

  app.use(createHealthRouter(gateway))

  const api = express.Router()
  const tracingSubmissionService = new RouteTracingSubmissionService({
    transaction: withTraceIngestTransaction,
    agentRunBindingResolver: new AgentRunBindingResolverChain([
      new WorkflowRunBindingResolver(traceIngestDb),
      new HostReferencedRunBindingResolver(gateway, traceIngestDb),
    ]),
    administrativeOperationBindingResolver: new HccAdministrativeOutcomeBindingResolver(
      gateway,
      new PostgresAdministrativeIntentLookup(traceIngestDb)
    ),
    infrastructureWorkloadBindingResolver: new InfrastructureBindingResolverChain([
      new HccHealthTransitionBindingResolver(gateway),
      new WrcInfrastructureBindingResolver(traceIngestDb),
    ]),
  })
  const directRunAttributionBindingService = new DirectRunAttributionBindingService(
    withTraceIngestTransaction
  )
  setAdministrativeOperationService(
    new ControlApiAdministrativeOperationService({
      transaction: withTraceIngestTransaction,
    })
  )

  // Allows admin users in the control-ui to authenticate
  api.use(createAdminAuthRouter())

  // Restrict UI auth middleware to /admin/* routes only, excluding /admin/auth/*.
  api.use('/admin', (req, res, next) => {
    if (
      req.path.startsWith('/auth/') ||
      req.path === '/workflows' ||
      req.path.startsWith('/workflows/')
    ) {
      next()
      return
    }
    void requireAuthForControlUI(req, res, next)
  })

  api.use('/admin', (req, _res, next) => {
    const operatorSub = (req as UiAuthedRequest).adminAuth?.sub
    if (!operatorSub) {
      next()
      return
    }
    runWithAdministrativeRequestContext({ operatorSub, requestId: req.correlationId ?? null }, next)
  })

  // All admin/control-ui routes are mounted through a single admin router:
  // overview + resources/secrets + admin profile operations.
  api.use(createAdminRouter(gateway))

  // Internal service API used by external-rest-api and rpc-proxy for auth, directory, and access resolution.
  // Security policy requires both:
  // - Authorization: Bearer <service-token>
  // - x-service-token: <service-name>
  // The service name is mapped to an expected token and checked with timing-safe comparison.

  // mcp-host runtime routes use mcpHostJwt; provisioner issuance routes use InternalControl JWT.
  // Must be mounted BEFORE requireInternalToken which would block them.
  api.use(createMcpHostRoutes(gateway, directRunAttributionBindingService))
  api.use(
    createInternalAgentRunEventsRouter({
      submit: input => tracingSubmissionService.submit(input),
    })
  )
  api.use(
    createInternalApprovalPromptHistoryRouter({
      capture: input =>
        withTraceIngestTransaction(db => new ApprovalPromptHistoryService(db).capture(input)),
    })
  )
  api.use(
    createInternalAdministrativeEventsRouter({
      submit: input => tracingSubmissionService.submit(input),
    })
  )
  api.use(
    createInternalInfrastructureTelemetryEventsRouter({
      submit: input => tracingSubmissionService.submit(input),
    })
  )
  api.use(createInternalUsageEventsRouter())
  api.use(createInternalPluginWorkloadSdkRouter())
  api.use(createInternalBudgetsCheckRouter())
  api.use(createInternalAuthCallbackRouter(gateway))
  api.use(createInternalWebhooksRouter(gateway))
  api.use(createInternalWorkflowApprovalReaderRouter(gateway))
  // OAuth callback receives provider redirects; auth is the signed `state`
  // parameter, not a Clerum cookie or service token. Mounted BEFORE
  // requireInternalToken so the public can hit it.
  api.use(createOAuthCallbackRouter(gateway))
  api.use(createIdentityProviderCallbackRouter())
  api.use(createAuthRoutes(gateway))
  // Recipe OAuth broker — background workloads present a per-recipe broker
  // token (Bearer, aud=oauth-broker). Auth is the broker token itself, not a
  // Clerum cookie or service token, so it is mounted BEFORE requireInternalToken.
  api.use(createRecipeOauthRouter(gateway))

  // Workflow trigger endpoints use control-ui JWT auth (admin users).
  // Mounted BEFORE requireInternalToken — same pattern as mcpHost.
  api.use(createWorkflowsAdminRouter(gateway))

  // Registry identity voucher: control-ui JWT auth applied at the route
  // level. Mounted BEFORE requireInternalToken so unauthenticated callers
  // get 401 from requireAuthForControlUI rather than the service-token gate.
  api.use(createRegistryRouter())

  // gfs (Global File System) human mint contract: POST /api/v1/gfs/token.
  // control-ui JWT auth applied at the route level, so it is mounted BEFORE
  // requireInternalToken (same pattern as the registry/workflows admin routers).
  api.use(createGfsRouter())

  // Unknown GFS control-ui routes must not fall through to the internal
  // service-token gate. Stale UI bundles or mistyped GFS endpoints should
  // surface as ordinary 404s for authenticated operators, not as session
  // expiry 401s that log the browser out.
  api.use('/gfs', requireAuthForControlUI, (_req, res) => {
    res.status(404).json({ error: 'Not Found' })
  })

  // Unknown admin/control-ui routes must not fall through to the internal
  // service-token gate. Otherwise stale UI code can surface as a browser
  // session-expired logout instead of a normal missing-route error.
  api.use('/admin', (_req, res) => {
    res.status(404).json({ error: 'Not Found' })
  })

  api.use(requireInternalToken)
  api.use('/external', requireInternalService('external-rest-api'))
  api.use('/rpc', requireInternalService('rpc-proxy'))
  api.use(createExternalRouter(gateway))
  api.use(createRpcAccessRouter(gateway, directRunAttributionBindingService))
  // Sandbox UI registry: rpc-proxy resolves (recipeNs, recipeName) → upstream
  // Service. requireInternalService('rpc-proxy') is applied per-route inside
  // the router so the `/internal/sandbox-ui/...` path does not collide with
  // the `/external` and `/rpc` prefix gates above.
  api.use(createInternalSandboxUiRouter(gateway))
  // OAuth helpers (rpc-proxy → control-api). Route-level requireInternalService
  // gates the boundary; the public-facing cookie-authed endpoints live in
  // rpc-proxy and forward here with the user identity asserted in the body.
  api.use(createInternalOAuthRouter(gateway))
  app.use('/api/v1', api)

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' })
  })

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    // Use the request-scoped correlation id if middleware ran, otherwise
    // synthesize a short tag for legacy paths.
    const correlationId = req.correlationId ?? Math.random().toString(36).slice(2, 10)
    const log = req.log ?? rootLogger

    // Typed member-registration failures map to 503 (spec §8.6) — scoped
    // instanceof check; the generic 5xx-collapse below stays intact.
    const memberRegistration = memberRegistrationErrorResponse(err)
    if (memberRegistration) {
      log.warn(
        {
          event: memberRegistration.error,
          correlationId,
          err: err instanceof Error ? err.message : String(err),
        },
        'member registration unavailable'
      )
      res.status(memberRegistration.status).json({ error: memberRegistration.error, correlationId })
      return
    }

    // Errors thrown by service-layer code may carry a `.status` field to
    // signal that the upstream response (e.g., registry 404) should be
    // forwarded to the API client rather than collapsed into a 500. Honor
    // 4xx values; 5xx still surface as Internal Server Error so backend
    // failures don't leak through as caller-visible errors.
    const errStatus =
      err instanceof Error && typeof (err as Error & { status?: unknown }).status === 'number'
        ? (err as Error & { status: number }).status
        : undefined
    const isClientError = errStatus !== undefined && errStatus >= 400 && errStatus < 500

    if (isClientError) {
      log.warn(
        {
          event: 'forwarded_client_error',
          correlationId,
          status: errStatus,
          err: err instanceof Error ? err.message : String(err),
        },
        'forwarded client error from upstream'
      )
      res.status(errStatus as number).json({
        error: err instanceof Error ? err.message : 'Bad Request',
        correlationId,
      })
      return
    }

    // Allowlisted registry-integration errors carry a safe code + message we set
    // ourselves (RegistryUnavailableError → 503; the 401 remap → 502). Forward
    // them so the marketplace shows a clear message instead of a raw 500. The
    // message is safe because only our own constructors set these codes.
    const integrationCode = (err as { code?: unknown }).code
    const integrationStatus = (err as { status?: unknown }).status
    if (
      typeof integrationStatus === 'number' &&
      (integrationStatus === 502 || integrationStatus === 503) &&
      typeof integrationCode === 'string' &&
      FORWARDABLE_INTEGRATION_CODES.has(integrationCode)
    ) {
      log.warn(
        {
          event: 'forwarded_registry_integration_error',
          correlationId,
          status: integrationStatus,
          code: integrationCode,
          err: err instanceof Error ? err.message : String(err),
        },
        'forwarded registry integration error'
      )
      res.status(integrationStatus).json({
        error: integrationCode,
        message: err instanceof Error ? err.message : 'Registry integration error',
        correlationId,
      })
      return
    }

    log.error(
      {
        event: 'unhandled_error',
        correlationId,
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      'unhandled error'
    )
    if (process.env.NODE_ENV !== 'production') {
      res.status(500).json({
        error: 'Internal Server Error',
        message: err instanceof Error ? err.message : 'Unknown error',
        correlationId,
      })
    } else {
      res.status(500).json({
        error: 'Internal Server Error',
        correlationId,
      })
    }
  })

  return app
}
