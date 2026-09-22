import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { createInternalAdministrativeEventsRouter } from '../src/routes/internal/administrativeEvents.js'
import { createInternalAgentRunEventsRouter } from '../src/routes/internal/agentRunEvents.js'
import { createInternalInfrastructureTelemetryEventsRouter } from '../src/routes/internal/infrastructureTelemetryEvents.js'
import { HccAdministrativeOutcomeBindingResolver } from '../src/services/tracing/adminOperationBindingResolver.js'
import { administrativeIntentLookupKey } from '../src/services/tracing/adminOperationService.js'
import {
  TracingIdempotencyConflictError,
  UnsafeTracingInputError,
} from '../src/services/tracing/append.js'
import type { TracingTransactionRunner } from '../src/services/tracing/contracts.js'
import { HccHealthTransitionBindingResolver } from '../src/services/tracing/hccHealthTransitionBindingResolver.js'
import {
  InvalidTracingInputError,
  RouteTracingSubmissionService,
  TracingBindingUnavailableError,
} from '../src/services/tracing/routeSubmissionService.js'
import { issueMcpHostAccessJwt } from '../src/utils/auth/mcpHostJwtToken.js'

function signInternalControl(issuer: 'hcc' | 'wrc'): string {
  return jwt.sign(
    {
      iss: issuer,
      aud: 'control-api',
      sub: `${issuer}-provisioner`,
    },
    issuer === 'hcc'
      ? config.internalControlJwtHccHmacSecret
      : config.internalControlJwtWrcHmacSecret,
    {
      algorithm: 'HS256',
      expiresIn: 60,
      jwtid: `${issuer}-route-test`,
    }
  )
}

function appWith(router: express.Router) {
  const app = express()
  app.use(router)
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: error instanceof Error ? error.message : 'unknown' })
    }
  )
  return app
}

function submissionService() {
  return {
    submit: vi.fn(async ({ events }: { events: readonly Record<string, unknown>[] }) => ({
      accepted: events.length,
      replayed: 0,
    })),
  }
}

describe('internal tracing submission routers', () => {
  it('submits agent-run records once with exact WRC authority', async () => {
    const service = submissionService()
    const app = appWith(createInternalAgentRunEventsRouter(service))
    const wrcAuthority = signInternalControl('wrc')
    const events = [
      {
        eventType: 'run_start',
        runId: '11111111-1111-4111-8111-111111111111',
        sourceEventId: 'start-1',
      },
    ]

    const response = await request(app)
      .post('/internal/tracing/agent-run-events')
      .set('Authorization', `Bearer ${wrcAuthority}`)
      .send({ events })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ accepted: 1, replayed: 0 })
    expect(service.submit).toHaveBeenCalledOnce()
    expect(service.submit).toHaveBeenCalledWith({
      principal: expect.objectContaining({
        kind: 'wrc_internal_control',
        sourceService: 'workflow-recipes',
        serviceSub: 'wrc-provisioner',
      }),
      events,
    })
  })

  it('submits administrative records once with exact HCC authority', async () => {
    const service = submissionService()
    const app = appWith(createInternalAdministrativeEventsRouter(service))
    const events = [{ kind: 'linked_outcome', operationId: 'operation-1' }]

    const response = await request(app)
      .post('/internal/tracing/administrative-events')
      .set('Authorization', `Bearer ${signInternalControl('hcc')}`)
      .send({ events })

    expect(response.status).toBe(200)
    expect(service.submit).toHaveBeenCalledWith({
      principal: expect.objectContaining({
        kind: 'hcc_internal_control',
        allowedKinds: ['linked_outcome'],
      }),
      events,
    })
  })

  it('submits infrastructure records once with exact WRC authority', async () => {
    const service = submissionService()
    const app = appWith(createInternalInfrastructureTelemetryEventsRouter(service))
    const events = [{ telemetryType: 'reconcile_outcome', sourceEventId: 'reconcile-1' }]

    const response = await request(app)
      .post('/internal/tracing/infrastructure-telemetry-events')
      .set('Authorization', `Bearer ${signInternalControl('wrc')}`)
      .send({ events })

    expect(response.status).toBe(200)
    expect(service.submit).toHaveBeenCalledWith({
      principal: expect.objectContaining({
        kind: 'wrc_internal_control',
        resourceAuthority: 'wrc_managed',
      }),
      events,
    })
  })

  it('returns 400 for malformed JSON without calling the service', async () => {
    const service = submissionService()
    const app = appWith(createInternalAgentRunEventsRouter(service))
    const authority = signInternalControl('wrc')

    const response = await request(app)
      .post('/internal/tracing/agent-run-events')
      .auth(authority, { type: 'bearer' })
      .set('Content-Type', 'application/json')
      .send('{"events":')

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'invalid_json' })
    expect(service.submit).not.toHaveBeenCalled()
  })

  it.each([
    [{}, 'events_required'],
    [{ events: [] }, 'events_required'],
    [{ events: [null] }, 'invalid_event'],
  ] as const)('returns 400 for an invalid batch %#', async (body, error) => {
    const service = submissionService()
    const app = appWith(createInternalAgentRunEventsRouter(service))
    const { token } = issueMcpHostAccessJwt('sandbox-recipes', 'trace-recipe')

    const response = await request(app)
      .post('/internal/tracing/agent-run-events')
      .set('Authorization', `Bearer ${token}`)
      .send(body)

    expect(response.status).toBe(400)
    expect(response.body.error).toBe(error)
    expect(service.submit).not.toHaveBeenCalled()
  })

  it('returns 413 for more than 100 events', async () => {
    const service = submissionService()
    const app = appWith(createInternalAgentRunEventsRouter(service))
    const { token } = issueMcpHostAccessJwt('sandbox-recipes', 'trace-recipe')

    const response = await request(app)
      .post('/internal/tracing/agent-run-events')
      .set('Authorization', `Bearer ${token}`)
      .send({ events: Array.from({ length: 101 }, (_, index) => ({ index })) })

    expect(response.status).toBe(413)
    expect(response.body).toEqual({ error: 'batch_too_large', max: 100, got: 101 })
    expect(service.submit).not.toHaveBeenCalled()
  })

  it('returns 413 when the JSON body exceeds 512 KiB', async () => {
    const service = submissionService()
    const app = appWith(createInternalAgentRunEventsRouter(service))
    const authority = signInternalControl('wrc')

    const response = await request(app)
      .post('/internal/tracing/agent-run-events')
      .auth(authority, { type: 'bearer' })
      .send({ events: [{ payload: 'x'.repeat(512 * 1024) }] })

    expect(response.status).toBe(413)
    expect(response.body).toEqual({ error: 'payload_too_large', maxBytes: 512 * 1024 })
    expect(service.submit).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated callers before parsing malformed bodies for every family', async () => {
    const cases = [
      {
        path: '/internal/tracing/agent-run-events',
        router: createInternalAgentRunEventsRouter,
      },
      {
        path: '/internal/tracing/administrative-events',
        router: createInternalAdministrativeEventsRouter,
      },
      {
        path: '/internal/tracing/infrastructure-telemetry-events',
        router: createInternalInfrastructureTelemetryEventsRouter,
      },
    ]

    for (const testCase of cases) {
      const service = submissionService()
      const response = await request(appWith(testCase.router(service)))
        .post(testCase.path)
        .set('Content-Type', 'application/json')
        .send('{"events":')

      expect(response.status).toBe(403)
      expect(response.body).toEqual({ error: 'tracing_submission_forbidden' })
      expect(service.submit).not.toHaveBeenCalled()
    }
  })

  it('returns 403 at each family boundary for a credential without submission authority', async () => {
    const mcpToken = issueMcpHostAccessJwt('sandbox-recipes', 'trace-recipe').token
    const cases = [
      {
        app: appWith(createInternalAgentRunEventsRouter(submissionService())),
        path: '/internal/tracing/agent-run-events',
        token: mcpToken,
      },
      {
        app: appWith(createInternalAdministrativeEventsRouter(submissionService())),
        path: '/internal/tracing/administrative-events',
        token: mcpToken,
      },
      {
        app: appWith(createInternalInfrastructureTelemetryEventsRouter(submissionService())),
        path: '/internal/tracing/infrastructure-telemetry-events',
        token: mcpToken,
      },
    ]

    for (const testCase of cases.slice(1)) {
      const response = await request(testCase.app)
        .post(testCase.path)
        .set('Authorization', `Bearer ${testCase.token}`)
        .send({ events: [{ eventType: 'attempted_cross_family_submission' }] })
      expect(response.status).toBe(403)
      expect(response.body).toEqual({ error: 'tracing_submission_forbidden' })
    }
  })

  it('rejects an otherwise valid WRC principal submitting a non-workflow agent event', async () => {
    const service = submissionService()
    const app = appWith(createInternalAgentRunEventsRouter(service))

    const response = await request(app)
      .post('/internal/tracing/agent-run-events')
      .set('Authorization', `Bearer ${signInternalControl('wrc')}`)
      .send({ events: [{ eventType: 'tool_call' }] })

    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'tracing_event_forbidden', index: 0 })
    expect(service.submit).not.toHaveBeenCalled()
  })

  it('rejects an otherwise valid HCC principal submitting a service action', async () => {
    const service = submissionService()
    const app = appWith(createInternalAdministrativeEventsRouter(service))

    const response = await request(app)
      .post('/internal/tracing/administrative-events')
      .set('Authorization', `Bearer ${signInternalControl('hcc')}`)
      .send({ events: [{ kind: 'service_action' }] })

    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'tracing_event_forbidden', index: 0 })
    expect(service.submit).not.toHaveBeenCalled()
  })

  it('rejects an unknown family discriminator as 400', async () => {
    const service = submissionService()
    const app = appWith(createInternalInfrastructureTelemetryEventsRouter(service))

    const response = await request(app)
      .post('/internal/tracing/infrastructure-telemetry-events')
      .set('Authorization', `Bearer ${signInternalControl('hcc')}`)
      .send({ events: [{ telemetryType: 'raw_log' }] })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'invalid_telemetry_type', index: 0 })
    expect(service.submit).not.toHaveBeenCalled()
  })
})

// HCC settles a submission without retry only on these (status, code) pairs
// (#326), so the code has to survive the real router and the global handler.
describe('internal tracing submission routers — rejection code on the wire', () => {
  const HOST_UID = '6f1c2f3a-2f4b-4d3a-9b2e-7c0d1a5e8b44'

  /**
   * The real router over the real submission service, the real HCC resolver and
   * the global handler. Only the API-server read and the database append are
   * doubles, so everything the request actually has to pass through is wired.
   */
  function realInfrastructureApp() {
    const getResource = vi.fn().mockResolvedValue({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'Host',
      metadata: { name: 'chatllm', namespace: 'mcp-host', uid: HOST_UID, generation: 7 },
    })
    const appendManyInTransaction = vi.fn().mockResolvedValue([
      {
        kind: 'accepted' as const,
        accepted: 1,
        replayed: 0,
        family: 'infrastructure_telemetry' as const,
        eventId: '11111111-1111-4111-8111-111111111111',
        streamSequence: '41',
        payloadSha256: 'a'.repeat(64),
        ingestedAt: '2026-07-10T10:00:00.000Z',
      },
    ])
    const db = { query: vi.fn() } as unknown as DbClient
    const service = new RouteTracingSubmissionService({
      transaction: (async (work: (client: DbClient) => Promise<unknown>) =>
        work(db)) as unknown as TracingTransactionRunner,
      infrastructureWorkloadBindingResolver: new HccHealthTransitionBindingResolver({
        getResource,
      }),
      infrastructureTelemetryAppender: { appendManyInTransaction },
    })
    const app = express()
    app.use(createInternalInfrastructureTelemetryEventsRouter(service))
    app.use(clerumErrorHandler)
    return { app, getResource, appendManyInTransaction }
  }

  function postTelemetry(app: express.Express, hostLookupReference: Record<string, unknown>) {
    return request(app)
      .post('/internal/tracing/infrastructure-telemetry-events')
      .set('Authorization', `Bearer ${signInternalControl('hcc')}`)
      .send({
        events: [
          {
            telemetryType: 'health_transition',
            sourceEventId: `health-${JSON.stringify(hostLookupReference).length}`,
            occurredAt: '2026-07-10T09:59:59.000Z',
            hostLookupReference,
          },
        ],
      })
  }

  type RejectingService = { submit: () => Promise<never> }
  function rejectingApp(router: (service: RejectingService) => express.Router, err: unknown) {
    const service = { submit: vi.fn<() => Promise<never>>(async () => Promise.reject(err)) }
    const app = express()
    app.use(router(service))
    app.use(clerumErrorHandler)
    return { app, service }
  }

  it.each([
    [
      '/internal/tracing/administrative-events',
      createInternalAdministrativeEventsRouter,
      { kind: 'linked_outcome', operationId: 'operation-1' },
      new TracingIdempotencyConflictError('administrative', 'hcc_internal_control', 'e-1'),
      409,
      'tracing_idempotency_conflict',
    ],
    [
      '/internal/tracing/infrastructure-telemetry-events',
      createInternalInfrastructureTelemetryEventsRouter,
      { telemetryType: 'reconcile_outcome', sourceEventId: 'reconcile-1' },
      new UnsafeTracingInputError('input.payload.gfs_subject', 'not_permitted'),
      400,
      'unsafe_tracing_input',
    ],
    [
      '/internal/tracing/infrastructure-telemetry-events',
      createInternalInfrastructureTelemetryEventsRouter,
      { telemetryType: 'reconcile_outcome', sourceEventId: 'reconcile-1' },
      new InvalidTracingInputError('events[0].hostLookupReference.uid must be a string'),
      400,
      'invalid_tracing_input',
    ],
  ] as const)('%s answers %#: status and code', async (path, router, event, err, status, code) => {
    const { app, service } = rejectingApp(router, err)

    const response = await request(app)
      .post(path)
      .set('Authorization', `Bearer ${signInternalControl('hcc')}`)
      .send({ events: [event] })

    expect(service.submit).toHaveBeenCalledOnce()
    expect(response.status).toBe(status)
    expect(response.body).toMatchObject({ code, correlationId: expect.any(String) })
  })

  // The rows above stub the service, so they only prove the handler forwards a
  // code it is handed. These two rejections have to be reached through the real
  // normalizer and the real resolver, or the validation could be absent from
  // the wired route while every unit test stayed green (#693).
  it.each([
    ['without a uid', { name: 'chatllm', namespace: 'mcp-host', generation: 7 }],
    [
      'with an unknown key',
      {
        name: 'chatllm',
        namespace: 'mcp-host',
        generation: 7,
        uid: HOST_UID,
        resourceVersion: '1',
      },
    ],
    // A uid that is present but cannot name an object. Each of these would
    // otherwise reach the resolver and be compared against a real Host.
    ['with an empty uid', { name: 'chatllm', namespace: 'mcp-host', generation: 7, uid: '' }],
    ['with a non-string uid', { name: 'chatllm', namespace: 'mcp-host', generation: 7, uid: 42 }],
    ['with a null uid', { name: 'chatllm', namespace: 'mcp-host', generation: 7, uid: null }],
  ] as const)(
    'refuses a Host reference %s as 400 invalid_tracing_input through the real route',
    async (_label, hostLookupReference) => {
      const { app, getResource, appendManyInTransaction } = realInfrastructureApp()

      // Liveness: the same app, principal and route accept the uid-bearing
      // reference, so a 400 below is this reference being refused, not the
      // wiring refusing everything.
      const accepted = await postTelemetry(app, {
        name: 'chatllm',
        namespace: 'mcp-host',
        generation: 7,
        uid: HOST_UID,
      })
      expect(accepted.status).toBe(200)
      expect(accepted.body).toMatchObject({ accepted: 1, replayed: 0 })

      const response = await postTelemetry(app, hostLookupReference)

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({
        code: 'invalid_tracing_input',
        correlationId: expect.any(String),
      })
      // Neither rejection consults the API server or opens a transaction.
      expect(getResource).toHaveBeenCalledOnce()
      expect(appendManyInTransaction).toHaveBeenCalledOnce()
    }
  )

  /**
   * The rollout order depends on this exact answer: HCC treats a 403 as
   * retryable and a 400 as terminal, so a pre-#694 sourceStatusRef reaching a
   * control-api that already requires the uid has to come back 403 or the
   * outcome is dropped for good. The row above stubs the service and only
   * proves the handler forwards the error it is handed; this one has to reach
   * the real resolver through the real route.
   */
  it('answers an administrative outcome with a pre-uid sourceStatusRef 403 through the real route', async () => {
    const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
    const listResource = vi.fn().mockResolvedValue([
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'Host',
        metadata: {
          name: 'chatllm',
          namespace: 'mcp-host',
          generation: 7,
          uid: HOST_UID,
          annotations: {
            'clerum.io/administrative-intent-id': OPERATION_ID,
            'clerum.io/administrative-intent-generation': '7',
          },
        },
      },
    ])
    const findHostIntents = vi.fn().mockResolvedValue(
      new Map([
        [
          administrativeIntentLookupKey({
            operationId: OPERATION_ID,
            targetRef: 'mcp-host/chatllm',
            namespace: 'mcp-host',
          }),
          {
            operatorSub: 'admin-1',
            requestId: 'request-1',
            environment: 'test',
            tenantId: null,
            teamId: null,
            identityIssuer: 'control-api',
            operatorUserId: '22222222-2222-4222-8222-222222222222',
            resourceAud: 'control-ui',
            effectiveScopes: [],
            tokenExchangeId: null,
            authorizationDecision: 'allow' as const,
            decisionActorSub: 'control-api',
          },
        ],
      ])
    )
    const appendManyInTransaction = vi.fn().mockResolvedValue([
      {
        kind: 'accepted' as const,
        accepted: 1,
        replayed: 0,
        family: 'administrative' as const,
        eventId: '33333333-3333-4333-8333-333333333333',
        streamSequence: '7',
        payloadSha256: 'b'.repeat(64),
        ingestedAt: '2026-07-10T10:00:00.000Z',
      },
    ])
    const db = { query: vi.fn() } as unknown as DbClient
    const app = express()
    app.use(
      createInternalAdministrativeEventsRouter(
        new RouteTracingSubmissionService({
          transaction: (async (work: (client: DbClient) => Promise<unknown>) =>
            work(db)) as unknown as TracingTransactionRunner,
          administrativeOperationBindingResolver: new HccAdministrativeOutcomeBindingResolver(
            { getResource: vi.fn(), listResource },
            { findHostIntent: vi.fn(), findHostIntents }
          ),
          administrativeEventAppender: { appendManyInTransaction },
        })
      )
    )
    app.use(clerumErrorHandler)

    const post = (sourceStatusRef: string) =>
      request(app)
        .post('/internal/tracing/administrative-events')
        .set('Authorization', `Bearer ${signInternalControl('hcc')}`)
        .send({
          events: [
            {
              kind: 'linked_outcome',
              sourceEventId: `outcome-${sourceStatusRef.length}`,
              occurredAt: '2026-07-10T09:59:59.000Z',
              reasonCode: 'boundary_test',
              sourceStatusRef,
              payload: { resource_class: 'Host', status: 'succeeded' },
            },
          ],
        })

    // Liveness: the current format binds and stores through this same app, so
    // the refusal below is the legacy format and not a route that refuses all.
    const accepted = await post(`host:mcp-host/chatllm:generation=7:uid=${HOST_UID}`)
    expect(accepted.status).toBe(200)
    expect(appendManyInTransaction).toHaveBeenCalledOnce()

    const legacy = await post('host:mcp-host/chatllm:generation=7')

    expect(legacy.status).toBe(403)
    expect(legacy.body.correlationId).toEqual(expect.any(String))
    // No machine-readable code: that is what keeps HCC retrying instead of
    // classifying the failure as terminal and dropping the outcome.
    expect(legacy.body).not.toHaveProperty('code')
    expect(appendManyInTransaction).toHaveBeenCalledOnce()
  })

  it('keeps a binding 403 without a code, so HCC keeps retrying it', async () => {
    const { app, service } = rejectingApp(
      createInternalAdministrativeEventsRouter,
      new TracingBindingUnavailableError('operation', 0)
    )

    const response = await request(app)
      .post('/internal/tracing/administrative-events')
      .set('Authorization', `Bearer ${signInternalControl('hcc')}`)
      .send({ events: [{ kind: 'linked_outcome', operationId: 'operation-1' }] })

    // Liveness: the service rejected and the handler's 4xx branch answered.
    expect(service.submit).toHaveBeenCalledOnce()
    expect(response.status).toBe(403)
    expect(response.body.correlationId).toEqual(expect.any(String))
    expect(response.body).not.toHaveProperty('code')
  })
})
