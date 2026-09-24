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
})
