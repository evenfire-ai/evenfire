import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { handleTaskResultRoute } from '../routes'
import { makeHandlers } from './testHelpers'

function responseCapture(): { res: Response; status: () => number; body: () => unknown } {
  let statusCode = 0
  let body: unknown
  const res = {
    writeHead: vi.fn((status: number) => {
      statusCode = status
      return res
    }),
    end: vi.fn((value?: string) => {
      body = value ? JSON.parse(value) : undefined
      return res
    }),
  } as unknown as Response
  return { res, status: () => statusCode, body: () => body }
}

function taskReadRequest(taskId: string): Request {
  const userId = '11111111-1111-4111-8111-111111111111'
  return {
    query: {},
    runtimeCaller: {
      caller: 'rpc-proxy',
      hostRef: 'chatllm',
      userId,
      actionContextV2: {
        operationId: 'task.read',
        userId,
        accessPathId: `ap1_${'a'.repeat(43)}`,
        target: { hostRef: 'mcp-host/chatllm', taskId },
      },
    },
  } as unknown as Request
}

describe('resumable task locator authorization', () => {
  it('allows storage lookup only when the fresh action target binds the exact task ID', async () => {
    const taskResultHandler = vi.fn().mockResolvedValue({ success: true, taskId: 'task-1' })
    const captured = responseCapture()
    const req = taskReadRequest('task-1')

    await handleTaskResultRoute(req, captured.res, 'task-1', makeHandlers({ taskResultHandler }))

    expect(captured.status()).toBe(200)
    expect(taskResultHandler).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        caller: 'rpc-proxy',
        userId: '11111111-1111-4111-8111-111111111111',
      })
    )
  })

  it('rejects task ID substitution before the resumable task is loaded', async () => {
    const taskResultHandler = vi.fn()
    const captured = responseCapture()

    await handleTaskResultRoute(
      taskReadRequest('authorized-task'),
      captured.res,
      'substituted-task',
      makeHandlers({ taskResultHandler })
    )

    expect(captured.status()).toBe(403)
    expect(captured.body()).toEqual({ error: 'Runtime edge action mismatch' })
    expect(taskResultHandler).not.toHaveBeenCalled()
  })
})
