import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { EventEmitter } from 'node:events'
import request from 'supertest'
import { config } from '../src/config.js'
import { createTracingInFlightLimiter } from '../src/middleware/tracingSubmitterAuth.js'
import {
  governedTraceAdmissionRequestsTotal,
  governedTraceInFlightRequests,
  governedTraceLastErrorTimestampSeconds,
  governedTraceOperationalErrorsTotal,
  governedTraceRequestBodyBytes,
} from '../src/observability/metrics.js'
import { createInternalAgentRunEventsRouter } from '../src/routes/internal/agentRunEvents.js'

function wrcToken(): string {
  return jwt.sign(
    { iss: 'wrc', aud: 'control-api', sub: 'wrc-provisioner' },
    config.internalControlJwtWrcHmacSecret,
    { algorithm: 'HS256', expiresIn: 60, jwtid: 'tracing-operational-metrics-test' }
  )
}

function tracingApp() {
  const service = {
    submit: vi.fn(async ({ events }: { events: readonly object[] }) => ({
      accepted: events.length,
      replayed: 0,
    })),
  }
  const app = express()
  app.use(createInternalAgentRunEventsRouter(service))
  return { app, service }
}

async function metricValues(metric: { get(): Promise<{ values: unknown[] }> }) {
  return (await metric.get()).values as Array<{
    value: number
    labels: Record<string, string>
    metricName?: string
  }>
}

beforeEach(() => {
  governedTraceAdmissionRequestsTotal.reset()
  governedTraceInFlightRequests.reset()
  governedTraceLastErrorTimestampSeconds.reset()
  governedTraceOperationalErrorsTotal.reset()
  governedTraceRequestBodyBytes.reset()
})

describe('tracing operational admission metrics', () => {
  it('records accepted request count and actual parsed body bytes without retaining the body', async () => {
    const { app, service } = tracingApp()
    const body = { events: [{ eventType: 'run_start' }] }
    await request(app)
      .post('/internal/tracing/agent-run-events')
      .auth(wrcToken(), { type: 'bearer' })
      .send(body)
      .expect(200)

    expect(service.submit).toHaveBeenCalledOnce()
    expect(await metricValues(governedTraceAdmissionRequestsTotal)).toEqual([
      expect.objectContaining({
        labels: { family: 'agent_run', result: 'accepted', reason: 'none' },
        value: 1,
      }),
    ])
    const bodyMetric = await metricValues(governedTraceRequestBodyBytes)
    expect(
      bodyMetric.find(sample => sample.metricName === 'governed_trace_request_body_bytes_count')
    ).toMatchObject({ labels: { family: 'agent_run' }, value: 1 })
    expect(
      bodyMetric.find(sample => sample.metricName === 'governed_trace_request_body_bytes_sum')
    ).toMatchObject({
      labels: { family: 'agent_run' },
      value: Buffer.byteLength(JSON.stringify(body)),
    })
  })

  it.each([
    [
      'unsupported_content_type',
      415,
      (app: express.Express) =>
        request(app)
          .post('/internal/tracing/agent-run-events')
          .auth(wrcToken(), { type: 'bearer' })
          .set('Content-Type', 'text/plain')
          .send('not-json'),
    ],
    [
      'invalid_json',
      400,
      (app: express.Express) =>
        request(app)
          .post('/internal/tracing/agent-run-events')
          .auth(wrcToken(), { type: 'bearer' })
          .set('Content-Type', 'application/json')
          .send('{"events":'),
    ],
    [
      'body_too_large',
      413,
      (app: express.Express) =>
        request(app)
          .post('/internal/tracing/agent-run-events')
          .auth(wrcToken(), { type: 'bearer' })
          .send({ events: [{ payload: 'x'.repeat(512 * 1024) }] }),
    ],
    [
      'batch_too_large',
      413,
      (app: express.Express) =>
        request(app)
          .post('/internal/tracing/agent-run-events')
          .auth(wrcToken(), { type: 'bearer' })
          .send({ events: Array.from({ length: 101 }, () => ({ eventType: 'run_start' })) }),
    ],
  ] as const)(
    'records %s as a bounded rejection with a last occurrence',
    async (reason, status, send) => {
      const { app, service } = tracingApp()
      await send(app).expect(status)

      expect(service.submit).not.toHaveBeenCalled()
      expect(await metricValues(governedTraceAdmissionRequestsTotal)).toEqual([
        expect.objectContaining({
          labels: { family: 'agent_run', result: 'rejected', reason },
          value: 1,
        }),
      ])
      expect(await metricValues(governedTraceLastErrorTimestampSeconds)).toEqual([
        expect.objectContaining({ labels: { scope: 'agent_run', reason } }),
      ])
      expect(await metricValues(governedTraceOperationalErrorsTotal)).toEqual([
        expect.objectContaining({ labels: { scope: 'agent_run', reason }, value: 1 }),
      ])
    }
  )

  it.each(['/internal/tracing/agent-run-events', '/internal/tracing/approval-prompt-history'])(
    'records agent-run capacity exhaustion for %s and releases the gauge',
    async path => {
      const app = express()
      let release!: () => void
      const blocked = new Promise<void>(resolve => {
        release = resolve
      })
      const handler = vi.fn(async (_req, res) => {
        await blocked
        res.status(204).end()
      })
      app.post(path, createTracingInFlightLimiter(1), handler)

      const first = request(app)
        .post(path)
        .then(response => response)
      while (!handler.mock.calls.length) await new Promise(resolve => setTimeout(resolve, 0))
      await request(app).post(path).expect(503)
      expect(await metricValues(governedTraceInFlightRequests)).toEqual([
        expect.objectContaining({ value: 1 }),
      ])

      release()
      expect((await first).status).toBe(204)
      expect(await metricValues(governedTraceInFlightRequests)).toEqual([
        expect.objectContaining({ value: 0 }),
      ])
      expect(await metricValues(governedTraceAdmissionRequestsTotal)).toEqual([
        expect.objectContaining({
          labels: { family: 'agent_run', result: 'rejected', reason: 'capacity_exhausted' },
          value: 1,
        }),
      ])
    }
  )

  it('releases the current in-flight gauge when the response closes early', async () => {
    const limiter = createTracingInFlightLimiter(1)
    const response = new EventEmitter() as EventEmitter & Response
    const next = vi.fn()

    limiter({ path: '/internal/tracing/agent-run-events' } as Request, response, next)

    expect(next).toHaveBeenCalledOnce()
    expect(await metricValues(governedTraceInFlightRequests)).toEqual([
      expect.objectContaining({ value: 1 }),
    ])
    response.emit('close')
    expect(await metricValues(governedTraceInFlightRequests)).toEqual([
      expect.objectContaining({ value: 0 }),
    ])
  })

  it('releases the current in-flight gauge after downstream error handling finishes', async () => {
    const app = express()
    app.post(
      '/internal/tracing/agent-run-events',
      createTracingInFlightLimiter(1),
      (_req, _res, next) => next(new Error('downstream failure'))
    )
    app.use(
      (
        _error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction
      ) => res.status(500).end()
    )

    await request(app).post('/internal/tracing/agent-run-events').expect(500)

    expect(await metricValues(governedTraceInFlightRequests)).toEqual([
      expect.objectContaining({ value: 0 }),
    ])
  })
})
