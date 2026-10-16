// @vitest-environment jsdom
/**
 * #1091 A17 — a remembered transcript painted on a click is provisional until
 * its last-active write and first local page settle. Only the click that owns
 * it confirms or withdraws it; an invalidation withdraws it at once; New chat
 * restores it; paging and send refuse it. Rows 1, 2 and 4 of the A17 table are
 * tests j, k and m in `switchToChat.transcriptMemo.test.tsx`; row 14 (blank
 * path) is #976's `createChatFailure*` suites. Rows 15 and 16 cover a newer
 * selection intent that supersedes the click without switching, on the same
 * Host and across Hosts. Rows 17 and 18 check that the superseded mark stays
 * dead when a later click or effect reuses the same switch request. Every case
 * runs for a
 * stateful and a stateless Host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import {
  getComposerDraft,
  resetComposerDraftStore,
  setComposerDraft,
} from '@lib/composerDraftStore'
import type { AgentChatMessage } from '../../../uiTypes'
import { deferred, localIndex } from './__fixtures__/catalogFixtures'
import { type RenderControllerResult, renderController } from './__fixtures__/controllerHarness'
import { ipcGenericForbidden } from './__fixtures__/ipcErrors'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HOSTS = ['chatllm', 'chatllm-stateless'] as const

let clerum: MockClerum
type SessionResult = Awaited<ReturnType<typeof clerum.rpc.loadSessionMessages>>

interface Frame {
  activeChatId: string | null
  contents: string[]
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
        frames.push({ activeChatId: value.activeChatId, contents: contentsOf(value.chatMessages) }),
    }
  )
}

async function open(controller: RenderControllerResult, host: string, chatId: string) {
  await act(async () => {
    await controller.result.current.switchToChat(host, chatId)
  })
}

/** Mount, open A then B, so A is remembered; return the controller and the disk. */
async function rememberA(host: string, aCount = 2) {
  const disk = { 'chat-a': transcript('chat-a', aCount), 'chat-b': transcript('chat-b') }
  serveDisk(disk)
  const controller = mount(host)
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
  await open(controller, host, 'chat-a')
  await open(controller, host, 'chat-b')
  return { controller, disk }
}

/** Click A with its last-active write held; the remembered transcript is on screen. */
async function clickHeld(
  controller: RenderControllerResult,
  host: string,
  options: { onCurrentError?: (error: unknown) => void } = {}
) {
  const write = deferred<void>()
  clerum.chat.setLastActive.mockImplementationOnce(() => write.promise)
  let click!: Promise<void>
  await act(async () => {
    click = controller.result.current.switchToChat(host, 'chat-a', options).catch(() => undefined)
  })
  return { write, click }
}

const chatAReads = () =>
  clerum.chat.loadMessages.mock.calls.filter(call => call[1] === 'chat-a').length

const shows = (controller: RenderControllerResult) =>
  contentsOf(controller.result.current.chatMessages)

describe('provisional selection (#1091 A17)', () => {
  it.each(HOSTS)(
    '3. %s: double click, first write ok and second fails: blank, one error, no page',
    async host => {
      const { controller, disk } = await rememberA(host)
      const firstError = vi.fn()
      const secondError = vi.fn()
      const first = await clickHeld(controller, host, { onCurrentError: firstError })
      const second = await clickHeld(controller, host, { onCurrentError: secondError })
      const readsBefore = chatAReads()
      await act(async () => {
        first.write.resolve()
        await first.click
      })
      // Witness: the remembered transcript is still up after the superseded write.
      expect(shows(controller)).toEqual(contentsOf(disk['chat-a']))
      await act(async () => {
        second.write.reject(new Error('last-active write failed'))
        await second.click
      })
      expect(controller.result.current.activeChatId).toBe('chat-a')
      expect(controller.result.current.chatMessages).toEqual([])
      expect(controller.result.current.chatMessagesLoading).toBe(false)
      expect(secondError).toHaveBeenCalledTimes(1)
      expect(firstError).not.toHaveBeenCalled()
      expect(chatAReads()).toBe(readsBefore)
    }
  )

  it.each(HOSTS)('5. %s: double click, both writes fail: blank and one error', async host => {
    const { controller, disk } = await rememberA(host)
    const firstError = vi.fn()
    const secondError = vi.fn()
    const first = await clickHeld(controller, host, { onCurrentError: firstError })
    const second = await clickHeld(controller, host, { onCurrentError: secondError })
    const readsBefore = chatAReads()
    await act(async () => {
      first.write.reject(new Error('first write failed'))
      await first.click
    })
    // The superseded failure does not withdraw the newer click's transcript.
    expect(shows(controller)).toEqual(contentsOf(disk['chat-a']))
    await act(async () => {
      second.write.reject(new Error('second write failed'))
      await second.click
    })
    expect(controller.result.current.chatMessages).toEqual([])
    expect(secondError).toHaveBeenCalledTimes(1)
    expect(firstError).not.toHaveBeenCalled()
    expect(chatAReads()).toBe(readsBefore)
  })

  it.each(HOSTS)(
    "6. %s: the first click's pending page never paints after the second click's write fails",
    async host => {
      const { controller, disk } = await rememberA(host)
      const first = await clickHeld(controller, host)
      const firstPage = deferred<AgentChatMessage[]>()
      clerum.chat.loadMessages.mockImplementationOnce(() => firstPage.promise)
      await act(async () => {
        first.write.resolve()
      })
      // Witness: the first click reached its local page read.
      expect(clerum.chat.loadMessages).toHaveBeenLastCalledWith(host, 'chat-a', 80, undefined)
      const secondError = vi.fn()
      const second = await clickHeld(controller, host, { onCurrentError: secondError })
      await act(async () => {
        second.write.reject(new Error('last-active write failed'))
        await second.click
      })
      expect(controller.result.current.chatMessages).toEqual([])
      const withdrawnAt = frames.length
      const newerPage = transcript('chat-a', 3)
      let firstSettled = false
      await act(async () => {
        firstPage.resolve(newerPage)
        await first.click.then(() => {
          firstSettled = true
        })
      })
      expect(firstSettled).toBe(true)
      expect(secondError).toHaveBeenCalledTimes(1)
      expect(controller.result.current.chatMessages).toEqual([])
      expect(frames.slice(withdrawnAt).some(frame => frame.contents.length > 0)).toBe(false)
      // The page differed from the remembered transcript, so it would have painted.
      expect(contentsOf(newerPage)).not.toEqual(contentsOf(disk['chat-a']))
    }
  )

  it.each(HOSTS)(
    '7. %s: an uncertain hold through a real 403 during the write withdraws at once',
    async host => {
      const { controller, disk } = await rememberA(host)
      // B's Host read is still pending when the user returns to A.
      const chatBHostRead = deferred<SessionResult>()
      clerum.rpc.loadSessionMessages.mockImplementationOnce(() => chatBHostRead.promise)
      let toB!: Promise<void>
      await act(async () => {
        toB = controller.result.current.switchToChat(host, 'chat-b').catch(() => undefined)
      })
      await waitFor(() =>
        expect(clerum.rpc.loadSessionMessages.mock.calls.at(-1)?.[2]).toBe('chat-b')
      )
      const { write, click } = await clickHeld(controller, host)
      expect(shows(controller)).toEqual(contentsOf(disk['chat-a']))
      const readsBefore = chatAReads()
      const denial = await ipcGenericForbidden('rpc:loadSessionMessages')
      await act(async () => {
        chatBHostRead.reject(denial)
        await toB
      })
      // Witness: the denial reached the Host authority through the reconcile.
      expect(controller.hostAuthority.isBlocked(host)).toBe(true)
      expect(controller.result.current.chatMessages).toEqual([])
      await act(async () => {
        write.resolve()
        await click
      })
      expect(controller.result.current.activeChatId).toBe('chat-a')
      expect(controller.result.current.chatMessages).toEqual([])
      expect(controller.result.current.chatMessagesLoading).toBe(false)
      expect(chatAReads()).toBe(readsBefore)
    }
  )

  it.each(HOSTS)(
    '8. %s: an uncertain hold on another Host keeps the remembered transcript',
    async host => {
      const other = 'other-host'
      const disk = {
        'chat-a': transcript('chat-a'),
        'chat-x': transcript('chat-x'),
      }
      serveDisk(disk)
      const controller = mount(host, { agentNames: [host, other] })
      await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
      await open(controller, host, 'chat-a')
      const otherHostRead = deferred<SessionResult>()
      clerum.rpc.loadSessionMessages.mockImplementationOnce(() => otherHostRead.promise)
      let toX!: Promise<void>
      await act(async () => {
        toX = controller.result.current.switchToChat(other, 'chat-x').catch(() => undefined)
      })
      await waitFor(() =>
        expect(clerum.rpc.loadSessionMessages.mock.calls.at(-1)?.[2]).toBe('chat-x')
      )
      const { write, click } = await clickHeld(controller, host)
      const denial = await ipcGenericForbidden('rpc:loadSessionMessages')
      await act(async () => {
        otherHostRead.reject(denial)
        await toX
      })
      // Witness: the other Host is held, this one is not.
      expect(controller.hostAuthority.isBlocked(other)).toBe(true)
      expect(controller.hostAuthority.isBlocked(host)).toBe(false)
      expect(shows(controller)).toEqual(contentsOf(disk['chat-a']))
      await act(async () => {
        write.resolve()
        await click
      })
      expect(controller.result.current.activeChatId).toBe('chat-a')
      expect(shows(controller)).toEqual(contentsOf(disk['chat-a']))
    }
  )

  it.each(HOSTS)('9. %s: deleting the chat during the write withdraws it for good', async host => {
    const { controller, disk } = await rememberA(host)
    const { write, click } = await clickHeld(controller, host)
    expect(shows(controller)).toEqual(contentsOf(disk['chat-a']))
    clerum.chat.delete.mockResolvedValueOnce({ cleanupPending: false })
    await act(async () => {
      const deletion = await controller.result.current.captureChatDeleteFence(host)
      await controller.result.current.handleDeleteChat('chat-a', deletion)
    })
    // Witness: the delete reached the store and moved the view off the chat.
    expect(clerum.chat.delete).toHaveBeenCalledWith(host, 'chat-a', expect.anything())
    expect(controller.result.current.activeChatId).not.toBe('chat-a')
    const deletedAt = frames.length
    await act(async () => {
      write.resolve()
      await click
    })
    await open(controller, host, 'chat-a')
    const aContents = contentsOf(disk['chat-a'])
    expect(
      frames
        .slice(deletedAt)
        .some(frame => frame.contents.some(content => aContents.includes(content)))
    ).toBe(false)
  })

  it.each(HOSTS)(
    '10. %s: a failed New chat during a remembered reopen restores the chat through a fresh switch',
    async host => {
      const { controller, disk } = await rememberA(host)
      // A reply landed on disk while A was hidden.
      disk['chat-a'] = transcript('chat-a', 3)
      const { write, click } = await clickHeld(controller, host)
      const writesBefore = clerum.chat.setLastActive.mock.calls.length
      const createError = new Error('local chat creation failed')
      clerum.chat.create.mockRejectedValueOnce(createError)
      let observed: unknown
      await act(async () => {
        await controller.result.current.handleCreateChat().catch(error => {
          observed = error
        })
      })
      expect(observed).toBe(createError)
      await waitFor(() => expect(shows(controller)).toEqual(contentsOf(disk['chat-a'])))
      expect(controller.result.current.activeChatId).toBe('chat-a')
      // The restore issued its own last-active write and opened the chat.
      expect(clerum.chat.setLastActive.mock.calls.slice(writesBefore)).toContainEqual([
        host,
        'chat-a',
      ])
      expect(clerum.chat.clearUnreadTerminal).toHaveBeenLastCalledWith(host, 'chat-a')
      await act(async () => {
        write.resolve()
        await click
      })
      expect(shows(controller)).toEqual(contentsOf(disk['chat-a']))
    }
  )

  it.each(HOSTS)(
    '11. %s: a failed New chat after a newer navigation restores nothing',
    async host => {
      const { controller } = await rememberA(host)
      const { write, click } = await clickHeld(controller, host)
      const create = deferred<never>()
      clerum.chat.create.mockImplementationOnce(() => create.promise)
      let creating!: Promise<unknown>
      await act(async () => {
        creating = controller.result.current.handleCreateChat().catch(error => error)
      })
      // Witness: the create is in flight.
      expect(clerum.chat.create).toHaveBeenCalledTimes(1)
      await open(controller, host, 'chat-b')
      const navigatedAt = frames.length
      await act(async () => {
        create.reject(new Error('local chat creation failed'))
        await creating
        write.resolve()
        await click
      })
      expect(controller.result.current.activeChatId).toBe('chat-b')
      expect(clerum.chat.setLastActive).toHaveBeenLastCalledWith(host, 'chat-b')
      expect(frames.slice(navigatedAt).every(frame => frame.activeChatId === 'chat-b')).toBe(true)
    }
  )

  it.each(HOSTS)(
    '12. %s: load older is refused while provisional and pages after confirmation',
    async host => {
      const { controller } = await rememberA(host, 100)
      const { write, click } = await clickHeld(controller, host)
      // Witness: the remembered transcript restored its older-history flag.
      expect(controller.result.current.hasOlderMessages).toBe(true)
      const shown = shows(controller)
      expect(shown).toHaveLength(80)
      const readsBefore = chatAReads()
      await act(async () => {
        await controller.result.current.handleLoadOlderMessages()
      })
      expect(chatAReads()).toBe(readsBefore)
      expect(shows(controller)).toEqual(shown)
      await act(async () => {
        write.resolve()
        await click
      })
      await act(async () => {
        await controller.result.current.handleLoadOlderMessages()
      })
      expect(clerum.chat.loadMessages).toHaveBeenLastCalledWith(host, 'chat-a', 80, 80)
      expect(shows(controller)).toHaveLength(100)
    }
  )

  it.each(HOSTS)(
    '13. %s: send is refused while provisional, keeps the draft, and works after confirmation',
    async host => {
      const { controller, disk } = await rememberA(host)
      const { write, click } = await clickHeld(controller, host)
      act(() => setComposerDraft('chat-a', 'hello', host))
      await act(async () => {
        await controller.result.current.handleSendAgentMessage('hello')
      })
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      expect(getComposerDraft('chat-a', host)).toBe('hello')
      expect(shows(controller)).toEqual(contentsOf(disk['chat-a']))
      await act(async () => {
        write.resolve()
        await click
      })
      await act(async () => {
        await controller.result.current.handleSendAgentMessage('hello')
      })
      // Liveness: the same send dispatches once the selection is confirmed.
      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
      expect(shows(controller)).toContain('hello')
    }
  )

  it.each(HOSTS)(
    '15. %s: a same-chat notification whose catalog load fails leaves no stale mark that refuses send',
    async host => {
      const { controller } = await rememberA(host)
      const { write, click } = await clickHeld(controller, host)
      const getIndexCalls = clerum.chat.getIndex.mock.calls.length
      clerum.chat.getIndex.mockRejectedValue(new Error('catalog unavailable'))
      // A notification for the same chat from another route, then the route change.
      act(() => controller.result.current.setPendingChatSelection(host, 'chat-a'))
      act(() => controller.rerender({ navItem: 'chat' }))
      // Witness: the selection effect tried the catalog and settled without a switch.
      await waitFor(() =>
        expect(clerum.chat.getIndex.mock.calls.length).toBeGreaterThan(getIndexCalls)
      )
      await waitFor(() => expect(controller.result.current.chatMessagesLoading).toBe(false))
      await act(async () => {
        write.resolve()
        await click
      })
      clerum.chat.getIndex.mockResolvedValue({ chats: [], lastActiveChatId: null } as never)
      expect(controller.result.current.activeChatId).toBe('chat-a')
      expect(shows(controller)).toEqual([])
      act(() => setComposerDraft('chat-a', 'hello', host))
      await act(async () => {
        await controller.result.current.handleSendAgentMessage('hello')
      })
      // The superseded click no longer owns a provisional mark, so send dispatches.
      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
      expect(getComposerDraft('chat-a', host)).toBe('')
    }
  )

  it.each([
    [HOSTS[0], HOSTS[1]],
    [HOSTS[1], HOSTS[0]],
  ])(
    '16. %s: a cross-Host open from the sidebar, then a return whose catalog load fails, leaves no stale mark that refuses send (other Host %s)',
    async (host, other) => {
      const disk = { 'chat-a': transcript('chat-a'), 'chat-b': transcript('chat-b') }
      serveDisk(disk)
      const defaultIndex = clerum.chat.getIndex.getMockImplementation()!
      const otherIndex = deferred<never>()
      let hostFails = false
      clerum.chat.getIndex.mockImplementation(async (agentRef: string) => {
        if (agentRef === other) return otherIndex.promise
        if (hostFails) throw new Error('catalog unavailable')
        return defaultIndex(agentRef)
      })
      const controller = mount(host, { agentNames: [host, other] })
      await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
      await open(controller, host, 'chat-a')
      await open(controller, host, 'chat-b')
      const { write, click } = await clickHeld(controller, host)
      // Open the other Host's chat from the sidebar while its catalog load is pending.
      await act(async () => {
        controller.result.current.setPendingChatSelection(other, 'chat-c')
        controller.rerender({ selectedAgent: other })
      })
      await act(async () => {
        write.resolve()
        await click
      })
      // Return to A from the sidebar; this Host's catalog load fails.
      hostFails = true
      const hostIndexCalls = () =>
        clerum.chat.getIndex.mock.calls.filter(call => call[0] === host).length
      const callsBefore = hostIndexCalls()
      await act(async () => {
        controller.result.current.setPendingChatSelection(host, 'chat-a')
        controller.rerender({ selectedAgent: host })
      })
      // Witness: the selection effect tried this Host's catalog and settled without a switch.
      await waitFor(() => expect(hostIndexCalls()).toBeGreaterThan(callsBefore))
      await waitFor(() => {
        expect(controller.result.current.chatMessagesLoading).toBe(false)
        expect(controller.result.current.chatListLoading).toBe(false)
      })
      expect(controller.result.current.activeChatId).toBe('chat-a')
      expect(shows(controller)).toEqual([])
      act(() => setComposerDraft('chat-a', 'hello', host))
      await act(async () => {
        await controller.result.current.handleSendAgentMessage('hello')
      })
      // The superseded click no longer owns a provisional mark, so send dispatches.
      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
      expect(getComposerDraft('chat-a', host)).toBe('')
    }
  )

  /** Rows 17/18 setup: row 15, then a message sent and rendered in A. */
  async function sendAfterSupersededClick(host: string) {
    const { controller } = await rememberA(host)
    const { write, click } = await clickHeld(controller, host)
    const getIndexCalls = clerum.chat.getIndex.mock.calls.length
    clerum.chat.getIndex.mockRejectedValue(new Error('catalog unavailable'))
    act(() => controller.result.current.setPendingChatSelection(host, 'chat-a'))
    act(() => controller.rerender({ navItem: 'chat' }))
    await waitFor(() =>
      expect(clerum.chat.getIndex.mock.calls.length).toBeGreaterThan(getIndexCalls)
    )
    await waitFor(() => expect(controller.result.current.chatMessagesLoading).toBe(false))
    await act(async () => {
      write.resolve()
      await click
    })
    clerum.chat.getIndex.mockResolvedValue(
      localIndex([
        { id: 'chat-a', title: 'A' },
        { id: 'chat-b', title: 'B' },
      ]) as never
    )
    act(() => setComposerDraft('chat-a', 'hello', host))
    await act(async () => {
      await controller.result.current.handleSendAgentMessage('hello')
    })
    // Liveness: the message was dispatched once and rendered.
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
    expect(shows(controller)).toContain('hello')
    return controller
  }

  it.each(HOSTS)(
    '17. %s: a later same-row click whose write fails does not revive the superseded mark',
    async host => {
      const controller = await sendAfterSupersededClick(host)
      const shown = shows(controller)
      const writesBefore = clerum.chat.setLastActive.mock.calls.length
      const reclickError = vi.fn()
      const reclick = await clickHeld(controller, host, { onCurrentError: reclickError })
      // Witness: the reclick issued its own write and did not repaint.
      expect(clerum.chat.setLastActive.mock.calls.length).toBe(writesBefore + 1)
      expect(shows(controller)).toEqual(shown)
      await act(async () => {
        reclick.write.reject(new Error('last-active write failed'))
        await reclick.click
      })
      // Witness: the failure reached the caller, once.
      expect(reclickError).toHaveBeenCalledTimes(1)
      expect(controller.result.current.activeChatId).toBe('chat-a')
      expect(shows(controller)).toEqual(shown)
    }
  )

  it.each(HOSTS)(
    '18. %s: a later effect-driven switch whose write fails does not revive the superseded mark',
    async host => {
      const controller = await sendAfterSupersededClick(host)
      const shown = shows(controller)
      const writesBefore = clerum.chat.setLastActive.mock.calls.length
      clerum.chat.setLastActive.mockRejectedValueOnce(new Error('last-active write failed'))
      // A same-chat notification whose catalog load now succeeds: the switch runs in the effect.
      act(() => controller.result.current.setPendingChatSelection(host, 'chat-a'))
      act(() => controller.rerender({ navItem: 'chat' }))
      // Witness: the effect's switch issued its write and its failure was reported.
      await waitFor(() =>
        expect(clerum.chat.setLastActive.mock.calls.length).toBe(writesBefore + 1)
      )
      await waitFor(() =>
        expect(controller.spies.pushToast).toHaveBeenCalledWith(
          expect.stringContaining('Could not open conversation'),
          'error'
        )
      )
      expect(controller.result.current.activeChatId).toBe('chat-a')
      expect(shows(controller)).toEqual(shown)
    }
  )
})
