import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { config } from '../../config'
import { getRuntimeCallerContext, runtimeEdgeGuard } from '../edgeRuntimeAuth'

const USER_ID = 'user-1'
const TEAM_ID = 'team-1'

function edgeRequest(context?: Record<string, unknown>): Request {
  const headers: Record<string, string> = {
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': config.hostName,
    'x-clerum-edge-user-id': USER_ID,
    'x-clerum-edge-team-id': TEAM_ID,
  }
  if (context) {
    headers['x-clerum-edge-profile-link-context'] = Buffer.from(JSON.stringify(context)).toString(
      'base64url'
    )
  }
  return { headers } as unknown as Request
}

function validContext() {
  return {
    version: 1,
    userId: USER_ID,
    teamId: TEAM_ID,
    hostRef: config.hostName,
    profileUiBaseUrl: 'https://profile.tenant.example',
  }
}

function run(request: Request) {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response
  const next = vi.fn()
  runtimeEdgeGuard(['rpc-proxy'])(request, res, next)
  return { caller: getRuntimeCallerContext(request), next, res }
}

describe('rpc edge Profile-link context', () => {
  it('accepts a canonical context bound to the current user, team, and Host', () => {
    const { caller, next } = run(edgeRequest(validContext()))

    expect(next).toHaveBeenCalledOnce()
    expect(caller?.profileLinkContext).toEqual(validContext())
  })

  it.each([
    ['unknown version', { ...validContext(), version: 2 }],
    ['different user', { ...validContext(), userId: 'other-user' }],
    ['different team', { ...validContext(), teamId: 'other-team' }],
    ['different Host', { ...validContext(), hostRef: 'other-host' }],
    [
      'non-origin Profile URL',
      { ...validContext(), profileUiBaseUrl: 'https://profile.example/path' },
    ],
    ['unsafe scheme', { ...validContext(), profileUiBaseUrl: 'javascript:alert(1)' }],
  ])('drops %s while allowing the authenticated message path', (_label, context) => {
    const { caller, next } = run(edgeRequest(context))

    expect(next).toHaveBeenCalledOnce()
    expect(caller?.profileLinkContext).toBeUndefined()
  })

  it('drops malformed and oversized context headers', () => {
    const malformed = edgeRequest()
    malformed.headers['x-clerum-edge-profile-link-context'] = 'not-base64!'
    const tooLong = edgeRequest()
    tooLong.headers['x-clerum-edge-profile-link-context'] = 'a'.repeat(8193)

    for (const request of [malformed, tooLong]) {
      const { caller, next } = run(request)
      expect(next).toHaveBeenCalledOnce()
      expect(caller?.profileLinkContext).toBeUndefined()
    }
  })

  it('allows older rpc-proxy requests that omit Profile-link context', () => {
    const { caller, next } = run(edgeRequest())

    expect(next).toHaveBeenCalledOnce()
    expect(caller?.profileLinkContext).toBeUndefined()
  })

  it('does not materialize a context without the current caller identity', () => {
    const request = edgeRequest(validContext())
    delete request.headers['x-clerum-edge-user-id']

    const { caller, next, res } = run(request)

    expect(next).not.toHaveBeenCalled()
    expect(caller?.profileLinkContext).toBeUndefined()
    expect(res.status).toHaveBeenCalledWith(401)
  })
})
