import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { AppService } from '../appService'

const binding = {
  requestId: 'tab-a:close-1',
  tabId: 'tab-a',
  sessionGeneration: 0,
  ownerIdentities: ['owner-a'],
}

function serviceWithCloseApi() {
  const service = new AppService() as any
  return {
    authorize: () => service.authorizeMarkdownTabClose(42, binding),
    status: (candidate = binding, senderId = 42) =>
      service.getMarkdownTabClosePermitStatus(senderId, candidate),
    cancel: (candidate = binding, senderId = 42) =>
      service.cancelMarkdownTabClosePermit(senderId, candidate),
    consume: (candidate = binding, senderId = 42) =>
      service.consumeMarkdownTabClosePermit(senderId, candidate),
  }
}

type CloseState = 'unknown' | 'granted' | 'denied' | 'consumed' | 'cancelled' | 'expired'
type CloseModel = { state: CloseState; otherSenderState: CloseState }
type CloseReal = { service: any }

class Authorize implements fc.Command<CloseModel, CloseReal> {
  check() {
    return true
  }
  run(model: CloseModel, real: CloseReal) {
    const expected = model.state === 'unknown' ? 'granted' : model.state
    if (model.state === 'unknown') model.state = 'granted'
    expect(real.service.authorizeMarkdownTabClose(42, binding)).toBe(expected)
  }
  toString() {
    return 'Authorize'
  }
}

class Cancel implements fc.Command<CloseModel, CloseReal> {
  check() {
    return true
  }
  run(model: CloseModel, real: CloseReal) {
    if (model.state === 'unknown') model.state = 'cancelled'
    expect(real.service.cancelMarkdownTabClosePermit(42, binding)).toBe(model.state)
  }
  toString() {
    return 'Cancel'
  }
}

class Consume implements fc.Command<CloseModel, CloseReal> {
  check() {
    return true
  }
  run(model: CloseModel, real: CloseReal) {
    if (model.state === 'granted') model.state = 'consumed'
    expect(real.service.consumeMarkdownTabClosePermit(42, binding)).toBe(model.state)
  }
  toString() {
    return 'Consume'
  }
}

class Query implements fc.Command<CloseModel, CloseReal> {
  check() {
    return true
  }
  run(model: CloseModel, real: CloseReal) {
    expect(real.service.getMarkdownTabClosePermitStatus(42, binding)).toBe(model.state)
  }
  toString() {
    return 'QueryStatus'
  }
}

class MismatchedBinding implements fc.Command<CloseModel, CloseReal> {
  check(model: CloseModel) {
    return model.state !== 'unknown'
  }
  run(_model: CloseModel, real: CloseReal) {
    const mismatches = [
      { ...binding, tabId: 'rebound-tab' },
      { ...binding, sessionGeneration: binding.sessionGeneration + 1 },
      { ...binding, ownerIdentities: ['owner-rebound'] },
    ]
    for (const mismatch of mismatches) {
      expect(real.service.getMarkdownTabClosePermitStatus(42, mismatch)).toBe('unknown')
      expect(real.service.cancelMarkdownTabClosePermit(42, mismatch)).toBe('unknown')
      expect(real.service.consumeMarkdownTabClosePermit(42, mismatch)).toBe('unknown')
    }
  }
  toString() {
    return 'MismatchedBinding'
  }
}

class MismatchedSender implements fc.Command<CloseModel, CloseReal> {
  check() {
    return true
  }
  run(model: CloseModel, real: CloseReal) {
    expect(real.service.getMarkdownTabClosePermitStatus(43, binding)).toBe(model.otherSenderState)
    if (model.otherSenderState === 'unknown') model.otherSenderState = 'cancelled'
    expect(real.service.cancelMarkdownTabClosePermit(43, binding)).toBe(model.otherSenderState)
    expect(real.service.getMarkdownTabClosePermitStatus(43, binding)).toBe(model.otherSenderState)
  }
  toString() {
    return 'MismatchedSender'
  }
}

describe('AppService Markdown tab close request lifecycle', () => {
  it('runs generated lifecycle commands against the real producer and compares quiescent state', () => {
    const commands = [
      fc.constant(new Authorize()),
      fc.constant(new Cancel()),
      fc.constant(new Consume()),
      fc.constant(new Query()),
      fc.constant(new MismatchedBinding()),
      fc.constant(new MismatchedSender()),
    ]
    fc.assert(
      fc.property(fc.commands(commands, { maxCommands: 40 }), generated => {
        const service = new AppService() as any
        fc.modelRun(
          () => ({
            model: { state: 'unknown' as CloseState, otherSenderState: 'unknown' as CloseState },
            real: { service },
          }),
          generated
        )
      }),
      { numRuns: 150 }
    )
  })

  it('uses scheduler order to linearize real authorization against cancellation', async () => {
    const observedOrders = new Set<string>()
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async scheduler => {
        const service = new AppService() as any
        const order: string[] = []
        let authorizeState: CloseState | undefined
        let cancelState: CloseState | undefined
        const authorize = scheduler.scheduleSequence([
          {
            label: 'main-authorize',
            builder: async () => {
              order.push('authorize')
              authorizeState = service.authorizeMarkdownTabClose(42, binding)
            },
          },
        ])
        const cancel = scheduler.scheduleSequence([
          {
            label: 'main-cancel',
            builder: async () => {
              order.push('cancel')
              cancelState = service.cancelMarkdownTabClosePermit(42, binding)
            },
          },
        ])
        await scheduler.waitIdle()
        await Promise.all([authorize.task, cancel.task])
        observedOrders.add(order.join('>'))

        const state = service.getMarkdownTabClosePermitStatus(42, binding)
        expect(['granted', 'cancelled']).toContain(state)
        if (state === 'granted') {
          expect(cancelState).toBe('granted')
          expect(service.consumeMarkdownTabClosePermit(42, binding)).toBe('consumed')
        } else {
          expect(authorizeState).toBe('cancelled')
          expect(service.consumeMarkdownTabClosePermit(42, binding)).toBe('cancelled')
        }
      }),
      { numRuns: 100 }
    )
    expect(observedOrders).toEqual(new Set(['authorize>cancel', 'cancel>authorize']))
  })

  it('keeps a committed grant available through cancellation and consumes it once', () => {
    const close = serviceWithCloseApi()

    expect(close.authorize()).toBe('granted')
    expect(close.cancel()).toBe('granted')
    expect(close.status()).toBe('granted')
    expect(close.consume()).toBe('consumed')
    expect(close.consume()).toBe('consumed')
  })

  it('tombstones cancellation that arrives before a delayed authorization', () => {
    const close = serviceWithCloseApi()

    expect(close.cancel()).toBe('cancelled')
    expect(close.authorize()).toBe('cancelled')
    expect(close.status()).toBe('cancelled')
    expect(close.consume()).toBe('cancelled')
  })

  it('expires a granted request in main and rejects a late consume', () => {
    vi.useFakeTimers()
    try {
      const close = serviceWithCloseApi()
      expect(close.authorize()).toBe('granted')

      vi.advanceTimersByTime(30_001)

      expect(close.status()).toBe('expired')
      expect(close.consume()).toBe('expired')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reveal or mutate a request through another exact binding', () => {
    const close = serviceWithCloseApi()
    expect(close.authorize()).toBe('granted')

    const rebound = { ...binding, tabId: 'tab-b' }
    expect(close.status(rebound)).toBe('unknown')
    expect(close.cancel(rebound)).toBe('unknown')
    expect(close.consume(rebound)).toBe('unknown')
    const reboundOwner = { ...binding, ownerIdentities: ['owner-b'] }
    expect(close.status(reboundOwner)).toBe('unknown')
    expect(close.cancel(reboundOwner)).toBe('unknown')
    expect(close.consume(reboundOwner)).toBe('unknown')
    expect(close.status()).toBe('granted')
    expect(close.consume()).toBe('consumed')
  })
})
