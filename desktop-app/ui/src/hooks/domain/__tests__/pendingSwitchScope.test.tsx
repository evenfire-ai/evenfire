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

it('suppresses old-team switch feedback when rejection occurs in the new render layout effect', async () => {
  const clerum = installMockClerum()
  await clerum.chat.create('agent-x', 'chat-b')
  await clerum.chat.upsertMessages('agent-x', 'chat-b', [
    { id: 'scope-history', role: 'user', content: 'persisted team-one history', timestamp: 1 },
  ])
  const seed = renderController({ loadMenuData: false })
  const { params, spies } = seed
  seed.unmount()
  const gate = deferred<void>()
  const entered = deferred<void>()
  const layout = deferred<void>()
  const error = new Error('previous-team switch rejected')
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
          gate.reject(error)
          layout.resolve()
        }
      }, [team])
      return { controller, team, setTeam }
    },
    { wrapper: ({ children }) => <AgentTaskTrackerProvider>{children}</AgentTaskTrackerProvider> }
  )
  await waitFor(() => expect(app.result.current.controller.chatListLoading).toBe(false))
  clerum.chat.setLastActive.mockImplementationOnce(async () => {
    entered.resolve()
    await gate.promise
  })
  let request!: Promise<void>
  act(() => {
    request = app.result.current.controller.switchToChat('agent-x', 'chat-b', {
      onCurrentError: failure =>
        spies.pushToast(
          `Could not open conversation: ${failure instanceof Error ? failure.message : String(failure)}`,
          'error'
        ),
    })
  })
  const observed = request.catch(failure => failure)
  await entered.promise
  rejectInLayout = true
  // Normal-priority commit: layout rejects before passive effects advance the
  // selection revision. Only render-updated scope identity can suppress feedback.
  app.result.current.setTeam('team-2')
  await layout.promise
  expect(await observed).toBe(error)
  await waitFor(() => expect(app.result.current.team).toBe('team-2'))
  expect(spies.pushToast).not.toHaveBeenCalled()
  expect(app.result.current.controller.chatMessages).toEqual([])
  expect(app.result.current.controller.chatMessagesLoading).toBe(false)
})

it('starts new scoped history instead of joining the old-team pending switch', async () => {
  const clerum = installMockClerum()
  await clerum.chat.create('agent-x', 'chat-b')
  await clerum.chat.upsertMessages('agent-x', 'chat-b', [
    { id: 'real-history', role: 'user', content: 'real chat-b history', timestamp: 1 },
  ])
  const controller = renderController({ loadMenuData: false })
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  const gate = deferred<void>()
  const entered = deferred<void>()
  const setLastActive = clerum.chat.setLastActive.getMockImplementation()!
  clerum.chat.setLastActive.mockImplementationOnce(async () => {
    entered.resolve()
    await gate.promise
  })
  clerum.chat.setLastActive.mockImplementation(setLastActive)
  let request!: Promise<void>
  act(() => {
    controller.result.current.setPendingChatSelection('agent-x', 'chat-b', { deferSwitch: true })
    request = controller.result.current.switchToChat('agent-x', 'chat-b', {
      onCurrentError: failure =>
        controller.spies.pushToast(
          `Could not open conversation: ${failure instanceof Error ? failure.message : String(failure)}`,
          'error'
        ),
    })
  })
  const observed = request.catch(error => error)
  await entered.promise
  act(() =>
    controller.rerender({
      navItem: DESKTOP_ROUTES.chat,
      currentTeamId: 'team-2',
      chatAuthorityTeamId: 'team-2',
    })
  )
  const error = new Error('old-team switch failed')
  await act(async () => {
    gate.reject(error)
    expect(await observed).toBe(error)
  })
  await waitFor(() => {
    expect(controller.result.current.chatMessagesLoading).toBe(false)
    expect(controller.result.current.activeChatId).toBe('chat-b')
    expect(controller.result.current.chatMessages).toEqual([
      expect.objectContaining({ id: 'real-history' }),
    ])
  })
  expect(controller.spies.pushToast).not.toHaveBeenCalled()
})
