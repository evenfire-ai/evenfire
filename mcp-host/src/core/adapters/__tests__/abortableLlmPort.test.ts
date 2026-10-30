import { describe, expect, it, vi } from 'vitest'
import type { LlmPort } from '../../interfaces'
import { bindTaskSignal } from '../abortableLlmPort'

describe('task-bound LLM calls', () => {
  it.each(['complete', 'completeWithTools'] as const)(
    'aborts %s and ignores late provider completion',
    async method => {
      const controller = new AbortController()
      const requestController = new AbortController()
      let finish: (value: any) => void = () => {
        throw new Error('provider not started')
      }
      const call = vi.fn(
        (_request: { signal?: AbortSignal }) =>
          new Promise<any>(resolve => {
            finish = resolve
          })
      )
      const inner: LlmPort = { modelName: () => 'test', complete: call, completeWithTools: call }
      const port = bindTaskSignal(inner, controller.signal)
      const pending = port[method]({
        messages: [],
        tools: [],
        signal: requestController.signal,
      } as any).catch(error => error)
      await Promise.resolve()
      const forwardedSignal = call.mock.calls[0][0].signal!
      expect(forwardedSignal).toBeInstanceOf(AbortSignal)
      expect(forwardedSignal.aborted).toBe(false)
      const reason = new Error('task duration exceeded')
      controller.abort(reason)
      expect(forwardedSignal.aborted).toBe(true)
      expect(forwardedSignal.reason).toBe(reason)
      expect(requestController.signal.aborted).toBe(false)
      expect(await pending).toBe(reason)
      expect(call.mock.calls.length).toBe(1)
      finish({ content: 'late result' })
      expect(await pending).toBe(reason)
    }
  )
  it.each(['complete', 'completeWithTools'] as const)(
    'A1: aborting the request signal cancels %s at once and ignores a late provider result',
    async method => {
      const taskController = new AbortController()
      const requestController = new AbortController()
      let finish: (value: any) => void = () => {
        throw new Error('provider not started')
      }
      const call = vi.fn(
        (_request: { signal?: AbortSignal }) =>
          new Promise<any>(resolve => {
            finish = resolve
          })
      )
      const inner: LlmPort = { modelName: () => 'test', complete: call, completeWithTools: call }
      const port = bindTaskSignal(inner, taskController.signal)
      let rejection: unknown
      const pending = port[method]({
        messages: [],
        tools: [],
        signal: requestController.signal,
      } as any).catch(error => {
        rejection = error
        return error
      })
      await Promise.resolve()
      expect(call).toHaveBeenCalledTimes(1)
      const forwardedSignal = call.mock.calls[0]![0].signal!
      expect(forwardedSignal.aborted).toBe(false)
      const reason = new Error('request retry deadline')
      requestController.abort(reason)
      await Promise.resolve()
      expect(forwardedSignal.aborted).toBe(true)
      expect(forwardedSignal.reason).toBe(reason)
      expect(rejection).toBe(reason)
      expect(taskController.signal.aborted).toBe(false)
      expect(await pending).toBe(reason)
      finish({ content: 'late provider answer' })
      expect(await pending).toBe(reason)
      expect(call).toHaveBeenCalledTimes(1)
    }
  )
})
