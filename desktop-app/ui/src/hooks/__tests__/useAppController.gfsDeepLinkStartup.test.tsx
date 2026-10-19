// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { buildGfsResourceDeepLink, parseGfsResourceDeepLink } from '@clerum/desktop-app-links'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { activeWorkspaceTab } from '@lib/workspaceTabs'
import {
  GfsResourceDeepLinkQueue,
  GfsUserNavigationGeneration,
} from '../../../../src/gfsResourceDeepLinkQueue'
import {
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RESOURCE_URI = 'gfs://main/0123456789abcdef0123456789abcdef'

function makeMainLinkQueue() {
  const generation = new GfsUserNavigationGeneration()
  const queue = new GfsResourceDeepLinkQueue()
  const target = parseGfsResourceDeepLink(buildGfsResourceDeepLink(RESOURCE_URI))
  if (!target) throw new Error('The shared link producer rejected the canonical fixture URI')

  return {
    generation,
    queue,
    target,
    enqueue: (activationGeneration = generation.current()) =>
      queue.enqueue(target, activationGeneration),
    connectRendererBridge(clerum: object) {
      const bridge = clerum as Record<string, unknown>
      const gfs = (bridge.gfs as Record<string, unknown> | undefined) ?? {}
      Object.assign(gfs, {
        getUserNavigationGeneration: vi.fn(() => generation.current()),
        advanceUserNavigationGeneration: vi.fn(() => generation.advance()),
      })
      bridge.gfs = gfs
    },
  }
}

describe('useAppController GFS deep-link startup', () => {
  let unmount: (() => void) | null = null

  afterEach(() => {
    unmount?.()
    unmount = null
    vi.restoreAllMocks()
    uninstallMockClerum()
  })

  it('keeps a pre-auth queued link eligible when authenticated session bootstrap focuses Chat', async () => {
    const main = makeMainLinkQueue()
    const queued = main.enqueue()
    const { clerum, handle } = installAppControllerClerum({ delayAuthenticatedLoad: true })
    main.connectRendererBridge(clerum)

    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(handle.refreshCatalog).toHaveBeenCalled())
    expect(app.result.current.isAuthenticated).toBe(true)
    expect(main.queue.list()).toEqual([queued])

    await act(async () => handle.resolveAuthenticatedLoad())
    await waitFor(() => expect(app.result.current.booting).toBe(false))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    let request: ReturnType<typeof app.result.current.beginGfsResourceNavigation> = null
    act(() => {
      request = app.result.current.beginGfsResourceNavigation(
        queued.id,
        queued.uri,
        1,
        queued.userNavigationGenerationAtActivation
      )
    })
    expect(request).not.toBeNull()
    let activated = false
    act(() => {
      activated = app.result.current.activateGfsResourceNavigation(request!, 1)
    })
    expect(activated).toBe(true)
    expect(activeWorkspaceTab(app.result.current.workspaceTabs)).toMatchObject({
      kind: 'files',
      id: request!.ownerTabId,
    })
    expect(main.generation.current()).toBe(0)
  })

  it('does not let a later completion select Files after an explicit tab action', async () => {
    const main = makeMainLinkQueue()
    const { clerum } = installAppControllerClerum()
    main.connectRendererBridge(clerum)
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.booting).toBe(false))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    const queued = main.enqueue()

    let request: ReturnType<typeof app.result.current.beginGfsResourceNavigation> = null
    act(() => {
      request = app.result.current.beginGfsResourceNavigation(
        queued.id,
        queued.uri,
        1,
        queued.userNavigationGenerationAtActivation
      )
    })
    expect(request).not.toBeNull()

    act(() => app.result.current.handleNavSelect(DESKTOP_ROUTES.settings))

    expect(app.result.current.activateGfsResourceNavigation(request!, 1)).toBe(false)
    expect(activeWorkspaceTab(app.result.current.workspaceTabs)?.kind).toBe('settings')
    expect(main.queue.list()).toEqual([queued])
  })

  it('keeps a tab selected by the user while authenticated startup is still loading', async () => {
    const main = makeMainLinkQueue()
    const queued = main.enqueue()
    const { clerum, handle } = installAppControllerClerum({ delayAuthenticatedLoad: true })
    main.connectRendererBridge(clerum)
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(handle.refreshCatalog).toHaveBeenCalled())
    act(() => app.result.current.handleNavSelect(DESKTOP_ROUTES.settings))
    await act(async () => handle.resolveAuthenticatedLoad())

    await waitFor(() => expect(app.result.current.booting).toBe(false))
    expect(activeWorkspaceTab(app.result.current.workspaceTabs)?.kind).toBe('settings')
    expect(main.generation.current()).toBe(1)
    expect(
      app.result.current.beginGfsResourceNavigation(
        queued.id,
        queued.uri,
        1,
        queued.userNavigationGenerationAtActivation
      )
    ).toBeNull()
  })

  it('preserves a queued link through signed-out boot and the later sign-in', async () => {
    const main = makeMainLinkQueue()
    const queued = main.enqueue()
    const { clerum } = installAppControllerClerum({ startAuthenticated: false })
    main.connectRendererBridge(clerum)
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.booting).toBe(false))
    expect(app.result.current.isAuthenticated).toBe(false)
    expect(main.generation.current()).toBe(0)

    act(() => {
      app.result.current.setEmail('test@clerum.io')
      app.result.current.setPassword('password')
    })
    await act(async () => app.result.current.handlePasswordLogin())
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))

    expect(main.generation.current()).toBe(0)
    const request = app.result.current.beginGfsResourceNavigation(
      queued.id,
      queued.uri,
      1,
      queued.userNavigationGenerationAtActivation
    )
    expect(request).not.toBeNull()
  })

  it('preserves main-owned pending links across renderer remount', async () => {
    const main = makeMainLinkQueue()
    const queued = main.enqueue()
    const { clerum } = installAppControllerClerum()
    main.connectRendererBridge(clerum)
    const firstMount = renderAppController()
    await waitFor(() => expect(firstMount.result.current.booting).toBe(false))
    firstMount.unmount()

    const reopened = renderAppController()
    unmount = reopened.unmount
    await waitFor(() => expect(reopened.result.current.booting).toBe(false))
    await waitFor(() => expect(reopened.result.current.initialExperienceLoading).toBe(false))

    expect(main.queue.list()).toEqual([queued])
    expect(main.generation.current()).toBe(0)
    let request: ReturnType<typeof reopened.result.current.beginGfsResourceNavigation> = null
    act(() => {
      request = reopened.result.current.beginGfsResourceNavigation(
        queued.id,
        queued.uri,
        1,
        queued.userNavigationGenerationAtActivation
      )
    })
    expect(request).not.toBeNull()
  })
})
