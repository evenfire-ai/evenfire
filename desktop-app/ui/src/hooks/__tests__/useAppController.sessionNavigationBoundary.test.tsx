// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { activeWorkspaceTab } from '@lib/workspaceTabs'
import {
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const userA = {
  id: 'user-a',
  email: 'a@example.test',
  name: 'User A',
  teamId: 'team-a',
  teamName: 'Team A',
}
const userB = {
  id: 'user-b',
  email: 'b@example.test',
  name: 'User B',
  teamId: 'team-b',
  teamName: 'Team B',
}

describe('useAppController session navigation boundary', () => {
  let unmount: (() => void) | null = null

  afterEach(() => {
    unmount?.()
    unmount = null
    vi.restoreAllMocks()
    uninstallMockClerum()
  })

  it('discards A navigation and selected agent before B signs in', async () => {
    let session: { authenticated: boolean; me: typeof userA | typeof userB | null } = {
      authenticated: true,
      me: userA,
    }
    const { handle } = installAppControllerClerum({ agentNames: ['agent-x'] })
    handle.getSessionState.mockImplementation(async () => session)
    handle.logout.mockImplementation(async () => {
      session = { authenticated: false, me: null }
      return { ok: true, sessionGeneration: 2 }
    })
    handle.passwordLogin.mockImplementation(async () => {
      session = { authenticated: true, me: userB }
      return { authenticated: true, me: userB }
    })

    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.booting).toBe(false))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    act(() => {
      app.result.current.setSelectedAgent('agent-x')
      app.result.current.handleNavSelect(DESKTOP_ROUTES.settings)
      app.result.current.openFilesSection('gfs://main/0123456789abcdef0123456789abcdef')
      app.result.current.handleNavSelect(DESKTOP_ROUTES.settings)
    })
    expect(app.result.current.selectedAgent).toBe('agent-x')
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.settings)

    await act(async () => app.result.current.handleLogout())
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(false))

    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.chat)
    expect(app.result.current.selectedAgent).toBeNull()
    expect(app.result.current.workspaceTabs.tabs).toHaveLength(1)
    expect(activeWorkspaceTab(app.result.current.workspaceTabs)).toMatchObject({
      kind: 'chat',
      chat: { agentRef: null, chatId: null },
    })
    expect(
      app.result.current.workspaceTabs.tabs.some(
        tab => tab.kind === 'files' && tab.files?.path !== null
      )
    ).toBe(false)

    act(() => {
      app.result.current.setEmail(userB.email)
      app.result.current.setPassword('test-password')
    })
    await act(async () => app.result.current.handlePasswordLogin())
    await waitFor(() => expect(app.result.current.me?.id).toBe(userB.id))

    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.chat)
    expect(app.result.current.selectedAgent).toBeNull()
    expect(app.result.current.workspaceTabs.tabs).toHaveLength(1)
  })

  it('resets a direct principal change before refresh and keeps a later user selection', async () => {
    let session = { authenticated: true, me: userA as typeof userA | typeof userB }
    const { handle } = installAppControllerClerum({ agentNames: ['agent-x'] })
    handle.getSessionState.mockImplementation(async () => session)
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.booting).toBe(false))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    act(() => {
      app.result.current.setSelectedAgent('agent-x')
      app.result.current.handleNavSelect(DESKTOP_ROUTES.settings)
    })
    session = { authenticated: true, me: userB }
    let resolveCatalog!: (value: {
      userId: string
      teamId: string
      agentNames: string[]
      userAgentNames: string[]
      teamAgentNames: string[]
      mcpServersByAgent: Record<string, unknown>
      agentContextByName: Record<string, unknown>
      agentProviderByName: Record<string, unknown>
      contextIds: string[]
      userContextIds: string[]
      teamContextIds: string[]
    }) => void
    handle.refreshCatalog.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveCatalog = resolve
        })
    )
    const catalogForB = {
      userId: userB.id,
      teamId: userB.teamId,
      agentNames: ['agent-x'],
      userAgentNames: ['agent-x'],
      teamAgentNames: [],
      mcpServersByAgent: {},
      agentContextByName: {},
      agentProviderByName: {},
      contextIds: [],
      userContextIds: [],
      teamContextIds: [],
    }

    act(() => {
      app.result.current.setEmail(userB.email)
      app.result.current.setPassword('test-password')
    })
    let login: Promise<void> | undefined
    act(() => {
      login = app.result.current.handlePasswordLogin()
    })
    await waitFor(() => expect(handle.passwordLogin).toHaveBeenCalled())
    await waitFor(() => expect(app.result.current.me?.id).toBe(userB.id))
    await waitFor(() => expect(resolveCatalog).toBeTypeOf('function'))

    act(() => app.result.current.handleNavSelect(DESKTOP_ROUTES.files))
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files)

    await act(async () => {
      resolveCatalog(catalogForB)
      await login
    })
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files)
    expect(app.result.current.selectedAgent).toBeNull()
    expect(app.result.current.workspaceTabs.tabs).toHaveLength(2)
  })
})
