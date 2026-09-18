import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import {
  GrokProviderAttemptFinalizeError,
  type GrokProviderAttemptFinalizeErrorCode,
} from '../src/services/grokProviderAttemptFinalization.js'
import {
  GrokProviderAttemptRedeemError,
  type GrokProviderAttemptRedeemErrorCode,
} from '../src/services/grokProviderAttemptRedemption.js'
import { LlmProviderAttemptRedeemError } from '../src/services/llmProviderAttemptRedemption.js'

const services = vi.hoisted(() => ({
  redeemGrok: vi.fn(),
  finalizeGrok: vi.fn(),
  redeemCodex: vi.fn(),
  finalizeCodex: vi.fn(),
}))

vi.mock('../src/services/grokProviderAttemptRedemption.js', async () => ({
  ...(await vi.importActual('../src/services/grokProviderAttemptRedemption.js')),
  redeemGrokProviderAttempt: services.redeemGrok,
}))
vi.mock('../src/services/grokProviderAttemptFinalization.js', async () => ({
  ...(await vi.importActual('../src/services/grokProviderAttemptFinalization.js')),
  finalizeGrokProviderAttempt: services.finalizeGrok,
}))
vi.mock('../src/services/llmProviderAttemptRedemption.js', async () => ({
  ...(await vi.importActual('../src/services/llmProviderAttemptRedemption.js')),
  redeemLlmProviderAttempt: services.redeemCodex,
}))
vi.mock('../src/services/llmProviderAttemptFinalization.js', async () => ({
  ...(await vi.importActual('../src/services/llmProviderAttemptFinalization.js')),
  finalizeLlmProviderAttempt: services.finalizeCodex,
}))
vi.mock('../src/db.js', () => ({ pool: { query: vi.fn() }, withTransaction: vi.fn() }))

const { createInternalLlmProviderAttemptRoutes } =
  await import('../src/routes/internal/llmProviderAttempts.js')

const REDEEM = '/internal/llm/grok/provider-attempts/redeem'
const FINALIZE = '/internal/llm/grok/provider-attempts/finalize'

/** Stand-in for internalServiceAuth: the header names the authenticated caller. */
function makeApp() {
  const app = express()
  app.use(express.json())
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const service = req.header('x-test-service')
    if (service) {
      ;(req as Request & { internalService?: { name: string } }).internalService = {
        name: service,
      }
    }
    next()
  })
  app.use(createInternalLlmProviderAttemptRoutes())
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'internal', name: (err as Error)?.name })
  })
  return app
}

describe('internal Grok provider-attempt routes', () => {
  beforeEach(() => {
    for (const fn of Object.values(services)) fn.mockReset()
  })

  describe('service identity', () => {
    it.each([
      [REDEEM, undefined],
      [REDEEM, 'codex-llm-proxy'],
      [FINALIZE, undefined],
      [FINALIZE, 'codex-llm-proxy'],
    ])('rejects %s for caller %s', async (path, service) => {
      const req = request(makeApp()).post(path).send({})
      const res = await (service ? req.set('x-test-service', service) : req)
      expect(res.status).toBe(401)
      expect(services.redeemGrok).not.toHaveBeenCalled()
      expect(services.finalizeGrok).not.toHaveBeenCalled()
    })

    it('does not let the Grok proxy reach the Codex redeem route', async () => {
      const res = await request(makeApp())
        .post('/internal/llm/provider-attempts/redeem')
        .set('x-test-service', 'grok-llm-proxy')
        .send({ executionTicket: 't', requestHash: 'h' })
      expect(res.status).toBe(401)
      expect(services.redeemCodex).not.toHaveBeenCalled()
    })
  })

  describe('redeem', () => {
    it('passes only typed fields and defaults the operation', async () => {
      services.redeemGrok.mockResolvedValue({ accessToken: 'access', attemptReceipt: 'r' })
      const res = await request(makeApp())
        .post(REDEEM)
        .set('x-test-service', 'grok-llm-proxy')
        .send({
          executionTicket: 'ticket',
          requestHash: 'a'.repeat(64),
          model: 'grok-4.6',
          hostRef: 7,
          operation: 'drop_tables',
        })
      expect(res.status).toBe(200)
      expect(services.redeemGrok).toHaveBeenCalledWith({
        executionTicket: 'ticket',
        requestHash: 'a'.repeat(64),
        model: 'grok-4.6',
        hostRef: undefined,
        operation: 'completion_stream',
      })
      expect(services.redeemCodex).not.toHaveBeenCalled()
    })

    const redeemStatus: Array<[GrokProviderAttemptRedeemErrorCode, number]> = [
      ['disabled', 404],
      ['ticket_invalid', 403],
      ['ticket_replayed', 409],
      ['ticket_expired', 403],
      ['request_hash_mismatch', 403],
      ['connection_unavailable', 503],
      ['no_grant', 403],
      ['provider_unavailable', 503],
    ]

    it.each(redeemStatus)('maps redeem error %s to %i', async (code, status) => {
      services.redeemGrok.mockRejectedValue(
        new GrokProviderAttemptRedeemError(code, 'detail with access-secret')
      )
      const res = await request(makeApp())
        .post(REDEEM)
        .set('x-test-service', 'grok-llm-proxy')
        .send({ executionTicket: 'ticket', requestHash: 'h' })
      expect(res.status).toBe(status)
      expect(res.body).toEqual({ error: code })
    })

    it('does not translate a Codex redeem error thrown on the Grok route', async () => {
      services.redeemGrok.mockRejectedValue(new LlmProviderAttemptRedeemError('no_grant', 'codex'))
      const res = await request(makeApp())
        .post(REDEEM)
        .set('x-test-service', 'grok-llm-proxy')
        .send({ executionTicket: 'ticket', requestHash: 'h' })
      expect(res.status).toBe(500)
    })
  })

  describe('finalize', () => {
    const finalizeStatus: Array<[GrokProviderAttemptFinalizeErrorCode, number]> = [
      ['disabled', 404],
      ['ticket_invalid', 403],
      ['request_hash_mismatch', 403],
      ['invalid_receipt', 400],
      ['conflict', 409],
    ]

    it.each(finalizeStatus)('maps finalize error %s to %i', async (code, status) => {
      services.finalizeGrok.mockRejectedValue(new GrokProviderAttemptFinalizeError(code, 'detail'))
      const res = await request(makeApp())
        .post(FINALIZE)
        .set('x-test-service', 'grok-llm-proxy')
        .send({ attemptReceipt: 'a'.repeat(64), receipt: {} })
      expect(res.status).toBe(status)
      expect(res.body).toEqual({ error: code })
      expect(services.finalizeCodex).not.toHaveBeenCalled()
    })

    it('forwards a non-string attemptReceipt as empty and returns the result', async () => {
      services.finalizeGrok.mockResolvedValue({
        providerAttemptId: 'attempt-1',
        outcome: 'success',
        duplicate: false,
      })
      const receipt = { schemaVersion: 'grok-attempt-receipt.v1' }
      const res = await request(makeApp())
        .post(FINALIZE)
        .set('x-test-service', 'grok-llm-proxy')
        .send({ attemptReceipt: 42, receipt })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        providerAttemptId: 'attempt-1',
        outcome: 'success',
        duplicate: false,
      })
      expect(services.finalizeGrok).toHaveBeenCalledWith({ attemptReceipt: '', receipt })
    })
  })
})
