import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Response as ExpressResponse } from 'express'
import express from 'express'
import request from 'supertest'
import {
  type HostDenialAnswer,
  type HostResolveRefusal,
  respondHostResolveRefusal,
} from '../services/hostAccessDenial.js'

// The one writer of a V1 Host resolve refusal, on a real Express response.
// Every member of the refusal union, with both denial answers.

type Row = {
  member: 'denied' | 'rejected' | 'unavailable'
  refusal: HostResolveRefusal
  denialAnswer: HostDenialAnswer
  status: number
  body: Record<string, unknown>
}

const FORBIDDEN_BODY = 'Forbidden: user cannot access this host'
const NOT_FOUND_BODY = { error: 'Host not found or not accessible' }
const UNAVAILABLE_BODY = { error: 'authority_unavailable' }

const UNAVAILABLE_REFUSALS: HostResolveRefusal[] = [
  { unavailable: true, cause: 'request_failed' },
  { unavailable: true, cause: 'invalid_binding_status' },
  { unavailable: true, cause: 'edge_assertion_missing' },
  { unavailable: true, cause: 'http_status', status: 404 },
  { unavailable: true, cause: 'http_status', status: 500 },
  { unavailable: true, cause: 'http_status', status: 503 },
]

const ROWS: Row[] = (['forbidden', 'not_found'] as const).flatMap(denialAnswer => [
  ...(['host_access_revoked', 'host_access_denied'] as const).map(
    (code): Row => ({
      member: 'denied',
      refusal: { denied: true, code },
      denialAnswer,
      ...(denialAnswer === 'forbidden'
        ? { status: 403, body: { error: FORBIDDEN_BODY, code } }
        : { status: 404, body: NOT_FOUND_BODY }),
    })
  ),
  {
    member: 'rejected',
    refusal: { rejected: true, status: 401 },
    denialAnswer,
    status: 401,
    body: { error: 'Unauthorized' },
  },
  {
    member: 'rejected',
    refusal: { rejected: true, status: 409 },
    denialAnswer,
    status: 409,
    body: { error: 'Direct run attribution conflict' },
  },
  {
    member: 'unavailable',
    refusal: { unavailable: true, cause: 'timeout' },
    denialAnswer,
    status: 504,
    body: { error: 'Gateway Timeout' },
  },
  ...UNAVAILABLE_REFUSALS.map(
    (refusal): Row => ({
      member: 'unavailable',
      refusal,
      denialAnswer,
      status: 503,
      body: UNAVAILABLE_BODY,
    })
  ),
])

function appAnswering(refusal: HostResolveRefusal, denialAnswer: HostDenialAnswer) {
  const app = express()
  app.get('/refused', (_req, res) => respondHostResolveRefusal(res, refusal, denialAnswer))
  return app
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('respondHostResolveRefusal', () => {
  it('has rows for every refusal member and both denial answers', () => {
    for (const member of ['denied', 'rejected', 'unavailable'] as const) {
      for (const denialAnswer of ['forbidden', 'not_found'] as const) {
        expect(
          ROWS.filter(row => row.member === member && row.denialAnswer === denialAnswer).length
        ).toBeGreaterThan(0)
      }
    }
  })

  it.each(ROWS)(
    '$member $refusal with denialAnswer $denialAnswer answers $status',
    async ({ refusal, denialAnswer, status, body }) => {
      const res = await request(appAnswering(refusal, denialAnswer)).get('/refused')

      expect(res.status).toBe(status)
      // Exactly this body: no control-api message, cause or status is echoed.
      expect(res.body).toEqual(body)
    }
  )

  it('writes nothing on a committed response', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const res = {
      headersSent: true,
      status: vi.fn(),
      json: vi.fn(),
    }

    respondHostResolveRefusal(
      res as unknown as ExpressResponse,
      { unavailable: true, cause: 'timeout' },
      'forbidden'
    )

    // Witness: the guard ran and logged the suppression once.
    expect(warn.mock.calls).toEqual([
      ['[RPC_PROXY] suppressing duplicate terminal response (host-resolve-refusal)'],
    ])
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })
})
