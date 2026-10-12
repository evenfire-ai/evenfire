import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { runChatSwitchRequest } from '../chatSwitchRequest'

describe('logical switch request invariants', () => {
  it('composes duplicate awaiters without duplicate execution or reports', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 1, max: 30 }),
        async (current, succeeds, observerCount) => {
          const error = new Error('request failure')
          const execute = vi.fn(() => (succeeds ? Promise.resolve() : Promise.reject(error)))
          const report = vi.fn()
          const request = runChatSwitchRequest(execute, () => current, report)
          const results = await Promise.allSettled(
            Array.from({ length: observerCount }, () => request)
          )
          expect(execute).toHaveBeenCalledTimes(1)
          expect(report).toHaveBeenCalledTimes(!succeeds && current ? 1 : 0)
          expect(
            results.every(result =>
              succeeds
                ? result.status === 'fulfilled'
                : result.status === 'rejected' && result.reason === error
            )
          ).toBe(true)
        }
      ),
      { numRuns: 500 }
    )
  })

  it('never lets a settled request own a later independent failure', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 2, maxLength: 30 }), async outcomes => {
        const report = vi.fn()
        for (const succeeds of outcomes) {
          await runChatSwitchRequest(
            () => (succeeds ? Promise.resolve() : Promise.reject(new Error('independent failure'))),
            () => true,
            report
          ).catch(() => undefined)
        }
        expect(report).toHaveBeenCalledTimes(outcomes.filter(succeeds => !succeeds).length)
      }),
      { numRuns: 500 }
    )
  })
})
