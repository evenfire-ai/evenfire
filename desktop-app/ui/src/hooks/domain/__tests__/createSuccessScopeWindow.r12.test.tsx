// @vitest-environment jsdom
import { useLayoutEffect, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ChatMetadata } from '../../../../../src/types'
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

it('does not open or publish an old-team successful create delivered in the new render layout effect', async () => {
  const clerum = installMockClerum()
  await clerum.chat.create('agent-x', 'chat-a')
  clerum.chat.getIndex.mockImplementation(clerum.readIndex)
  await clerum.persistLastActive('agent-x', 'chat-a')
  clerum.chat.setLastActive.mockImplementation(clerum.persistLastActive)
  expect((await clerum.readIndex('agent-x')).lastActiveChatId).toBe('chat-a')
  const seed = renderController({ loadMenuData: false })
  const { params, spies } = seed
  seed.unmount()

  const produced = deferred<ChatMetadata>()
  const delivered = deferred<ChatMetadata>()
  const layout = deferred<void>()
  let metadata: ChatMetadata | null = null
  let resolveInLayout = false
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
        if (team === 'team-2' && resolveInLayout && metadata) {
          delivered.resolve(metadata)
          layout.resolve()
        }
      }, [team])
      return { controller, team, setTeam }
    },
    { wrapper: ({ children }) => <AgentTaskTrackerProvider>{children}</AgentTaskTrackerProvider> }
  )
  await waitFor(() => expect(app.result.current.controller.chatListLoading).toBe(false))
  expect(app.result.current.controller.chatList.map(chat => chat.id)).toEqual(['chat-a'])
  const createProducer = clerum.chat.create.getMockImplementation()!
  clerum.chat.create.mockImplementationOnce(async (agentRef, chatId) => {
    const created = await createProducer(agentRef, chatId)
    produced.resolve(created)
    return delivered.promise
  })
  let request!: Promise<void>
  act(() => {
    request = app.result.current.controller.handleCreateChat()
  })
  metadata = await produced.promise
  await clerum.chat.upsertMessages('agent-x', metadata.id, [
    {
      id: 'old-team-created-history',
      role: 'user',
      content: 'old team created history',
      timestamp: 1,
    },
  ])
  expect((await clerum.readIndex('agent-x')).chats.some(chat => chat.id === metadata?.id)).toBe(
    true
  )
  resolveInLayout = true
  const nextCatalog = deferred<Awaited<ReturnType<typeof clerum.readIndex>>>()
  // Production binds storage by environment/user, NOT by team. Hold the next
  // real index to distinguish early create publication from authorized reload.
  clerum.chat.getIndex.mockReturnValueOnce(nextCatalog.promise)
  // Normal-priority state commits: layout delivers real already-persisted create
  // metadata before passive effects invalidate the old request generation.
  app.result.current.setTeam('team-2')
  await layout.promise
  await expect(request).resolves.toBeUndefined()
  await waitFor(() => expect(app.result.current.team).toBe('team-2'))

  expect((await clerum.readIndex('agent-x')).lastActiveChatId).toBe('chat-a')
  expect(clerum.chat.setLastActive).not.toHaveBeenCalled()
  expect(app.result.current.controller.chatList.some(chat => chat.id === metadata?.id)).toBe(false)
  expect(app.result.current.controller.activeChatId).toBeNull()
  expect(app.result.current.controller.chatMessages).toEqual([])
  expect(app.result.current.controller.chatMessagesLoading).toBe(false)
  expect(spies.pushToast).not.toHaveBeenCalled()
  await act(async () => {
    nextCatalog.resolve(await clerum.readIndex('agent-x'))
  })
  await waitFor(() => expect(app.result.current.controller.chatListLoading).toBe(false))
  expect(app.result.current.controller.chatList.map(chat => chat.id).sort()).toEqual(
    ['chat-a', metadata.id].sort()
  )
  expect((await clerum.readIndex('agent-x')).chats.map(chat => chat.id).sort()).toEqual(
    ['chat-a', metadata.id].sort()
  )
})
