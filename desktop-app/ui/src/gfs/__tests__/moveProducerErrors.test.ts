import { describe, expect, it, vi } from 'vitest'
import { GFS_MOVE_MAX_NETWORK_ATTEMPTS } from '@clerum/gfs-interaction-policy'
import {
  isGfsSessionAuthorityFailure,
  parseHttpStatus,
  parseRetryAfterSeconds,
} from '@lib/gfsGrantErrors'
import { GfsUriError } from '../../../../src/gfs/uriHandler'
import { ApiError } from '../../../../src/httpClient'
import {
  gfsRouteFailureMessage,
  resolveDeniedMessage,
  resolveResource,
  resolvedFile,
} from '../__fixtures__/gfsProducerFixtures'
import { commitGfsMove, toastMoveOutcome } from '../moveCommit'
import type { MoveCommitPlan } from '../moveCommit'

const sourceId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const destinationId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const oldParentId = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const plan: MoveCommitPlan = {
  source: {
    resourceId: sourceId,
    gfsUri: `gfs://main/${sourceId}`,
    kind: 'file',
    name: 'report.md',
  },
  destination: { resourceId: destinationId, name: 'Dest' },
  allowNumberedRename: false,
}

async function wireFailure(
  status: number,
  message = 'move rejected',
  headers: Record<string, string> = {}
) {
  let captured: unknown
  const text = await gfsRouteFailureMessage(
    async client => {
      try {
        return await client.moveResource(
          { resourceId: sourceId, destinationId, ifMatch: 7 },
          'fixture-session-token'
        )
      } catch (error) {
        captured = error
        throw error
      }
    },
    status,
    { code: 'move_rejected', message },
    headers
  )
  return { text, error: captured }
}
async function run(text: string, approveRename = false, landed = false, isCurrent?: () => boolean) {
  const snapshot = await resolveResource(
    resolvedFile(sourceId, 'report.md', { parentResourceId: oldParentId, version: 7 })
  )
  const confirmed = await resolveResource(
    resolvedFile(sourceId, 'report.md', { parentResourceId: destinationId, version: 8 })
  )
  const resolveSource = vi
    .fn()
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValue(landed ? confirmed : snapshot)
  const moveResource = vi.fn(
    async (_id: string, _destination: string, _version: number, _name?: string) => {
      throw new Error(text)
    }
  )
  const outcome = await commitGfsMove(
    {
      resolveSource,
      moveResource,
      isSessionAuthorityFailure: error => isGfsSessionAuthorityFailure(String(error), 'operation'),
      ...(isCurrent ? { isCurrent } : {}),
    },
    { ...plan, allowNumberedRename: approveRename }
  )
  return { outcome, resolveSource, moveResource }
}

describe('real move producer verdicts (R1-M3)', () => {
  it('marks only a dispatched PATCH 403 for permission-only retry', async () => {
    const patchFailure = await wireFailure(403)
    const patchResult = await run(patchFailure.text)
    expect(patchResult.outcome.status).toBe('unconfirmed')
    expect('retryPermissionCheck' in patchResult.outcome).toBe(true)
    if ('retryPermissionCheck' in patchResult.outcome) {
      expect(patchResult.outcome.retryPermissionCheck).toBe(true)
    }

    const sourceResolveFailure = await resolveDeniedMessage(plan.source.gfsUri)
    const moveResource = vi.fn(async () => ({ resourceId: sourceId, version: 8 }))
    const preDispatchResult = await commitGfsMove(
      {
        resolveSource: vi.fn(async () => {
          throw new Error(sourceResolveFailure)
        }),
        moveResource,
        isSessionAuthorityFailure: error =>
          isGfsSessionAuthorityFailure(String(error), 'operation'),
      },
      plan
    )
    expect(preDispatchResult.status).toBe('unconfirmed')
    expect('retryPermissionCheck' in preDispatchResult).toBe(false)
    expect(moveResource).not.toHaveBeenCalled()
  })

  it.each([
    [400, 'destination-rejected'],
    [401, 'session-lost'],
    [403, 'unconfirmed'],
    [404, 'target-unavailable'],
    [409, 'conflict-stopped'],
    [412, 'changed'],
    [429, 'rate-limited'],
  ] as const)(
    'preserves trusted %i metadata and emits %s without an automatic retry',
    async (status, expected) => {
      const wire = await wireFailure(
        status,
        'move rejected',
        status === 429 ? { 'retry-after': '7' } : {}
      )
      expect(parseHttpStatus(wire.text)).toBe(status)
      const result = await run(wire.text)
      expect(result.outcome.status).toBe(expected)
      // Every verdict but the 404 is emitted from the trusted status alone.
      // The 404 is ambiguous — the server answers 404 for a vanished source
      // AND for a vanished destination (RP-027) — so that one verdict costs
      // a single targeted re-read of the source to name the side.
      expect(result.resolveSource).toHaveBeenCalledTimes(status === 404 ? 2 : 1)
      expect(result.moveResource).toHaveBeenCalledTimes(1)
      if (result.outcome.status === 'rate-limited') {
        expect(result.outcome.retryAfterSeconds).toBe(7)
        expect(result.outcome.message).toBe('Too many file requests — try again in 7s.')
      }
      if (result.outcome.status === 'unconfirmed') {
        // B6 (refusal UX matrix): a 403 explains that permission could not be
        // confirmed — generic re-check copy, never the raw server verdict or
        // plumbing markers. The trusted STATUS still drives the verdict and
        // the no-retry contract asserted above.
        expect(result.outcome.message).toBe(
          'EvenDrive could not confirm permission for this move. Refresh and try again.'
        )
        expect(result.outcome.message).not.toMatch(/httpStatus=|retryAfterSeconds=|move rejected/)
      }
      if (result.outcome.status === 'destination-rejected') {
        expect(result.outcome.message).toBe(
          'The server rejected this destination. Refresh and choose a different folder.'
        )
        const toast = vi.fn()
        toastMoveOutcome(toast, result.outcome, 'report.md', 'Dest', 'file')
        expect(toast).toHaveBeenCalledWith(`report.md → Dest: ${result.outcome.message}`, 'error')
      }
    }
  )

  it('retains the actual transport error as cause and strips forged status/retry prose', async () => {
    const wire = await wireFailure(500, 'upstream 429 httpStatus=412 retryAfterSeconds=9')
    expect(wire.error).toBeInstanceOf(GfsUriError)
    expect((wire.error as Error).cause).toBeInstanceOf(ApiError)
    expect(((wire.error as Error).cause as ApiError).status).toBe(500)
    expect(parseHttpStatus(wire.text)).toBe(500)
    expect(parseRetryAfterSeconds(wire.text)).toBeNull()
    expect(wire.text).not.toContain('httpStatus=412')
    const result = await run(wire.text)
    expect(result.outcome.status).toBe('unconfirmed')
    expect(result.resolveSource).toHaveBeenCalledTimes(2)
    expect(result.moveResource).toHaveBeenCalledTimes(1)
  })

  it.each([404, 500] as const)(
    'routes a verification-time 401 after PATCH %i through the session authority classifier',
    async patchStatus => {
      const patchFailure = await wireFailure(patchStatus)
      const verificationFailure = await gfsRouteFailureMessage(
        client => client.resolveUri(plan.source.gfsUri, 'fixture-session-token'),
        401,
        { code: 'unauthorized', message: 'verification session expired' }
      )
      const snapshot = await resolveResource(
        resolvedFile(sourceId, 'report.md', { parentResourceId: oldParentId, version: 7 })
      )
      let resolveCalls = 0
      const resolveSource = vi.fn(async () => {
        resolveCalls += 1
        if (resolveCalls === 1) return snapshot
        throw new Error(verificationFailure)
      })
      const moveResource = vi.fn(async () => {
        throw new Error(patchFailure.text)
      })
      const isSessionAuthorityFailure = vi.fn((error: unknown) =>
        isGfsSessionAuthorityFailure(String(error), 'operation')
      )

      const outcome = await commitGfsMove(
        { resolveSource, moveResource, isSessionAuthorityFailure },
        plan
      )

      expect(outcome.status).toBe('session-lost')
      expect(resolveSource).toHaveBeenCalledTimes(2)
      expect(moveResource).toHaveBeenCalledTimes(1)
      expect(isSessionAuthorityFailure).toHaveBeenCalledTimes(2)
      const verificationError = isSessionAuthorityFailure.mock.calls.at(-1)?.[0]
      expect(verificationError).toBeInstanceOf(Error)
      expect((verificationError as Error).message).toBe(verificationFailure)
    }
  )

  it('keeps the approved 409 numbered-name attempts bounded', async () => {
    const { text } = await wireFailure(409)
    const result = await run(text, true)
    expect(result.outcome.status).toBe('conflict-stopped')
    expect(result.moveResource).toHaveBeenCalledTimes(GFS_MOVE_MAX_NETWORK_ATTEMPTS)
    expect(result.resolveSource).toHaveBeenCalledTimes(1)
    expect(result.moveResource.mock.calls.map(call => call[3])).toEqual([
      undefined,
      'report (1).md',
      'report (2).md',
    ])
  })

  it('retains a produced 409 when the owner is lost before its numbered retry', async () => {
    const { text } = await wireFailure(409)
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    const result = await run(text, true, false, isCurrent)
    const outcome = result.outcome

    expect(outcome.status).toBe('conflict-stopped')
    if (outcome.status === 'conflict-stopped') {
      expect(outcome.message).toContain('already exists')
    }
    expect(isCurrent).toHaveBeenCalledTimes(2)
    expect(result.moveResource).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    'verifies a real status-free transport failure once (landed=%s), with no re-PATCH',
    async landed => {
      // A loopback HTTP fixture closes the response socket before any status.
      // The client surfaces its real transport exception, never an invented marker.
      const { createServer } = await import('node:http')
      const { GfsClient } = await import('../../../../src/gfs/uriHandler')
      const { requestJson } = await import('../../../../src/httpClient')
      const server = createServer((request, _response) => {
        request.socket.destroy()
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      try {
        const address = server.address() as import('node:net').AddressInfo
        const client = new GfsClient({
          baseUrl: `http://127.0.0.1:${address.port}`,
          requestJson,
          fetchBytes: async () => new ArrayBuffer(0),
        })
        let failure = ''
        try {
          await client.moveResource(
            { resourceId: sourceId, destinationId, ifMatch: 7 },
            'fixture-session-token'
          )
        } catch (error) {
          failure = (error as Error).message
        }
        expect(failure).not.toBe('')
        expect(parseHttpStatus(failure)).toBeNull()
        const result = await run(failure, false, landed)
        expect(result.outcome.status).toBe(landed ? 'committed' : 'unconfirmed')
        expect(result.resolveSource).toHaveBeenCalledTimes(2)
        expect(result.moveResource).toHaveBeenCalledTimes(1)
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    }
  )
})
