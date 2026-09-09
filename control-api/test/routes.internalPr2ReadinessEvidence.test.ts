import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const readiness = vi.hoisted(() => ({
  parsePr2ReadinessEvidence: vi.fn(),
  writePr2ReadinessEvidence: vi.fn(),
}))

vi.mock('../src/middleware/pr2ReadinessWriterAuth.js', () => ({
  requirePr2RuntimeReadinessWriter: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    req.pr2RuntimeReadinessWriter = 'rpc-proxy'
    next()
  },
}))
vi.mock('../src/services/access/pr2ReadinessEvidence.js', () => readiness)

const { createInternalPr2ReadinessEvidenceRouter } =
  await import('../src/routes/internal/pr2ReadinessEvidence.js')

function app() {
  const value = express()
  value.use(express.json())
  value.use('/api/v1', createInternalPr2ReadinessEvidenceRouter())
  value.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      res.status(500).json({ error: 'Internal Server Error' })
    }
  )
  return value
}

describe('PR2 runtime readiness evidence route', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns one bounded invalid-input error without reflecting parser details', async () => {
    readiness.parsePr2ReadinessEvidence.mockImplementation(() => {
      throw new Error('sensitive fixture value')
    })

    const response = await request(app())
      .post('/api/v1/internal/pr2-readiness/runtime-evidence')
      .send({ invalid: true })
      .expect(400)

    expect(response.body).toEqual({
      version: 1,
      status: 'rejected',
      code: 'pr2_readiness_evidence_invalid',
    })
    expect(JSON.stringify(response.body)).not.toContain('sensitive')
  })

  it('reports inactive source conflicts without exposing database failures', async () => {
    readiness.parsePr2ReadinessEvidence.mockReturnValue({ hop: 'rpc_proxy_trusted_edge' })
    readiness.writePr2ReadinessEvidence.mockRejectedValueOnce(
      new Error('pr2_readiness_source_inactive')
    )
    await request(app())
      .post('/api/v1/internal/pr2-readiness/runtime-evidence')
      .send({})
      .expect(409, {
        version: 1,
        status: 'rejected',
        code: 'pr2_readiness_source_inactive',
      })

    readiness.writePr2ReadinessEvidence.mockRejectedValueOnce(
      new Error('database failure with private detail')
    )
    const failure = await request(app())
      .post('/api/v1/internal/pr2-readiness/runtime-evidence')
      .send({})
      .expect(500)
    expect(failure.body).toEqual({ error: 'Internal Server Error' })
    expect(JSON.stringify(failure.body)).not.toContain('private detail')
  })
})
