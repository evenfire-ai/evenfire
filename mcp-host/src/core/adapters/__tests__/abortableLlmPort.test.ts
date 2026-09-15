import { describe, expect, it, vi } from 'vitest'
import type { LlmPort } from '../../interfaces'
import { bindTaskSignal } from '../abortableLlmPort'

describe('task-bound LLM calls', () => {
  it.each(['complete', 'completeWithTools'] as const)(
    'aborts %s and ignores late provider completion',
    async method => {
      const controller = new AbortController()
      let finish: (value: any) => void = () => {
        throw new Error('provider not started')
      }
      const call = vi.fn(
        () =>
          new Promise<any>(resolve => {
            finish = resolve
          })
      )
      const inner: LlmPort = { modelName: () => 'test', complete: call, completeWithTools: call }
      const port = bindTaskSignal(inner, controller.signal)
      const pending = port[method]({ messages: [], tools: [] } as any).catch(error => error)
      await Promise.resolve()
      const reason = new Error('task duration exceeded')
      controller.abort(reason)
      expect(await pending).toBe(reason)
      expect(call.mock.calls.length).toBe(1)
      finish({ content: 'late result' })
      expect(await pending).toBe(reason)
    }
  )
})
