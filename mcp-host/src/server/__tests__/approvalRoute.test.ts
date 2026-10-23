import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { handleApprovalRoute } from '../routes'
import { makeHandlers } from './testHelpers'

function makeRes() {
  const captured: { statusCode?: number; jsonBody?: unknown } = {}
  const res = {
    writeHead: vi.fn().mockImplementation((status: number) => {
      captured.statusCode = status
      return res
    }),
    end: vi.fn().mockImplementation((body?: string) => {
      if (typeof body === 'string') captured.jsonBody = JSON.parse(body)
      return res
    }),
  } as unknown as Response
  return {
    get statusCode() {
      return captured.statusCode
    },
    get jsonBody() {
      return captured.jsonBody
    },
    res,
  }
}

function makeReq(
  body: Record<string, unknown>,
  runtimeCaller: Record<string, unknown> = {
    caller: 'rpc-proxy',
    userId: 'user-1',
    hostRef: 'host-1',
  }
): Request {
  return {
    runtimeCaller,
    params: {},
    body,
    query: {},
    headers: {},
  } as unknown as Request
}

describe('handleApprovalRoute — alwaysApprove consent', () => {
  it.each([['false'], ['true'], [1], [{}]])(
    'rejects a non-boolean alwaysApprove (%j) before any decision is applied',
    async value => {
      const approvalHandler = vi.fn()
      const out = makeRes()

      await handleApprovalRoute(
        makeReq({ requestId: 'req-1', alwaysApprove: value }),
        out.res,
        true,
        makeHandlers({ approvalHandler })
      )

      expect(out.statusCode).toBe(400)
      expect(approvalHandler).not.toHaveBeenCalled()
    }
  )

  it.each([
    [true, true],
    [false, false],
    [undefined, false],
  ])('passes alwaysApprove %j through as %j', async (value, expected) => {
    const approvalHandler = vi.fn().mockResolvedValue({ success: true })
    const out = makeRes()

    await handleApprovalRoute(
      makeReq({ requestId: 'req-1', alwaysApprove: value }),
      out.res,
      true,
      makeHandlers({ approvalHandler })
    )

    expect(out.statusCode).toBe(200)
    expect(approvalHandler).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-1', alwaysApprove: expected })
    )
  })

  it('records a denial even when it carries a non-boolean alwaysApprove', async () => {
    const approvalHandler = vi.fn().mockResolvedValue({ success: true })
    const out = makeRes()

    await handleApprovalRoute(
      makeReq({ requestId: 'req-1', alwaysApprove: 'true' }),
      out.res,
      false,
      makeHandlers({ approvalHandler })
    )

    expect(out.statusCode).toBe(200)
    expect(approvalHandler).toHaveBeenCalledWith(
      expect.objectContaining({ approved: false, alwaysApprove: false })
    )
  })

  it('answers a mismatched channel caller with 403 before validating alwaysApprove', async () => {
    const approvalHandler = vi.fn()
    const out = makeRes()

    await handleApprovalRoute(
      makeReq(
        {
          userId: 'user-1',
          requestId: 'req-1',
          channelType: 'slack',
          channelId: 'C-other',
          alwaysApprove: 'true',
        },
        { caller: 'channel-reader', channelType: 'slack', channelId: 'C-1', sender: 'user-1' }
      ),
      out.res,
      true,
      makeHandlers({ approvalHandler })
    )

    expect(out.statusCode).toBe(403)
    expect(approvalHandler).not.toHaveBeenCalled()
  })

  it('never records persistent consent on a denial', async () => {
    const approvalHandler = vi.fn().mockResolvedValue({ success: true })
    const out = makeRes()

    await handleApprovalRoute(
      makeReq({ requestId: 'req-1', alwaysApprove: true }),
      out.res,
      false,
      makeHandlers({ approvalHandler })
    )

    expect(approvalHandler).toHaveBeenCalledWith(
      expect.objectContaining({ approved: false, alwaysApprove: false })
    )
  })
})
