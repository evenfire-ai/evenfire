import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { correlationIdMiddleware } from '../src/middleware/correlationId.js'
import {
  handleExternalSessionBackendFailure,
  markAuthorityUnavailable,
} from '../src/middleware/externalSessionAuth.js'
import { type Logger, rootLogger } from '../src/observability/logger.js'
import { ExternalSessionBackendUnavailableError } from '../src/services/auth/sessionDatabaseFailure.js'

const CORRELATION_ID = '11111111-1111-4111-8111-111111111111'

describe('external outage logs', () => {
  const childWarn = vi.fn()
  const rootWarn = vi.spyOn(rootLogger, 'warn').mockImplementation(() => undefined)
  const child = vi.spyOn(rootLogger, 'child')

  beforeEach(() => {
    childWarn.mockReset()
    rootWarn.mockClear()
    child.mockReset()
    child.mockReturnValue({ warn: childWarn } as unknown as Logger)
  })

  afterEach(() => {
    expect(child).toHaveBeenCalledWith({ correlationId: CORRELATION_ID })
    expect(childWarn).toHaveBeenCalledTimes(1)
    expect(rootWarn).not.toHaveBeenCalled()
  })

  it('logs markAuthorityUnavailable through the correlated request logger', async () => {
    const app = express()
    app.use(correlationIdMiddleware)
    app.get('/probe', (req, res) => {
      markAuthorityUnavailable(req, res, new Error('outage'), 'probe_event')
      res.status(503).json({ error: 'authority_unavailable' })
    })

    const res = await request(app).get('/probe').set('x-correlation-id', CORRELATION_ID)

    expect(res.status).toBe(503)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(childWarn.mock.calls[0]?.[0]).toMatchObject({ event: 'probe_event' })
  })

  it('logs handleExternalSessionBackendFailure through the correlated request logger', async () => {
    const app = express()
    app.use(correlationIdMiddleware)
    app.get('/probe', (req, res, next) => {
      handleExternalSessionBackendFailure(
        new ExternalSessionBackendUnavailableError(new Error('outage')),
        req,
        res,
        next
      )
    })

    const res = await request(app).get('/probe').set('x-correlation-id', CORRELATION_ID)

    expect(res.status).toBe(503)
    expect(res.body.error).toBe('session_backend_unavailable')
    expect(childWarn.mock.calls[0]?.[0]).toMatchObject({
      event: 'external_session_backend_unavailable',
    })
  })
})
