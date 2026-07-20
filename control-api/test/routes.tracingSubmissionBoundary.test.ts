import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { config } from '../src/config.js'
import { createInternalAdministrativeEventsRouter } from '../src/routes/internal/administrativeEvents.js'
import { createInternalAgentRunEventsRouter } from '../src/routes/internal/agentRunEvents.js'
import { createInternalInfrastructureTelemetryEventsRouter } from '../src/routes/internal/infrastructureTelemetryEvents.js'
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
