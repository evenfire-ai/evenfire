import { describe, expect, it, vi } from 'vitest'
import {
  createMainWindowCoordinator,
  createRetryableInitializer,
  registerQuitDrain,
} from '../mainWindowCoordinator.js'

type TestWindow = {
  isDestroyed: () => boolean
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('main window coordinator', () => {
  it('focuses an existing live window without creating another one', async () => {
    const focusWindow = vi.fn()
    const createWindow = vi.fn(async () => undefined)
    const coordinator = createMainWindowCoordinator<TestWindow>({
      createWindow,
      focusWindow,
      getWindow: () => ({ isDestroyed: () => false }),
    })

    await coordinator.ensureWindow()

    expect(createWindow).not.toHaveBeenCalled()
    expect(focusWindow).toHaveBeenCalledOnce()
  })

  it('recreates a window after the previous window was closed', async () => {
    let currentWindow: TestWindow | null = { isDestroyed: () => true }
    const focusWindow = vi.fn()
    const createWindow = vi.fn(async () => {
      currentWindow = { isDestroyed: () => false }
    })
    const coordinator = createMainWindowCoordinator<TestWindow>({
      createWindow,
      focusWindow,
      getWindow: () => currentWindow,
    })

    await coordinator.ensureWindow()

    expect(createWindow).toHaveBeenCalledOnce()
    expect(focusWindow).toHaveBeenCalledOnce()
  })

  it('coalesces simultaneous cold-start requests into one window creation', async () => {
    let currentWindow: TestWindow | null = null
    const creation = deferred()
    const focusWindow = vi.fn()
    const createWindow = vi.fn(async () => {
      await creation.promise
      currentWindow = { isDestroyed: () => false }
    })
    const coordinator = createMainWindowCoordinator<TestWindow>({
      createWindow,
      focusWindow,
      getWindow: () => currentWindow,
    })

    const firstRequest = coordinator.ensureWindow()
    const secondRequest = coordinator.ensureWindow()
    expect(createWindow).toHaveBeenCalledOnce()

    creation.resolve()
    await Promise.all([firstRequest, secondRequest])

    expect(focusWindow).toHaveBeenCalledTimes(2)
  })

  it('retries window creation after a failed load', async () => {
    let currentWindow: TestWindow | null = null
    const createWindow = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('renderer load failed'))
      .mockImplementationOnce(async () => {
        currentWindow = { isDestroyed: () => false }
      })
    const coordinator = createMainWindowCoordinator<TestWindow>({
      createWindow,
      focusWindow: vi.fn(),
      getWindow: () => currentWindow,
    })

    await expect(coordinator.ensureWindow()).rejects.toThrow('renderer load failed')
    await expect(coordinator.ensureWindow()).resolves.toBeUndefined()
    expect(createWindow).toHaveBeenCalledTimes(2)
  })
})

describe('retryable initializer', () => {
  it('retries failures and never repeats a successful initialization', async () => {
    const initialize = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('session restore failed'))
      .mockResolvedValue(undefined)
    const initializer = createRetryableInitializer(initialize)

    await expect(initializer.ensureInitialized()).rejects.toThrow('session restore failed')
    await expect(initializer.ensureInitialized()).resolves.toBeUndefined()
    await expect(initializer.ensureInitialized()).resolves.toBeUndefined()
    expect(initialize).toHaveBeenCalledTimes(2)
  })
})

describe('quit drain registration', () => {
  const nextImmediate = () => new Promise<void>(resolve => setImmediate(resolve))

  function createAppHarness() {
    const listeners = new Map<string, (...args: any[]) => void>()
    const app = {
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        listeners.set(event, listener)
      }),
      quit: vi.fn(),
    }
    return {
      app,
      emit: (event: string, ...args: any[]) => listeners.get(event)?.(...args),
    }
  }

  it('retries quit after the before-quit event has returned', async () => {
    let beforeQuitListener: ((event: { preventDefault: () => void }) => void) | null = null
    const quitEvent = { preventDefault: vi.fn() }
    const app = {
      on: vi.fn((event: string, listener: typeof beforeQuitListener) => {
        if (event === 'before-quit') beforeQuitListener = listener
      }),
      quit: vi.fn(() => beforeQuitListener?.({ preventDefault: vi.fn() })),
    }
    const prepareForQuit = vi.fn(async () => undefined)
    registerQuitDrain(
      app as unknown as Parameters<typeof registerQuitDrain>[0],
      prepareForQuit,
      vi.fn()
    )

    beforeQuitListener?.(quitEvent)
    expect(quitEvent.preventDefault).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(app.quit).not.toHaveBeenCalled()

    await new Promise<void>(resolve => setImmediate(resolve))
    expect(app.quit).toHaveBeenCalledOnce()
    expect(prepareForQuit).toHaveBeenCalledOnce()
  })

  it('reports preparation rejection and resumes quit', async () => {
    const { app, emit } = createAppHarness()
    const failure = new Error('storage drain failed')
    const prepareForQuit = vi.fn<() => Promise<void>>().mockRejectedValue(failure)
    const reportPreparationFailure = vi.fn()
    registerQuitDrain(
      app as unknown as Parameters<typeof registerQuitDrain>[0],
      prepareForQuit,
      vi.fn(),
      reportPreparationFailure
    )

    const firstAttempt = { preventDefault: vi.fn() }
    emit('before-quit', firstAttempt)
    expect(firstAttempt.preventDefault).toHaveBeenCalledOnce()
    await Promise.resolve()
    await nextImmediate()

    expect(reportPreparationFailure).toHaveBeenCalledWith(failure)
    expect(app.quit).toHaveBeenCalledOnce()
  })

  it('reopens quit preparation after a page cancels the resumed quit', async () => {
    const { app, emit } = createAppHarness()
    const prepareForQuit = vi.fn(async () => undefined)
    const cancelQuitPreparation = vi.fn()
    registerQuitDrain(
      app as unknown as Parameters<typeof registerQuitDrain>[0],
      prepareForQuit,
      cancelQuitPreparation
    )

    const firstAttempt = { preventDefault: vi.fn() }
    emit('before-quit', firstAttempt)
    expect(firstAttempt.preventDefault).toHaveBeenCalledOnce()
    await Promise.resolve()
    await nextImmediate()
    expect(app.quit).toHaveBeenCalledOnce()

    const resumedAttempt = { preventDefault: vi.fn() }
    emit('before-quit', resumedAttempt)
    expect(resumedAttempt.preventDefault).not.toHaveBeenCalled()

    let willPreventUnload: ((event: { defaultPrevented: boolean }) => void) | undefined
    emit(
      'browser-window-created',
      {},
      {
        isDestroyed: () => false,
        webContents: {
          on: vi.fn((_event: string, listener: typeof willPreventUnload) => {
            willPreventUnload = listener
          }),
        },
      }
    )
    willPreventUnload?.({ defaultPrevented: false })
    await nextImmediate()

    expect(cancelQuitPreparation).toHaveBeenCalledOnce()

    const retryAttempt = { preventDefault: vi.fn() }
    emit('before-quit', retryAttempt)
    expect(retryAttempt.preventDefault).toHaveBeenCalledOnce()
    await Promise.resolve()
    await nextImmediate()
    expect(prepareForQuit).toHaveBeenCalledTimes(2)
  })

  it('waits for preparation on a fresh attempt after a page cancels quit', async () => {
    const { app, emit } = createAppHarness()
    const firstPreparation = deferred()
    const retryPreparation = deferred()
    const prepareForQuit = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstPreparation.promise)
      .mockImplementationOnce(() => retryPreparation.promise)
    const cancelQuitPreparation = vi.fn()
    registerQuitDrain(
      app as unknown as Parameters<typeof registerQuitDrain>[0],
      prepareForQuit,
      cancelQuitPreparation
    )

    emit('before-quit', { preventDefault: vi.fn() })
    await Promise.resolve()
    await nextImmediate()
    expect(app.quit).not.toHaveBeenCalled()
    firstPreparation.resolve()
    await Promise.resolve()
    await nextImmediate()
    expect(app.quit).toHaveBeenCalledOnce()

    let willPreventUnload: ((event: { defaultPrevented: boolean }) => void) | undefined
    emit(
      'browser-window-created',
      {},
      {
        isDestroyed: () => false,
        webContents: {
          on: vi.fn((_event: string, listener: typeof willPreventUnload) => {
            willPreventUnload = listener
          }),
        },
      }
    )
    willPreventUnload?.({ defaultPrevented: false })
    await nextImmediate()
    expect(cancelQuitPreparation).toHaveBeenCalledOnce()

    emit('before-quit', { preventDefault: vi.fn() })
    await Promise.resolve()
    expect(prepareForQuit).toHaveBeenCalledTimes(2)
    await nextImmediate()
    expect(app.quit).toHaveBeenCalledOnce()

    retryPreparation.resolve()
    await Promise.resolve()
    await nextImmediate()
    expect(app.quit).toHaveBeenCalledTimes(2)
  })

  it('reopens quit preparation when a listener prevents resumed before-quit', async () => {
    const { app, emit } = createAppHarness()
    const prepareForQuit = vi.fn(async () => undefined)
    const cancelQuitPreparation = vi.fn()
    registerQuitDrain(
      app as unknown as Parameters<typeof registerQuitDrain>[0],
      prepareForQuit,
      cancelQuitPreparation
    )

    emit('before-quit', { preventDefault: vi.fn() })
    await Promise.resolve()
    await nextImmediate()
    expect(app.quit).toHaveBeenCalledOnce()

    const resumedQuit = { defaultPrevented: false, preventDefault: vi.fn() }
    emit('before-quit', resumedQuit)
    resumedQuit.defaultPrevented = true
    await nextImmediate()
    expect(cancelQuitPreparation).toHaveBeenCalledOnce()

    const retry = { preventDefault: vi.fn() }
    emit('before-quit', retry)
    expect(retry.preventDefault).toHaveBeenCalledOnce()
    await Promise.resolve()
    await nextImmediate()
    expect(prepareForQuit).toHaveBeenCalledTimes(2)
  })

  it('reopens quit preparation when a listener prevents will-quit', async () => {
    const { app, emit } = createAppHarness()
    const prepareForQuit = vi.fn(async () => undefined)
    const cancelQuitPreparation = vi.fn()
    registerQuitDrain(
      app as unknown as Parameters<typeof registerQuitDrain>[0],
      prepareForQuit,
      cancelQuitPreparation
    )

    emit('before-quit', { preventDefault: vi.fn() })
    await Promise.resolve()
    await nextImmediate()
    expect(app.quit).toHaveBeenCalledOnce()

    const resumedQuit = { defaultPrevented: false }
    emit('will-quit', resumedQuit)
    resumedQuit.defaultPrevented = true
    await nextImmediate()
    expect(cancelQuitPreparation).toHaveBeenCalledOnce()

    const retry = { preventDefault: vi.fn() }
    emit('before-quit', retry)
    expect(retry.preventDefault).toHaveBeenCalledOnce()
    await Promise.resolve()
    await nextImmediate()
    expect(prepareForQuit).toHaveBeenCalledTimes(2)
  })

  it('keeps admission closed when resumed before-quit and will-quit are not vetoed', async () => {
    const { app, emit } = createAppHarness()
    const prepareForQuit = vi.fn(async () => undefined)
    const cancelQuitPreparation = vi.fn()
    registerQuitDrain(
      app as unknown as Parameters<typeof registerQuitDrain>[0],
      prepareForQuit,
      cancelQuitPreparation
    )

    emit('before-quit', { preventDefault: vi.fn() })
    await Promise.resolve()
    await nextImmediate()
    expect(app.quit).toHaveBeenCalledOnce()

    emit('before-quit', { defaultPrevented: false, preventDefault: vi.fn() })
    await nextImmediate()
    emit('will-quit', { defaultPrevented: false })
    await nextImmediate()

    expect(cancelQuitPreparation).not.toHaveBeenCalled()
    expect(prepareForQuit).toHaveBeenCalledOnce()
  })

  it('keeps admission closed when will-prevent-unload allows the page to unload', async () => {
    const { app, emit } = createAppHarness()
    const prepareForQuit = vi.fn(async () => undefined)
    const cancelQuitPreparation = vi.fn()
    registerQuitDrain(
      app as unknown as Parameters<typeof registerQuitDrain>[0],
      prepareForQuit,
      cancelQuitPreparation
    )

    emit('before-quit', { preventDefault: vi.fn() })
    await Promise.resolve()
    await nextImmediate()
    expect(app.quit).toHaveBeenCalledOnce()

    let willPreventUnload: ((event: { defaultPrevented: boolean }) => void) | undefined
    emit(
      'browser-window-created',
      {},
      {
        isDestroyed: () => false,
        webContents: {
          on: vi.fn((_event: string, listener: typeof willPreventUnload) => {
            willPreventUnload = listener
          }),
        },
      }
    )
    willPreventUnload?.({ defaultPrevented: true })
    await nextImmediate()

    expect(cancelQuitPreparation).not.toHaveBeenCalled()
    expect(prepareForQuit).toHaveBeenCalledOnce()
  })
})
