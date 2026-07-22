import { describe, expect, it, vi } from 'vitest'
import { createMainWindowCoordinator } from '../mainWindowCoordinator.js'

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
})
