// @vitest-environment jsdom
import { useLayoutEffect, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { useAgentChatController } from '../useAgentChatController'
import { deferred } from './__fixtures__/catalogFixtures'
import { renderController } from './__fixtures__/controllerHarness'
import { useHarnessHostAuthority } from './__fixtures__/hostAuthorityHarness'
import { installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  uninstallMockClerum()
})

it('does not restore an old-team chat when create rejects in the new render layout effect', async () => {
  const clerum = installMockClerum()
  await clerum.chat.create('agent-x', 'chat-a')
  await clerum.chat.create('agent-x', 'chat-b')
  await clerum.persistLastActive('agent-x', 'chat-a')
  clerum.chat.setLastActive.mockImplementation(clerum.persistLastActive)
  const loadMessages = clerum.chat.loadMessages.getMockImplementation()!
  const restoredHistory = deferred<void>()
  clerum.chat.loadMessages.mockImplementation(async (...args) => {
    try {
      return await loadMessages(...args)
    } finally {
      restoredHistory.resolve()
    }
  })
  expect((await clerum.readIndex('agent-x')).lastActiveChatId).toBe('chat-a')
  await clerum.chat.upsertMessages('agent-x', 'chat-b', [
    { id: 'old-team-history', role: 'user', content: 'team-one history', timestamp: 1 },
  ])
  const seed = renderController({ loadMenuData: false })
  const params = seed.params
  seed.unmount()
  const create = deferred<Awaited<ReturnType<typeof clerum.chat.create>>>()
  const layout = deferred<void>()
  const rejected = deferred<unknown>()
  const createError = new Error('old-team create failed')
  let rejectInLayout = false
  const app = renderHook(
    () => {
      const [team, setTeam] = useState('team-1')
      const authority = useHarnessHostAuthority()
      const controller = useAgentChatController({
        ...params,
        currentTeamId: team,
        chatAuthorityTeamId: team,
        isHostAccessBlocked: authority.isHostAccessBlocked,
        getHostAuthorityEpoch: authority.getHostAuthorityEpoch,
        hostAuthorityRevision: authority.revision,
        onHostAccessRevoked: authority.onHostAccessRevoked,
        onHostAuthorityUncertain: authority.onHostAuthorityUncertain,
      } as Parameters<typeof useAgentChatController>[0])
      useLayoutEffect(() => {
        if (team === 'team-2' && rejectInLayout) {
          create.reject(createError)
          layout.resolve()
        }
      }, [team])
      return { controller, team, setTeam }
    },
    { wrapper: ({ children }) => <AgentTaskTrackerProvider>{children}</AgentTaskTrackerProvider> }
  )
  await waitFor(() => expect(app.result.current.controller.chatListLoading).toBe(false))
  act(() =>
    app.result.current.controller.setPendingChatSelection('agent-x', 'chat-b', {
      deferSwitch: true,
    })
  )
  // Pending-specific is produced by the real route transition; create captures
  // that unconsumed selection and would restore it unless scope rejects it.
  clerum.chat.create.mockReturnValueOnce(create.promise)
  act(() => {
    void app.result.current.controller.handleCreateChat().catch(error => rejected.resolve(error))
  })
  clerum.chat.setLastActive.mockClear()
  rejectInLayout = true
  // Deliberately NOT act/rerender/flushSync: normal-priority state commits, then
  // its layout effect rejects before passive scope-generation invalidation.
  app.result.current.setTeam('team-2')
  await layout.promise
  expect(await rejected.promise).toBe(createError)
  await waitFor(() => expect(app.result.current.team).toBe('team-2'))
  try {
    expect((await clerum.readIndex('agent-x')).lastActiveChatId).toBe('chat-a')
    expect(clerum.chat.setLastActive).not.toHaveBeenCalled()
    expect(app.result.current.controller.activeChatId).toBeNull()
    expect(app.result.current.controller.chatMessages).toEqual([])
    expect(app.result.current.controller.chatMessagesLoading).toBe(false)
    expect(params.navItem).toBe(DESKTOP_ROUTES.agents)
  } finally {
    // A guard-removal run can launch real restore I/O; let that producer finish
    // before afterEach removes the bridge, preserving behavioral failure proof.
    if (clerum.chat.setLastActive.mock.calls.length) {
      await act(async () => await restoredHistory.promise)
    }
  }
})
