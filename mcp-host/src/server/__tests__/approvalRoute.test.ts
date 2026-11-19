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

// task.manage targets copied from rpc-proxy's producer-bound fixture
// (rpc-proxy/src/__tests__/host-ref-validation.test.ts, "approval approve" and
// "approval deny"). The bodies are the upstream bodies rpc-proxy builds
// (rpc-proxy/src/routes/rpc.ts approve and deny handlers): no toolCallId.
const V2_USER_ID = '11111111-1111-4111-8111-111111111111'
const V2_TASK_ID = '60000000-0000-4000-8000-000000000006'
const V2_APPROVAL_REQUEST_ID = '70000000-0000-4000-8000-000000000007'

type ApprovalAction = 'approve' | 'deny'

function v2Caller(targetAction: ApprovalAction): Record<string, unknown> {
  return {
    caller: 'rpc-proxy',
    hostRef: 'chatllm',
    userId: V2_USER_ID,
    actionContextV2: {
      operationId: 'task.manage',
      userId: V2_USER_ID,
      target: {
        hostRef: 'mcp-host/chatllm',
        taskId: V2_TASK_ID,
        action: targetAction,
        approvalRequestId: V2_APPROVAL_REQUEST_ID,
      },
    },
  }
}

function upstreamBody(route: ApprovalAction): Record<string, unknown> {
  const body: Record<string, unknown> = {
    userId: V2_USER_ID,
    taskId: V2_TASK_ID,
    requestId: V2_APPROVAL_REQUEST_ID,
  }
  if (route === 'approve') body.alwaysApprove = false
  return body
}

function expectedDecision(route: ApprovalAction) {
  return {
    userId: V2_USER_ID,
    requestId: V2_APPROVAL_REQUEST_ID,
    approved: route === 'approve',
    alwaysApprove: false,
    channelType: 'rpc',
    channelId: 'chatllm',
  }
}

function approvalHandlerMock() {
  return vi.fn().mockResolvedValue({ success: true })
}

describe('handleApprovalRoute — V2 task.manage target', () => {
  async function send(
    route: ApprovalAction,
    targetAction: ApprovalAction,
    body: Record<string, unknown>,
    approvalHandler: ReturnType<typeof approvalHandlerMock>
  ) {
    const out = makeRes()
    await handleApprovalRoute(
      makeReq(body, v2Caller(targetAction)),
      out.res,
      route === 'approve',
      makeHandlers({ approvalHandler })
    )
    return out
  }

  // The accept is the liveness witness for the reject that follows it: the same
  // caller shape and body shape reach the decision, so a 403 with no second
  // handler call can only come from the target guard.
  async function expectAcceptThenReject(
    accept: { route: ApprovalAction; targetAction: ApprovalAction },
    reject: {
      route: ApprovalAction
      targetAction: ApprovalAction
      body: Record<string, unknown>
    }
  ) {
    const approvalHandler = approvalHandlerMock()

    const accepted = await send(
      accept.route,
      accept.targetAction,
      upstreamBody(accept.route),
      approvalHandler
    )
    expect(accepted.statusCode).toBe(200)
    expect(approvalHandler).toHaveBeenCalledTimes(1)
    expect(approvalHandler).toHaveBeenCalledWith(expectedDecision(accept.route))

    const rejected = await send(reject.route, reject.targetAction, reject.body, approvalHandler)
    expect(rejected.statusCode).toBe(403)
    expect(rejected.jsonBody).toEqual({ error: 'Runtime edge action mismatch' })
    expect(approvalHandler).toHaveBeenCalledTimes(1)
  }

  it.each<[ApprovalAction]>([['approve'], ['deny']])(
    'applies the %s decision when the body matches the bound target',
    async route => {
      const approvalHandler = approvalHandlerMock()

      const out = await send(route, route, upstreamBody(route), approvalHandler)

      expect(out.statusCode).toBe(200)
      expect(approvalHandler).toHaveBeenCalledTimes(1)
      expect(approvalHandler).toHaveBeenCalledWith(expectedDecision(route))
    }
  )

  it('rejects an approve for another task than the bound one', async () => {
    await expectAcceptThenReject(
      { route: 'approve', targetAction: 'approve' },
      {
        route: 'approve',
        targetAction: 'approve',
        body: { ...upstreamBody('approve'), taskId: '60000000-0000-4000-8000-000000000099' },
      }
    )
  })

  it('rejects an approve whose body omits the bound taskId', async () => {
    const withoutTaskId = upstreamBody('approve')
    delete withoutTaskId.taskId
    await expectAcceptThenReject(
      { route: 'approve', targetAction: 'approve' },
      { route: 'approve', targetAction: 'approve', body: withoutTaskId }
    )
  })

  it('rejects an approve for another request id than the bound one', async () => {
    await expectAcceptThenReject(
      { route: 'approve', targetAction: 'approve' },
      {
        route: 'approve',
        targetAction: 'approve',
        body: { ...upstreamBody('approve'), requestId: '70000000-0000-4000-8000-000000000099' },
      }
    )
  })

  it('rejects an approve-bound authority used on the deny route', async () => {
    await expectAcceptThenReject(
      { route: 'deny', targetAction: 'deny' },
      { route: 'deny', targetAction: 'approve', body: upstreamBody('deny') }
    )
  })

  it('rejects a deny-bound authority used on the approve route', async () => {
    await expectAcceptThenReject(
      { route: 'approve', targetAction: 'approve' },
      { route: 'approve', targetAction: 'deny', body: upstreamBody('approve') }
    )
  })

  it('rejects a deny for another task than the bound one', async () => {
    await expectAcceptThenReject(
      { route: 'deny', targetAction: 'deny' },
      {
        route: 'deny',
        targetAction: 'deny',
        body: { ...upstreamBody('deny'), taskId: '60000000-0000-4000-8000-000000000099' },
      }
    )
  })

  it('rejects a deny for another request id than the bound one', async () => {
    await expectAcceptThenReject(
      { route: 'deny', targetAction: 'deny' },
      {
        route: 'deny',
        targetAction: 'deny',
        body: { ...upstreamBody('deny'), requestId: '70000000-0000-4000-8000-000000000099' },
      }
    )
  })

  // The guard binds the request id the decision applies (requestId). A
  // toolCallId in the body is not part of the mcp-host approval API and is
  // ignored by the guard.
  it.each<[ApprovalAction]>([['approve'], ['deny']])(
    'ignores a toolCallId equal to the bound id when the %s decides another requestId',
    async route => {
      await expectAcceptThenReject(
        { route, targetAction: route },
        {
          route,
          targetAction: route,
          body: {
            ...upstreamBody(route),
            toolCallId: V2_APPROVAL_REQUEST_ID,
            requestId: 'other-id',
          },
        }
      )
    }
  )

  it.each<[ApprovalAction, string]>([
    ['approve', 'other-id'],
    ['approve', ''],
    ['deny', 'other-id'],
    ['deny', ''],
  ])(
    'applies the %s decision for the bound requestId despite a stray toolCallId %j',
    async (route, toolCallId) => {
      const approvalHandler = approvalHandlerMock()

      const out = await send(route, route, { ...upstreamBody(route), toolCallId }, approvalHandler)

      expect(out.statusCode).toBe(200)
      expect(approvalHandler).toHaveBeenCalledTimes(1)
      expect(approvalHandler).toHaveBeenCalledWith(expectedDecision(route))
    }
  )
})
