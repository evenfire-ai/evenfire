// @vitest-environment jsdom
/**
 * #1091 A9 — reopening a chat renders its remembered transcript at once. History
 * is still read only after the last-active write (#976), and the remembered
 * transcript is withdrawn if that write fails or the Host is held meanwhile.
 * The disk check and the Host reconcile still run, but the list is not cleared
 * behind a spinner while they do. Every case runs for a stateful
 * and a stateless Host: the renderer has no branch by Host kind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { act, cleanup, waitFor } from '@testing-library/react'
import { resetComposerDraftStore } from '@lib/composerDraftStore'
import type { AgentChatMessage } from '../../../uiTypes'
import { deferred } from './__fixtures__/catalogFixtures'
import { type RenderControllerResult, renderController } from './__fixtures__/controllerHarness'
import { ipcGenericForbidden, ipcHostAccessRevoked, ipcHttpError } from './__fixtures__/ipcErrors'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HOSTS = ['chatllm', 'chatllm-stateless'] as const

let clerum: MockClerum
type SessionResult = Awaited<ReturnType<typeof clerum.rpc.loadSessionMessages>>

interface Frame {
  activeChatId: string | null
  contents: string[]
  loading: boolean
}

let frames: Frame[] = []

beforeEach(() => {
  frames = []
  clerum = installMockClerum()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetComposerDraftStore()
  uninstallMockClerum()
})

function transcript(chatId: string, count = 2): AgentChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${chatId}-${index + 1}`,
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `${chatId} message ${index + 1}`,
    timestamp: index + 1,
  }))
}

const contentsOf = (messages: AgentChatMessage[]) => messages.map(message => message.content)

const turn = (n: number, user: string, response?: string) => ({
  number: n,
  user_input: user,
  response,
  started_at: `2026-05-28T10:0${n}:00Z`,
  completed_at: response ? `2026-05-28T10:0${n}:05Z` : undefined,
})

/** The disk cache, paged from the newest message like `ChatStore.loadMessages`. */
function serveDisk(disk: Record<string, AgentChatMessage[]>) {
  clerum.chat.loadMessages.mockImplementation(
    async (_agentRef: string, chatId: string, limit = 80, offset = 0) => {
      const messages = disk[chatId] ?? []
      const end = Math.max(0, messages.length - offset)
      return messages.slice(Math.max(0, end - limit), end)
    }
  )
}

function mount(
  host: string,
  overrides: Parameters<typeof renderController>[0] = {}
): RenderControllerResult {
  return renderController(
    { selectedAgent: host, agentNames: [host], ...overrides },
    {
      onRender: value =>
        frames.push({
          activeChatId: value.activeChatId,
          contents: contentsOf(value.chatMessages),
          loading: value.chatMessagesLoading,
        }),
    }
  )
}

async function settleMount() {
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
}

async function open(controller: RenderControllerResult, host: string, chatId: string) {
  await act(async () => {
    await controller.result.current.switchToChat(host, chatId)
  })
}

/** Every frame that shows `chatId` shows `messages`, settled. At least one frame must. */
function expectOnlyTranscript(observed: Frame[], chatId: string, messages: AgentChatMessage[]) {
  const shown = observed.filter(frame => frame.activeChatId === chatId)
  expect(shown.length).toBeGreaterThan(0)
  for (const frame of shown) {
    expect(frame).toEqual({ activeChatId: chatId, contents: contentsOf(messages), loading: false })
  }
}

const blankFrame = (observed: Frame[], chatId: string) =>
  observed.some(
    frame => frame.activeChatId === chatId && frame.contents.length === 0 && frame.loading
  )

const lastHostReadChatId = () => clerum.rpc.loadSessionMessages.mock.calls.at(-1)?.[2]

describe('switchToChat transcript memo (#1091 A9)', () => {
  it.each(HOSTS)(
    'a. %s: reopening a chat shows its transcript while the disk and Host reads are pending',
    async host => {
      const disk = { 'chat-a': transcript('chat-a'), 'chat-b': transcript('chat-b') }
      serveDisk(disk)
      const controller = mount(host)
      await settleMount()
      await open(controller, host, 'chat-a')
      const chatBRead = deferred<AgentChatMessage[]>()
      clerum.chat.loadMessages.mockImplementationOnce(() => chatBRead.promise)
      const firstB = frames.length
      let toB!: Promise<void>
      await act(async () => {
        toB = controller.result.current.switchToChat(host, 'chat-b')
      })
      // Witness: a chat that is not remembered still opens blank behind the spinner.
      expect(blankFrame(frames.slice(firstB), 'chat-b')).toBe(true)
      await act(async () => {
        chatBRead.resolve(disk['chat-b'])
        await toB
      })

      const diskRead = deferred<AgentChatMessage[]>()
      const hostRead = deferred<SessionResult>()
      clerum.chat.loadMessages.mockImplementationOnce(() => diskRead.promise)
      clerum.rpc.loadSessionMessages.mockImplementationOnce(() => hostRead.promise)
      const reopenStart = frames.length
      let reopen!: Promise<void>
      await act(async () => {
        reopen = controller.result.current.switchToChat(host, 'chat-a')
      })
      expect(clerum.chat.loadMessages).toHaveBeenLastCalledWith(host, 'chat-a', 80, undefined)
      expectOnlyTranscript(frames.slice(reopenStart), 'chat-a', disk['chat-a'])

      await act(async () => {
        diskRead.resolve(disk['chat-a'])
      })
      await waitFor(() => expect(lastHostReadChatId()).toBe('chat-a'))
      // The Host read (a wake on a suspended stateless Host) is still pending.
      expectOnlyTranscript(frames.slice(reopenStart), 'chat-a', disk['chat-a'])

      await act(async () => {
        hostRead.resolve({ agent: host, chatId: 'chat-a', state: 'idle', turns: [] })
        await reopen
      })
      expectOnlyTranscript(frames.slice(reopenStart), 'chat-a', disk['chat-a'])
    }
  )

  it.each(HOSTS)(
    'b. %s: a reply persisted while the chat was hidden replaces the remembered transcript',
    async host => {
      const disk = { 'chat-a': transcript('chat-a'), 'chat-b': transcript('chat-b') }
      serveDisk(disk)
      const controller = mount(host)
      await settleMount()
      await open(controller, host, 'chat-a')
      await open(controller, host, 'chat-b')
      const remembered = disk['chat-a']
      disk['chat-a'] = transcript('chat-a', 3)

      const diskRead = deferred<AgentChatMessage[]>()
      clerum.chat.loadMessages.mockImplementationOnce(() => diskRead.promise)
      const reopenStart = frames.length
      let reopen!: Promise<void>
      await act(async () => {
        reopen = controller.result.current.switchToChat(host, 'chat-a')
      })
      expectOnlyTranscript(frames.slice(reopenStart), 'chat-a', remembered)

      await act(async () => {
        diskRead.resolve(disk['chat-a'])
        await reopen
      })
      expect(contentsOf(controller.result.current.chatMessages)).toEqual(contentsOf(disk['chat-a']))
      expect(blankFrame(frames.slice(reopenStart), 'chat-a')).toBe(false)
    }
  )

  it.each(HOSTS)(
    'b3. %s: a full disk page of the same length but shifted by a new reply replaces the remembered transcript',
    async host => {
      const disk = { 'chat-a': transcript('chat-a', 80), 'chat-b': transcript('chat-b') }
      serveDisk(disk)
      const controller = mount(host)
      await settleMount()
      await open(controller, host, 'chat-a')
      await open(controller, host, 'chat-b')
      const remembered = disk['chat-a']
      // One reply persisted while A was hidden: the newest page keeps its
      // length (80) but starts one message later.
      disk['chat-a'] = transcript('chat-a', 81)
      const shiftedPage = disk['chat-a'].slice(-80)
      expect(shiftedPage).toHaveLength(remembered.length)

      const diskRead = deferred<AgentChatMessage[]>()
      clerum.chat.loadMessages.mockImplementationOnce(() => diskRead.promise)
      const reopenStart = frames.length
      let reopen!: Promise<void>
      await act(async () => {
        reopen = controller.result.current.switchToChat(host, 'chat-a')
      })
      // Witness: the reopen painted the remembered transcript first.
      expectOnlyTranscript(frames.slice(reopenStart), 'chat-a', remembered)

      await act(async () => {
        diskRead.resolve(shiftedPage)
        await reopen
      })
      expect(contentsOf(controller.result.current.chatMessages)).toEqual(contentsOf(shiftedPage))
    }
  )

  it.each(HOSTS)(
    'b2. %s: an empty disk page (a tombstone this session has not loaded) drops the remembered transcript',
    async host => {
      const disk = { 'chat-a': transcript('chat-a'), 'chat-b': transcript('chat-b') }
      serveDisk(disk)
      const controller = mount(host)
      await settleMount()
      await open(controller, host, 'chat-a')
      await open(controller, host, 'chat-b')
      // `ChatStore.loadMessages` returns [] once the index carries a tombstone
      // for the chat; the renderer's deleted-chat set has not been refreshed.
      disk['chat-a'] = []

      const diskRead = deferred<AgentChatMessage[]>()
      clerum.chat.loadMessages.mockImplementationOnce(() => diskRead.promise)
      const reopenStart = frames.length
      let reopen!: Promise<void>
      await act(async () => {
        reopen = controller.result.current.switchToChat(host, 'chat-a')
      })
      // Witnesses: the reopen was a memo hit and it read the disk page.
      expectOnlyTranscript(frames.slice(reopenStart), 'chat-a', transcript('chat-a'))
      expect(clerum.chat.loadMessages).toHaveBeenLastCalledWith(host, 'chat-a', 80, undefined)
      await act(async () => {
        diskRead.resolve([])
        await reopen
      })
      expect(controller.result.current.chatMessages).toEqual([])

      await open(controller, host, 'chat-b')
      const againStart = frames.length
      const chatARead = deferred<AgentChatMessage[]>()
      clerum.chat.loadMessages.mockImplementationOnce(() => chatARead.promise)
      let again!: Promise<void>
      await act(async () => {
        again = controller.result.current.switchToChat(host, 'chat-a')
      })
      // The entry is gone: the next open is blank behind the spinner, not remembered.
      expect(blankFrame(frames.slice(againStart), 'chat-a')).toBe(true)
      await act(async () => {
        chatARead.resolve([])
        await again
      })
    }
  )

  it.each(HOSTS)(
    'b4. %s: a failed disk read keeps the remembered transcript instead of treating it as a tombstone',
    async host => {
      const disk = { 'chat-a': transcript('chat-a'), 'chat-b': transcript('chat-b') }
      serveDisk(disk)
      const controller = mount(host)
      await settleMount()
      await open(controller, host, 'chat-a')
      await open(controller, host, 'chat-b')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const newestPageReads = () =>
        clerum.chat.loadMessages.mock.calls.filter(
          ([, chatId, limit, offset]) => chatId === 'chat-a' && limit === 80 && offset === undefined
        ).length
      const readsBefore = newestPageReads()
      clerum.chat.loadMessages.mockImplementationOnce(() =>
        Promise.reject(new Error('EIO: newest chat page unreadable'))
      )

      const reopenStart = frames.length
      await open(controller, host, 'chat-a')
      // Witnesses: the reopen read the newest disk page and that read failed.
      expect(newestPageReads()).toBeGreaterThan(readsBefore)
      expect(warn).toHaveBeenCalledWith(
        '[chat-history] failed to load local messages',
        expect.objectContaining({ agentRef: host, chatId: 'chat-a' })
      )
      expectOnlyTranscript(frames.slice(reopenStart), 'chat-a', disk['chat-a'])

      // The entry survived the failed read: the next reopen is still remembered.
      await open(controller, host, 'chat-b')
      const chatARead = deferred<AgentChatMessage[]>()
      clerum.chat.loadMessages.mockImplementationOnce(() => chatARead.promise)
      const againStart = frames.length
      let again!: Promise<void>
      await act(async () => {
        again = controller.result.current.switchToChat(host, 'chat-a')
      })
      expectOnlyTranscript(frames.slice(againStart), 'chat-a', disk['chat-a'])
      await act(async () => {
        chatARead.resolve(disk['chat-a'])
        await again
      })
    }
  )

  it.each(HOSTS)(
    'c. %s: when the disk page matches, the remembered list and paging offset are kept',
    async host => {
      const disk = { 'chat-a': transcript('chat-a', 81), 'chat-b': transcript('chat-b') }
      serveDisk(disk)
      const controller = mount(host)
      await settleMount()
      await open(controller, host, 'chat-a')
      const shown = controller.result.current.chatMessages
      expect(shown).toHaveLength(80)
      expect(controller.result.current.hasOlderMessages).toBe(true)
      await open(controller, host, 'chat-b')

      await open(controller, host, 'chat-a')
      expect(controller.result.current.chatMessages).toBe(shown)
      expect(controller.result.current.hasOlderMessages).toBe(true)
      // The probe for older local messages ran on the first open only.
      const olderProbes = clerum.chat.loadMessages.mock.calls.filter(
        ([, chatId, limit, offset]) => chatId === 'chat-a' && limit === 1 && offset === 80
      )
      expect(olderProbes).toHaveLength(1)

      await act(async () => {
        await controller.result.current.handleLoadOlderMessages()
      })
      expect(clerum.chat.loadMessages).toHaveBeenLastCalledWith(host, 'chat-a', 80, 80)
      expect(contentsOf(controller.result.current.chatMessages)).toEqual(contentsOf(disk['chat-a']))
    }
  )

  it.each(HOSTS)(
    'd. %s: a reopen from memory still re-fetches the newest turn and shows its completed answer',
    async host => {
      const question = {
        id: 'turn-1-user',
        role: 'user' as const,
        content: 'q',
        timestamp: 1,
        serverTurnNumber: 1,
      }
      serveDisk({ 'chat-a': [question], 'chat-b': transcript('chat-b') })
      let chatAReads = 0
      clerum.rpc.loadSessionMessages.mockImplementation(
        async (_hostRef: string, _agent: string, chatId: string) => {
          if (chatId !== 'chat-a') return { agent: host, chatId, state: 'idle', turns: [] }
          chatAReads += 1
          return {
            agent: host,
            chatId,
            state: 'idle',
            totalTurns: 1,
            turns: [chatAReads === 1 ? turn(1, 'q') : turn(1, 'q', 'completed answer')],
          }
        }
      )
      const controller = mount(host)
      await settleMount()
      await open(controller, host, 'chat-a')
      expect(contentsOf(controller.result.current.chatMessages)).toEqual(['q'])
      await open(controller, host, 'chat-b')

      const reopenStart = frames.length
      await open(controller, host, 'chat-a')
      expect(chatAReads).toBe(2)
      expect(clerum.rpc.loadSessionMessages).toHaveBeenLastCalledWith(
        host,
        host,
        'chat-a',
        undefined,
        { limit: 40, afterTurn: 0 }
      )
      expect(contentsOf(controller.result.current.chatMessages)).toEqual(['q', 'completed answer'])
      expect(blankFrame(frames.slice(reopenStart), 'chat-a')).toBe(false)
    }
  )

  const invalidations = [
    ['no invalidating event (control), reopening is served from memory', 'none', false],
    ['a team change, reopening opens blank', 'team', true],
    ['an environment change and restore, reopening opens blank', 'env', true],
    [
      'a rerender with the same environment (control), reopening is served from memory',
      'env-same',
      false,
    ],
    ['a logout and login, reopening opens blank', 'logout', true],
    ['resetChat, reopening opens blank', 'reset', true],
    ['a confirmed revocation of the Host, reopening opens blank', 'revoked', true],
    ['an uncertain hold of the Host, reopening opens blank', 'uncertain', true],
  ] as const
  describe.each(HOSTS)('e. %s', host => {
    it.each(invalidations)('after %s', async (_label, event, expectBlank) => {
      const disk = { 'chat-a': transcript('chat-a'), 'chat-b': transcript('chat-b') }
      serveDisk(disk)
      const controller = mount(host)
      await settleMount()
      await open(controller, host, 'chat-a')
      if (event === 'revoked' || event === 'uncertain') {
        const denial =
          event === 'revoked'
            ? await ipcHostAccessRevoked('rpc:loadSessionMessages')
            : await ipcGenericForbidden('rpc:loadSessionMessages')
        clerum.rpc.loadSessionMessages.mockImplementationOnce(async () => {
          throw denial
        })
      }
      await open(controller, host, 'chat-b')
      if (event === 'team') {
        act(() => controller.rerender({ currentTeamId: 'team-2', chatAuthorityTeamId: 'team-2' }))
        act(() => controller.rerender({ currentTeamId: 'team-1', chatAuthorityTeamId: 'team-1' }))
      } else if (event === 'env') {
        act(() => controller.rerender({ currentEnvironmentKey: 'env-other' }))
        act(() => controller.rerender({ currentEnvironmentKey: 'env-test' }))
      } else if (event === 'env-same') {
        act(() => controller.rerender({ currentEnvironmentKey: 'env-test' }))
      } else if (event === 'logout') {
        act(() => controller.rerender({ isAuthenticated: false }))
        act(() => controller.rerender({ isAuthenticated: true }))
      } else if (event === 'reset') {
        act(() => controller.result.current.resetChat())
      } else if (event === 'revoked' || event === 'uncertain') {
        // Witness: the denial reached the Host authority.
        expect(controller.hostAuthority.isBlocked(host)).toBe(true)
        controller.hostAuthority.release(host)
        expect(controller.hostAuthority.isBlocked(host)).toBe(false)
      }

      const diskRead = deferred<AgentChatMessage[]>()
      clerum.chat.loadMessages.mockImplementationOnce(() => diskRead.promise)
      const reopenStart = frames.length
      let reopen!: Promise<void>
      await act(async () => {
        reopen = controller.result.current.switchToChat(host, 'chat-a')
      })
      expect(clerum.chat.loadMessages).toHaveBeenLastCalledWith(host, 'chat-a', 80, undefined)
      expect(blankFrame(frames.slice(reopenStart), 'chat-a')).toBe(expectBlank)
      await act(async () => {
        diskRead.resolve(disk['chat-a'])
        await reopen
      })
      expect(contentsOf(controller.result.current.chatMessages)).toEqual(contentsOf(disk['chat-a']))
    })
  })

  it.each(HOSTS)(
    "f. %s: returning to A before B's disk read resolves keeps A on screen",
    async host => {
      const disk = { 'chat-a': transcript('chat-a'), 'chat-b': transcript('chat-b') }
      serveDisk(disk)
      const controller = mount(host)
      await settleMount()
      await open(controller, host, 'chat-a')

      const chatBRead = deferred<AgentChatMessage[]>()
      clerum.chat.loadMessages.mockImplementationOnce(() => chatBRead.promise)
      let toB!: Promise<void>
      await act(async () => {
        toB = controller.result.current.switchToChat(host, 'chat-b')
      })
      expect(clerum.chat.loadMessages).toHaveBeenLastCalledWith(host, 'chat-b', 80, undefined)
      const chatARead = deferred<AgentChatMessage[]>()
      clerum.chat.loadMessages.mockImplementationOnce(() => chatARead.promise)
      const backToA = frames.length
      let toA!: Promise<void>
      await act(async () => {
        toA = controller.result.current.switchToChat(host, 'chat-a')
      })
      expectOnlyTranscript(frames.slice(backToA), 'chat-a', disk['chat-a'])

      let chatBSettled = false
      await act(async () => {
        chatBRead.resolve(disk['chat-b'])
        await toB.then(() => {
          chatBSettled = true
        })
      })
      // Witness: B's late read did resolve while A was visible.
      expect(chatBSettled).toBe(true)
      expectOnlyTranscript(frames.slice(backToA), 'chat-a', disk['chat-a'])
      await act(async () => {
        chatARead.resolve(disk['chat-a'])
        await toA
      })
      expect(controller.result.current.activeChatId).toBe('chat-a')
      expectOnlyTranscript(frames.slice(backToA), 'chat-a', disk['chat-a'])
    }
  )

  it.each(HOSTS)(
    'i. %s: a transcript that changes during an uncertain hold is not remembered after release',
    async host => {
      const otherHost = 'other-host'
      const disk = { 'chat-a': transcript('chat-a', 81), 'chat-b': transcript('chat-b') }
      serveDisk(disk)
      const controller = mount(host, { agentNames: [host, otherHost] })
      await settleMount()
      await open(controller, host, 'chat-a')
      await open(controller, host, 'chat-b')
      const denial = await ipcGenericForbidden('rpc:loadSessionMessages')
      clerum.rpc.loadSessionMessages.mockImplementationOnce(async () => {
        throw denial
      })
      await open(controller, host, 'chat-a')
      // Witness: the reconcile's denial put the Host on an uncertain hold with A visible.
      expect(controller.hostAuthority.isBlocked(host)).toBe(true)
      expect(controller.result.current.activeChatId).toBe('chat-a')
      expect(controller.result.current.chatMessages).toHaveLength(80)

      // The user pages older messages while the Host is held.
      await act(async () => {
        await controller.result.current.handleLoadOlderMessages()
      })
      expect(controller.result.current.chatMessages).toHaveLength(81)

      act(() => controller.rerender({ selectedAgent: otherHost, agentNames: [host, otherHost] }))
      await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalledWith(otherHost))
      controller.hostAuthority.release(host)
      expect(controller.hostAuthority.isBlocked(host)).toBe(false)
      // The other Host opens a chat, as the chat route does on selection.
      await open(controller, otherHost, 'chat-o')

      const diskRead = deferred<AgentChatMessage[]>()
      clerum.chat.loadMessages.mockImplementationOnce(() => diskRead.promise)
      const returnStart = frames.length
      act(() => controller.result.current.setPendingChatSelection(host, 'chat-a'))
      act(() => controller.rerender({ selectedAgent: host, agentNames: [host, otherHost] }))
      // Witness: the reopen after release reads the disk page.
      await waitFor(() =>
        expect(clerum.chat.loadMessages).toHaveBeenLastCalledWith(host, 'chat-a', 80, undefined)
      )
      expect(blankFrame(frames.slice(returnStart), 'chat-a')).toBe(true)
      await act(async () => {
        diskRead.resolve(disk['chat-a'].slice(-80))
      })
      await waitFor(() => expect(controller.result.current.chatMessages).toHaveLength(80))
    }
  )

  it.each(HOSTS)(
    '%s: a failed reconcile while the Host wakes keeps the remembered transcript and holds nothing',
    async host => {
      const disk = { 'chat-a': transcript('chat-a'), 'chat-b': transcript('chat-b') }
      serveDisk(disk)
      const onHostAccessRevoked = vi.fn()
      const onHostAuthorityUncertain = vi.fn()
      const controller = mount(host, {
        onHostAccessRevoked,
        onHostAuthorityUncertain,
        isHostAccessBlocked: () => false,
      })
      await settleMount()
      await open(controller, host, 'chat-a')

      const unavailable = await ipcHttpError(
        'rpc:loadSessionMessages',
        503,
        'Service Unavailable',
        {
          code: 'host_waking',
        }
      )
      const notFound = await ipcHttpError('rpc:loadSessionMessages', 404, 'Not Found', {
        error: 'not found',
      })
      const chatAReads = () =>
        clerum.rpc.loadSessionMessages.mock.calls.filter(call => call[2] === 'chat-a').length
      for (const failure of [unavailable, notFound]) {
        await open(controller, host, 'chat-b')
        const readsBefore = chatAReads()
        // Every read of A fails while the Host wakes, including the reconcile's retries.
        clerum.rpc.loadSessionMessages.mockImplementation(
          async (_hostRef: string, _agent: string, chatId: string) => {
            if (chatId === 'chat-a') throw failure
            return { agent: host, chatId, state: 'idle', turns: [] }
          }
        )
        const reopenStart = frames.length
        await open(controller, host, 'chat-a')
        // Witness: the reconcile did reach the Host and fail.
        expect(chatAReads()).toBeGreaterThan(readsBefore)
        expectOnlyTranscript(frames.slice(reopenStart), 'chat-a', disk['chat-a'])
      }
      await waitFor(() =>
        expect(
          controller.result.current.sessionFsmStore.getState(makeTaskKey(host, 'chat-a'))?.phase
        ).toBe('offline')
      )
      expect(onHostAccessRevoked).not.toHaveBeenCalled()
      expect(onHostAuthorityUncertain).not.toHaveBeenCalled()

      // A third reopen is still served from memory.
      await open(controller, host, 'chat-b')
      const diskRead = deferred<AgentChatMessage[]>()
      clerum.chat.loadMessages.mockImplementationOnce(() => diskRead.promise)
      const reopenStart = frames.length
      let reopen!: Promise<void>
      await act(async () => {
        reopen = controller.result.current.switchToChat(host, 'chat-a')
      })
      expectOnlyTranscript(frames.slice(reopenStart), 'chat-a', disk['chat-a'])
      await act(async () => {
        diskRead.resolve(disk['chat-a'])
        await reopen
      })
    }
  )

  it.each(HOSTS)(
    'j. %s: the remembered transcript is shown while the last-active write is pending, and history is read after it',
    async host => {
      const disk = { 'chat-a': transcript('chat-a'), 'chat-b': transcript('chat-b') }
      serveDisk(disk)
      const controller = mount(host)
      await settleMount()
      await open(controller, host, 'chat-a')
      await open(controller, host, 'chat-b')

      const persisted = deferred<void>()
      const diskRead = deferred<AgentChatMessage[]>()
      clerum.chat.setLastActive.mockImplementationOnce(() => persisted.promise)
      clerum.chat.loadMessages.mockImplementationOnce(() => diskRead.promise)
      const readsBefore = clerum.chat.loadMessages.mock.calls.length
      const reopenStart = frames.length
      let reopen!: Promise<void>
      await act(async () => {
        reopen = controller.result.current.switchToChat(host, 'chat-a')
      })
      // While the last-active write is pending: the remembered transcript, no disk read (#976).
      expect(clerum.chat.setLastActive).toHaveBeenLastCalledWith(host, 'chat-a')
      expect(clerum.chat.loadMessages.mock.calls.length).toBe(readsBefore)
      expectOnlyTranscript(frames.slice(reopenStart), 'chat-a', disk['chat-a'])

      await act(async () => {
        persisted.resolve()
      })
      // Persisted: the disk page is read only now.
      expect(clerum.chat.loadMessages).toHaveBeenLastCalledWith(host, 'chat-a', 80, undefined)

      await act(async () => {
        diskRead.resolve(disk['chat-a'])
        await reopen
      })
      expectOnlyTranscript(frames.slice(reopenStart), 'chat-a', disk['chat-a'])
      expect(blankFrame(frames.slice(reopenStart), 'chat-a')).toBe(false)
    }
  )

  it.each(HOSTS)(
    'k. %s: a failed last-active write withdraws the remembered transcript',
    async host => {
      const disk = { 'chat-a': transcript('chat-a'), 'chat-b': transcript('chat-b') }
      serveDisk(disk)
      const controller = mount(host)
      await settleMount()
      await open(controller, host, 'chat-a')
      await open(controller, host, 'chat-b')

      const write = deferred<void>()
      clerum.chat.setLastActive.mockImplementationOnce(() => write.promise)
      const onCurrentError = vi.fn()
      const readsBefore = clerum.chat.loadMessages.mock.calls.length
      const reopenStart = frames.length
      let reopen!: Promise<void>
      await act(async () => {
        reopen = controller.result.current
          .switchToChat(host, 'chat-a', { onCurrentError })
          .catch(() => undefined)
      })
      // Witness: the remembered transcript was on screen before the write failed.
      expectOnlyTranscript(frames.slice(reopenStart), 'chat-a', disk['chat-a'])
      await act(async () => {
        write.reject(new Error('last-active write failed'))
        await reopen
      })
      expect(clerum.chat.setLastActive).toHaveBeenLastCalledWith(host, 'chat-a')
      expect(onCurrentError).toHaveBeenCalledTimes(1)
      expect(clerum.chat.loadMessages.mock.calls.length).toBe(readsBefore)
      expect(controller.result.current.activeChatId).toBe('chat-a')
      expect(controller.result.current.chatMessages).toEqual([])
      expect(controller.result.current.chatMessagesLoading).toBe(false)
    }
  )

  it.each(HOSTS)(
    'l. %s: an uncertain hold during the last-active write withdraws the remembered transcript',
    async host => {
      const disk = { 'chat-a': transcript('chat-a'), 'chat-b': transcript('chat-b') }
      serveDisk(disk)
      const controller = mount(host)
      await settleMount()
      await open(controller, host, 'chat-a')
      await open(controller, host, 'chat-b')

      const write = deferred<void>()
      clerum.chat.setLastActive.mockImplementationOnce(() => write.promise)
      const readsBefore = clerum.chat.loadMessages.mock.calls.length
      const reopenStart = frames.length
      let reopen!: Promise<void>
      await act(async () => {
        reopen = controller.result.current.switchToChat(host, 'chat-a')
      })
      // Witness: the remembered transcript was on screen before the hold.
      expectOnlyTranscript(frames.slice(reopenStart), 'chat-a', disk['chat-a'])
      controller.hostAuthority.hold(host, 'uncertain')
      expect(controller.hostAuthority.isBlocked(host)).toBe(true)
      await act(async () => {
        write.resolve()
        await reopen
      })
      expect(controller.result.current.activeChatId).toBe('chat-a')
      expect(controller.result.current.chatMessages).toEqual([])
      expect(controller.result.current.chatMessagesLoading).toBe(false)
      expect(clerum.chat.loadMessages.mock.calls.length).toBe(readsBefore)
    }
  )

  it.each(HOSTS)(
    "m. %s: a superseded click's failed write leaves the newer click's transcript and memo entry",
    async host => {
      const disk = { 'chat-a': transcript('chat-a'), 'chat-b': transcript('chat-b') }
      serveDisk(disk)
      const controller = mount(host)
      await settleMount()
      await open(controller, host, 'chat-a')
      await open(controller, host, 'chat-b')
      const firstWrite = deferred<void>()
      const secondWrite = deferred<void>()
      clerum.chat.setLastActive
        .mockImplementationOnce(() => firstWrite.promise)
        .mockImplementationOnce(() => secondWrite.promise)
      const reopenStart = frames.length
      let firstClick!: Promise<void>
      let secondClick!: Promise<void>
      await act(async () => {
        firstClick = controller.result.current.switchToChat(host, 'chat-a').catch(() => undefined)
      })
      await act(async () => {
        secondClick = controller.result.current.switchToChat(host, 'chat-a')
      })
      // Liveness: both clicks issued their own last-active write.
      expect(
        clerum.chat.setLastActive.mock.calls.filter(call => call[1] === 'chat-a').length
      ).toBeGreaterThanOrEqual(3)
      await act(async () => {
        firstWrite.reject(new Error('last-active write failed'))
        await firstClick
      })
      // The newer click still owns the view: its transcript stays on screen.
      expectOnlyTranscript(frames.slice(reopenStart), 'chat-a', disk['chat-a'])
      await act(async () => {
        secondWrite.resolve()
        await secondClick
      })
      // The memo entry survived: a later return paints it before the write.
      await open(controller, host, 'chat-b')
      const persisted = deferred<void>()
      clerum.chat.setLastActive.mockImplementationOnce(() => persisted.promise)
      const returnStart = frames.length
      let returning!: Promise<void>
      await act(async () => {
        returning = controller.result.current.switchToChat(host, 'chat-a')
      })
      expectOnlyTranscript(frames.slice(returnStart), 'chat-a', disk['chat-a'])
      await act(async () => {
        persisted.resolve()
        await returning
      })
    }
  )
})
