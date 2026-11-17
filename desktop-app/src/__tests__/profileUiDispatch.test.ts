import { beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { AppService } from '../appService.js'

type Handler = (event: any, payload?: any) => unknown

const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  listeners: new Map<string, Handler>(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn(() => false) }),
  app: { on: vi.fn(), getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0') },
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => electron.handlers.set(channel, handler)),
    on: vi.fn((channel: string, listener: Handler) => electron.listeners.set(channel, listener)),
    removeHandler: vi.fn(),
  },
}))

vi.mock('../appService.js', () => ({ AppService: class {} }))

const frame = { url: 'file:///app/index.html', isDestroyed: vi.fn(() => false) }
const senderListeners = new Map<string, Set<(...args: unknown[]) => void>>()
const sender = {
  isDestroyed: vi.fn(() => false),
  mainFrame: frame,
  send: vi.fn(),
  on: vi.fn((eventName: string, callback: (...args: unknown[]) => void) => {
    const callbacks = senderListeners.get(eventName) ?? new Set()
    callbacks.add(callback)
    senderListeners.set(eventName, callbacks)
    return sender
  }),
  once: vi.fn((eventName: string, callback: (...args: unknown[]) => void) => {
    const wrapped = (...args: unknown[]) => {
      senderListeners.get(eventName)?.delete(wrapped)
      callback(...args)
    }
    const callbacks = senderListeners.get(eventName) ?? new Set()
    callbacks.add(wrapped)
    senderListeners.set(eventName, callbacks)
    return sender
  }),
  removeListener: vi.fn((eventName: string, callback: (...args: unknown[]) => void) => {
    senderListeners.get(eventName)?.delete(callback)
    return sender
  }),
}
const binding = {
  sessionGeneration: 7,
  profileId: 'profile-a',
  profileIncarnation: 'incarnation-a',
  restBaseUrl: 'https://api.example.test',
}
let bindingCurrent = true
let reportFailure: ((correlationId: string, deadline: number) => void) | undefined
const service = {
  getProfileUiDispatchBinding: vi.fn(() => binding),
  isProfileUiDispatchBindingCurrent: vi.fn(() => bindingCurrent),
  openForgotPassword: vi.fn(async (_email: string, reporter: typeof reportFailure) => {
    reportFailure = reporter
    return {
      profileUiUrl: 'https://profile.example.test/forgot-password',
      dispatchAccepted: true,
      correlationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      dispatchDeadline: Date.now() + 10_000,
    }
  }),
}

const event = () => ({ sender, senderFrame: frame, returnValue: undefined })
const invoke = async (documentLease = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') => {
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(service as unknown as AppService, async () => 0)
  const handler = electron.handlers.get('auth:openForgotPassword')
  if (!handler) throw new Error('Profile UI IPC handler was not registered')
  return handler(event(), { email: '', documentLease })
}

describe('Profile UI late dispatch main-process authorization', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.listeners.clear()
    sender.send.mockClear()
    senderListeners.clear()
    sender.isDestroyed.mockReturnValue(false)
    frame.isDestroyed.mockReturnValue(false)
    sender.mainFrame = frame
    bindingCurrent = true
    reportFailure = undefined
    service.openForgotPassword.mockClear()
    service.getProfileUiDispatchBinding.mockClear()
    service.isProfileUiDispatchBindingCurrent.mockClear()
  })

  it('suppresses enqueue after the document or captured binding changes', async () => {
    await invoke()
    if (!reportFailure) throw new Error('Reporter was not captured')
    bindingCurrent = false
    reportFailure('cccccccc-cccc-cccc-cccc-cccccccccccc', Date.now() + 5_000)
    expect(sender.send).not.toHaveBeenCalled()

    bindingCurrent = true
    const currentFrame = { url: 'file:///app/next.html', isDestroyed: vi.fn(() => false) }
    sender.mainFrame = currentFrame
    reportFailure('dddddddd-dddd-dddd-dddd-dddddddddddd', Date.now() + 5_000)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('authorizes and sends only when the captured binding is still current', async () => {
    await invoke()
    if (!reportFailure) throw new Error('Reporter was not captured')
    const deadline = Date.now() + 5_000
    reportFailure('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', deadline)
    expect(sender.send).toHaveBeenCalledWith('auth:profileUiDispatchFailurePending', {
      correlationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      documentLease: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      dispatchDeadline: deadline,
    })

    const authorize = electron.listeners.get('auth:authorizeProfileUiDispatchFailure')
    if (!authorize) throw new Error('Synchronous authorization handler was not registered')
    const authorizationEvent = event()
    authorize(authorizationEvent, {
      correlationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      documentLease: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      dispatchDeadline: deadline,
    })
    expect(authorizationEvent.returnValue).toBe(true)
    expect(sender.send).toHaveBeenLastCalledWith('auth:profileUiDispatchFailed', {
      correlationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      documentLease: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      dispatchDeadline: deadline,
      binding,
    })
  })

  it('matches an independent model across dispatch, failure, binding, and document schedules', async () => {
    type Model = {
      started: boolean
      accepted: boolean
      failurePending: boolean
      failureReported: boolean
      bindingCurrent: boolean
      documentCurrent: boolean
      now: number
      deadline: number
      delivered: boolean
    }
    type Real = {
      scheduler: fc.Scheduler
      acceptance?: Promise<unknown>
      report?: typeof reportFailure
      now: number
    }

    class StartDispatch implements fc.AsyncCommand<Model, Real> {
      check(model: Readonly<Model>): boolean {
        return !model.started
      }
      async run(model: Model, real: Real): Promise<void> {
        electron.handlers.clear()
        electron.listeners.clear()
        sender.send.mockClear()
        senderListeners.clear()
        sender.isDestroyed.mockReturnValue(false)
        frame.isDestroyed.mockReturnValue(false)
        sender.mainFrame = frame
        bindingCurrent = true
        reportFailure = undefined
        service.openForgotPassword.mockClear()
        const clock = vi.spyOn(Date, 'now').mockReturnValue(real.now)
        real.report = undefined
        service.openForgotPassword.mockImplementation((_email, reporter) => {
          real.report = reporter
          reportFailure = reporter
          return real.scheduler.schedule(
            Promise.resolve({
              profileUiUrl: 'https://profile.example.test/forgot-password',
              dispatchAccepted: true,
              correlationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
              dispatchDeadline: model.deadline,
            }),
            'external browser dispatch acceptance'
          )
        })
        real.acceptance = invoke()
        await vi.waitFor(() => expect(service.openForgotPassword).toHaveBeenCalledTimes(1))
        model.started = true
        // The model's clock is intentionally retained for the remaining commands.
        void clock
      }
      toString(): string {
        return 'start-profile-ui-dispatch()'
      }
    }

    class ReportFailure implements fc.AsyncCommand<Model, Real> {
      check(model: Readonly<Model>): boolean {
        return model.started && !model.failureReported && model.now <= model.deadline
      }
      async run(model: Model, real: Real): Promise<void> {
        if (!real.report) throw new Error('dispatch did not capture its failure reporter')
        const shouldQueue = model.bindingCurrent && model.documentCurrent
        real.report('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', model.deadline)
        model.failureReported = true
        model.failurePending = shouldQueue
        expect(
          sender.send.mock.calls.filter(
            ([channel]) => channel === 'auth:profileUiDispatchFailurePending'
          ).length
        ).toBe(shouldQueue ? 1 : 0)
      }
      toString(): string {
        return 'report-shell-failure()'
      }
    }

    class AcceptDispatch implements fc.AsyncCommand<Model, Real> {
      check(model: Readonly<Model>): boolean {
        return model.started && !model.accepted
      }
      async run(model: Model, real: Real): Promise<void> {
        if (!real.acceptance) throw new Error('dispatch acceptance is unavailable')
        await real.scheduler.waitFor(real.acceptance)
        model.accepted = true
      }
      toString(): string {
        return 'accept-shell-dispatch()'
      }
    }

    class ChangeBinding implements fc.AsyncCommand<Model, Real> {
      check(model: Readonly<Model>): boolean {
        return model.started && model.bindingCurrent
      }
      async run(model: Model): Promise<void> {
        model.bindingCurrent = false
        bindingCurrent = false
      }
      toString(): string {
        return 'invalidate-captured-session-profile-binding()'
      }
    }

    class ReplaceDocument implements fc.AsyncCommand<Model, Real> {
      check(model: Readonly<Model>): boolean {
        return model.started && model.documentCurrent
      }
      async run(model: Model): Promise<void> {
        model.documentCurrent = false
        sender.mainFrame = { url: 'file:///app/replaced.html', isDestroyed: vi.fn(() => false) }
        for (const callback of [...(senderListeners.get('did-navigate') ?? [])]) callback()
      }
      toString(): string {
        return 'replace-originating-document()'
      }
    }

    class AdvancePastDeadline implements fc.AsyncCommand<Model, Real> {
      check(model: Readonly<Model>): boolean {
        return model.started && model.now <= model.deadline
      }
      async run(model: Model, real: Real): Promise<void> {
        model.now = model.deadline + 1
        real.now = model.now
        vi.spyOn(Date, 'now').mockReturnValue(real.now)
      }
      toString(): string {
        return 'advance-beyond-original-deadline()'
      }
    }

    class AuthorizeFailure implements fc.AsyncCommand<Model, Real> {
      check(model: Readonly<Model>): boolean {
        return model.started && model.accepted
      }
      async run(model: Model): Promise<void> {
        const authorize = electron.listeners.get('auth:authorizeProfileUiDispatchFailure')
        if (!authorize) throw new Error('synchronous authorization handler was not registered')
        const authorizationEvent = event()
        authorize(authorizationEvent, {
          correlationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          documentLease: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          dispatchDeadline: model.deadline,
        })
        const expected =
          model.failurePending &&
          model.bindingCurrent &&
          model.documentCurrent &&
          model.now <= model.deadline
        expect(authorizationEvent.returnValue).toBe(expected)
        model.failurePending = false
        model.delivered ||= expected
      }
      toString(): string {
        return 'authorize-correlated-failure()'
      }
    }

    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands(
          [
            fc.constant(new StartDispatch()),
            fc.constant(new ReportFailure()),
            fc.constant(new AcceptDispatch()),
            fc.constant(new ChangeBinding()),
            fc.constant(new ReplaceDocument()),
            fc.constant(new AdvancePastDeadline()),
            fc.constant(new AuthorizeFailure()),
          ],
          { maxCommands: 10 }
        ),
        async (scheduler, commands) => {
          electron.handlers.clear()
          electron.listeners.clear()
          sender.send.mockClear()
          senderListeners.clear()
          sender.isDestroyed.mockReturnValue(false)
          frame.isDestroyed.mockReturnValue(false)
          sender.mainFrame = frame
          bindingCurrent = true
          reportFailure = undefined
          service.openForgotPassword.mockClear()
          service.getProfileUiDispatchBinding.mockClear()
          service.isProfileUiDispatchBindingCurrent.mockClear()
          const model: Model = {
            started: false,
            accepted: false,
            failurePending: false,
            failureReported: false,
            bindingCurrent: true,
            documentCurrent: true,
            now: 1_000,
            deadline: 11_000,
            delivered: false,
          }
          const real: Real = { scheduler, now: model.now }
          try {
            await fc.asyncModelRun(() => ({ model, real }), commands)
            if (real.acceptance && !model.accepted) {
              await scheduler.waitFor(real.acceptance)
              model.accepted = true
            }
            if (model.failurePending) {
              const authorize = electron.listeners.get('auth:authorizeProfileUiDispatchFailure')
              if (!authorize)
                throw new Error('synchronous authorization handler was not registered')
              const authorizationEvent = event()
              authorize(authorizationEvent, {
                correlationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                documentLease: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                dispatchDeadline: model.deadline,
              })
              const expected =
                model.bindingCurrent && model.documentCurrent && model.now <= model.deadline
              expect(authorizationEvent.returnValue).toBe(expected)
              model.delivered ||= expected
            }
            await scheduler.waitAll()
            expect(
              sender.send.mock.calls.filter(
                ([channel]) => channel === 'auth:profileUiDispatchFailed'
              ).length
            ).toBe(model.delivered ? 1 : 0)
          } finally {
            real.report?.finish()
            for (const callback of [...(senderListeners.get('did-navigate') ?? [])]) callback()
            vi.restoreAllMocks()
          }
        }
      ),
      { numRuns: 60 }
    )
  })
})
