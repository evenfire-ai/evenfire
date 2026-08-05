import { describe, expect, it, vi } from 'vitest'
import {
  createMainWindowCoordinator,
  createRetryableInitializer,
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
