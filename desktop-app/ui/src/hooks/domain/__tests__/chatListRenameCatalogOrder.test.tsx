// @vitest-environment jsdom
/**
 * #1091 A21 — a catalog page requested before a user rename settled must not
 * write the title it carries over the rename, on disk or in the sidebar.
 *
 * The index, rename and reconcile IPCs run on a real `ChatStore` in a temp dir,
 * so the per-agent `serializeIndex` queue and the index file are the
 * production ones. The "server" is one mutable title: a successful PATCH
 * updates it and `listSessions` reads it when the request is sent, so an old
 * title can only arrive through a page requested earlier (in flight or cached).
 *
 * Every test ends with a positive control: a page requested after the rename
 * settled, carrying another device's title, is written and shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatStore } from '../../../../../src/chatStore'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AGENT = 'agent-x'
const NOW = '2026-09-12T00:00:00.000Z'
const CATALOG_TTL_MS = 5_000

type ReconcileCall = { agentRef: string; titles: Record<string, string | undefined> }
type View = ReturnType<typeof renderController>

let clerum: MockClerum
let dir: string
let store: ChatStore
let serverTitle: string
let reconcileCalls: ReconcileCall[]
let reconcileWrites: Promise<unknown>[]
let renameIpcTitles: string[]
let patchTitles: string[]
let clockOffset: number
let agentListVariant: number
/** Per-title hooks into the local rename IPC: wait for a gate, then write or fail. */
let renameIpcBehaviour: Map<string, { gate?: Promise<void>; fail?: boolean }>

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function wireStore(c: MockClerum, s: ChatStore) {
  c.chat.getIndex.mockImplementation((agentRef: string) => s.getIndex(agentRef))
  c.chat.create.mockImplementation((agentRef: string, id: string) => s.createChat(agentRef, id))
  c.chat.rename.mockImplementation(async (agentRef: string, id: string, title: string) => {
    renameIpcTitles.push(title)
    const behaviour = renameIpcBehaviour.get(title)
    if (behaviour?.fail) {
      if (behaviour.gate) await behaviour.gate
      throw new Error('local rename failed')
    }
    // Main enqueues the write at once (serializeIndex FIFO); only the reply to
    // the renderer waits, as IPC latency does.
    const write = s.renameChat(agentRef, id, title)
    if (behaviour?.gate) await behaviour.gate
    return write
  })
  c.chat.reconcileServerSessions.mockImplementation(
    (agentRef: string, sessions: Array<{ chatId: string; title?: string }>) => {
      const write = s.upsertServerSessions(agentRef, sessions)
      reconcileCalls.push({
        agentRef,
        titles: Object.fromEntries(sessions.map(x => [x.chatId, x.title])),
      })
      reconcileWrites.push(write)
      return write
    }
  )
}

function snapshotPage() {
  return {
    items: [{ agent: AGENT, chatId: 'c1', turnCount: 1, lastActivityAt: NOW, title: serverTitle }],
  }
}

/** listSessions reads the server title when called and answers when `gate` opens. */
function serveGated(gate: Promise<void>) {
  clerum.rpc.listSessions.mockImplementation(async () => {
    const page = snapshotPage()
    await gate
    return page
  })
}

function serveImmediately() {
  clerum.rpc.listSessions.mockImplementation(async () => snapshotPage())
}

/** The PATCH answers when `gate` opens; a success updates the server title. */
function gatePatch(gate: Promise<void>) {
  clerum.rpc.renameSession.mockImplementation(
    async (_h: string, _a: string, _c: string, title: string) => {
      patchTitles.push(title)
      await gate
      serverTitle = title
      return { title }
    }
  )
}

function agentCalls(fromIndex = 0): ReconcileCall[] {
  return reconcileCalls.slice(fromIndex).filter(call => call.agentRef === AGENT)
}

async function diskTitleAfterRestart(): Promise<string | undefined> {
  await Promise.all(reconcileWrites.map(write => write.catch(() => undefined)))
  // A new ChatStore on the same directory is an app restart.
  const restarted = new ChatStore(dir)
  return (await restarted.getIndex(AGENT)).chats.find(c => c.id === 'c1')?.title
}

function sidebarTitle(view: View): string | undefined {
  return view.result.current.chatList.find(c => c.id === 'c1')?.title
}

function latestTitle(view: View): string | undefined {
  return (view.result.current.latestChatSessions as Array<{ id: string; title: string }>).find(
    c => c.id === 'c1'
  )?.title
}

/** Re-runs the cross-Host publication, which requests one page per Host. */
async function pollCatalog(view: View) {
  agentListVariant += 1
  const agentNames = [AGENT, ...Array.from({ length: agentListVariant }, (_, i) => `agent-y${i}`)]
  await act(async () => {
    view.rerender({ agentNames })
  })
}

function expireCatalogCache() {
  clockOffset += CATALOG_TTL_MS + 1_000
}

/** Positive control: another device's rename, requested after settle, is accepted. */
async function expectFreshPageAccepted(view: View) {
  serverTitle = 'other-device'
  expireCatalogCache()
  serveImmediately()
  const before = reconcileCalls.length
  await pollCatalog(view)
  await waitFor(() =>
    expect(agentCalls(before).some(call => call.titles.c1 === 'other-device')).toBe(true)
  )
  await waitFor(() => expect(latestTitle(view)).toBe('other-device'))
  expect(await diskTitleAfterRestart()).toBe('other-device')
}

async function mountWithOldTitle(): Promise<View> {
  const view = renderController({ selectedAgent: AGENT, agentNames: [AGENT] })
  await waitFor(() => expect(sidebarTitle(view)).toBe('old'))
  return view
}

beforeEach(async () => {
  clerum = installMockClerum()
  dir = mkdtempSync(join(tmpdir(), 'chat-rename-catalog-order-'))
  store = new ChatStore(dir)
  await store.createChat(AGENT, 'c1')
  await store.renameChat(AGENT, 'c1', 'old')
  serverTitle = 'old'
  reconcileCalls = []
  reconcileWrites = []
  renameIpcTitles = []
  patchTitles = []
  renameIpcBehaviour = new Map()
  clockOffset = 0
  agentListVariant = 0
  const realNow = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset)
  gatePatch(Promise.resolve())
  wireStore(clerum, store)
})

afterEach(async () => {
  cleanup()
  // A catalog read scheduled after first paint (`scheduleAfterFirstPaint`,
  // two animation frames) survives unmount. Let it reach this test's bridge
  // before the next test installs its own: otherwise it hits the next mock's
  // empty default, and the module-level catalog cache serves that empty page to
  // the next mount.
  await new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
  vi.restoreAllMocks()
  uninstallMockClerum()
})

describe('a page requested before the rename and delivered after it settled', () => {
  async function renameWhilePageInFlight(): Promise<View> {
    const pageGate = deferred()
    let sourceCalls = 0
    clerum.rpc.listSessions.mockImplementation(async () => {
      sourceCalls += 1
      const page = snapshotPage()
      await pageGate.promise
      return page
    })
    const view = renderController({ selectedAgent: AGENT, agentNames: [AGENT] })
    await waitFor(() => expect(sourceCalls).toBeGreaterThan(0))
    await waitFor(() => expect(sidebarTitle(view)).toBe('old'))
    expect(agentCalls()).toHaveLength(0)

    await act(async () => {
      await view.result.current.handleRenameChatForAgent(AGENT, 'c1', 'new')
    })
    expect(renameIpcTitles).toEqual(['new'])
    expect(patchTitles).toEqual(['new'])
    expect(serverTitle).toBe('new')
    expect(await diskTitleAfterRestart()).toBe('new')

    await act(async () => {
      pageGate.resolve()
    })
    // Witness: the old page was processed and reached the store without a title.
    await waitFor(() => expect(agentCalls().length).toBeGreaterThan(0))
    expect(agentCalls().every(call => 'c1' in call.titles && call.titles.c1 === undefined)).toBe(
      true
    )
    return view
  }

  it('T1: keeps the renamed title on disk', async () => {
    const view = await renameWhilePageInFlight()
    expect(await diskTitleAfterRestart()).toBe('new')
    await expectFreshPageAccepted(view)
  })

  it('T7: keeps the renamed title in the sidebar and the Latest list', async () => {
    const view = await renameWhilePageInFlight()
    await waitFor(() => expect(latestTitle(view)).toBeDefined())
    expect(sidebarTitle(view)).toBe('new')
    expect(latestTitle(view)).toBe('new')
    await expectFreshPageAccepted(view)
  })
})

describe('a page served from the catalog cache after the rename', () => {
  it('T2: is not written over the rename', async () => {
    const sourceTitles: string[] = []
    clerum.rpc.listSessions.mockImplementation(async (hostRef: string) => {
      if (hostRef === AGENT) sourceTitles.push(serverTitle)
      return snapshotPage()
    })
    const view = await mountWithOldTitle()
    await waitFor(() => expect(agentCalls().some(call => call.titles.c1 === 'old')).toBe(true))

    await act(async () => {
      await view.result.current.handleRenameChatForAgent(AGENT, 'c1', 'new')
    })
    expect(serverTitle).toBe('new')
    const before = reconcileCalls.length

    await pollCatalog(view)
    // Witness: the poll was answered from the cache (no new fetch for this Host)
    // and its page reached the store without a title.
    await waitFor(() => expect(agentCalls(before).length).toBeGreaterThan(0))
    expect(sourceTitles).toEqual(['old'])
    expect(agentCalls(before).every(call => call.titles.c1 === undefined)).toBe(true)
    expect(await diskTitleAfterRestart()).toBe('new')
    expect(latestTitle(view)).toBe('new')

    await expectFreshPageAccepted(view)
  })
})

describe('a page processed while the local rename write is in flight', () => {
  async function renameDuringLocalWrite(patch: 'ok' | 'fail'): Promise<View> {
    const localReply = deferred()
    renameIpcBehaviour.set('new', { gate: localReply.promise })
    if (patch === 'fail') {
      clerum.rpc.renameSession.mockImplementation(async (_h, _a, _c, title: string) => {
        patchTitles.push(title)
        throw new Error('fetch failed')
      })
    }
    const pageGate = deferred()
    serveGated(pageGate.promise)
    const view = await mountWithOldTitle()

    let renaming: Promise<void> | undefined
    await act(async () => {
      renaming = view.result.current.handleRenameChatForAgent(AGENT, 'c1', 'new')
    })
    // Witness: the local write is queued in main and the PATCH waits for it.
    await waitFor(() => expect(renameIpcTitles).toEqual(['new']))
    expect(patchTitles).toEqual([])

    await act(async () => {
      pageGate.resolve()
    })
    await waitFor(() => expect(agentCalls().length).toBeGreaterThan(0))
    expect(agentCalls().every(call => call.titles.c1 === undefined)).toBe(true)

    await act(async () => {
      localReply.resolve()
      await renaming
    })
    expect(patchTitles).toEqual(['new'])
    return view
  }

  it('T3: PATCH succeeds — disk and sidebar keep the rename', async () => {
    const view = await renameDuringLocalWrite('ok')
    expect(serverTitle).toBe('new')
    expect(sidebarTitle(view)).toBe('new')
    expect(await diskTitleAfterRestart()).toBe('new')
    await expectFreshPageAccepted(view)
  })

  it('T4: PATCH fails — an offline restart still shows the rename', async () => {
    const view = await renameDuringLocalWrite('fail')
    expect(serverTitle).toBe('old')
    expect(sidebarTitle(view)).toBe('new')
    expect(await diskTitleAfterRestart()).toBe('new')

    view.unmount()
    cleanup()
    uninstallMockClerum()
    clerum = installMockClerum()
    reconcileCalls = []
    reconcileWrites = []
    wireStore(clerum, new ChatStore(dir))
    clerum.rpc.listSessions.mockRejectedValue(new Error('fetch failed'))
    const after = renderController({ selectedAgent: AGENT, agentNames: [AGENT] })
    await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
    await waitFor(() => expect(sidebarTitle(after)).toBeDefined())
    expect(sidebarTitle(after)).toBe('new')
  })
})

describe('a page requested while the PATCH is pending', () => {
  it.each(['before', 'after'] as const)(
    'T5: delivered %s the 200 — not written over the rename',
    async order => {
      serveImmediately()
      const view = await mountWithOldTitle()
      await waitFor(() => expect(agentCalls().some(call => call.titles.c1 === 'old')).toBe(true))

      const patch = deferred()
      gatePatch(patch.promise)
      let renaming: Promise<void> | undefined
      await act(async () => {
        renaming = view.result.current.handleRenameChatForAgent(AGENT, 'c1', 'new')
      })
      await waitFor(() => expect(patchTitles).toEqual(['new']))

      expireCatalogCache()
      const pageGate = deferred()
      let pageRequested = false
      clerum.rpc.listSessions.mockImplementation(async (hostRef: string) => {
        const page = snapshotPage()
        if (hostRef === AGENT) pageRequested = true
        await pageGate.promise
        return page
      })
      const before = reconcileCalls.length
      await pollCatalog(view)
      // Witness: the page was requested while the PATCH was pending.
      await waitFor(() => expect(pageRequested).toBe(true))
      expect(serverTitle).toBe('old')

      const deliverPage = async () => {
        await act(async () => {
          pageGate.resolve()
        })
        await waitFor(() => expect(agentCalls(before).length).toBeGreaterThan(0))
      }
      const answerPatch = async () => {
        await act(async () => {
          patch.resolve()
          await renaming
        })
        expect(serverTitle).toBe('new')
      }
      if (order === 'before') {
        await deliverPage()
        await answerPatch()
      } else {
        await answerPatch()
        await deliverPage()
      }

      expect(agentCalls(before).every(call => call.titles.c1 === undefined)).toBe(true)
      expect(latestTitle(view)).toBe('new')
      expect(await diskTitleAfterRestart()).toBe('new')
      await expectFreshPageAccepted(view)
    }
  )
})

describe('re-renames', () => {
  it('T6a: a superseded rename never sends its PATCH', async () => {
    serveImmediately()
    const view = await mountWithOldTitle()
    const firstReply = deferred()
    renameIpcBehaviour.set('first', { gate: firstReply.promise })

    let first: Promise<void> | undefined
    await act(async () => {
      first = view.result.current.handleRenameChatForAgent(AGENT, 'c1', 'first')
    })
    await waitFor(() => expect(renameIpcTitles).toEqual(['first']))
    await act(async () => {
      await view.result.current.handleRenameChatForAgent(AGENT, 'c1', 'second')
    })
    expect(patchTitles).toEqual(['second'])

    await act(async () => {
      firstReply.resolve()
      await first
    })
    // Witness: the first rename's local write completed (FIFO order on disk).
    expect(renameIpcTitles).toEqual(['first', 'second'])
    expect(patchTitles).toEqual(['second'])
    expect(serverTitle).toBe('second')
    expect(await diskTitleAfterRestart()).toBe('second')
    await expectFreshPageAccepted(view)
  })

  it('T6b: a failed local write hands the key back to the pending rename it replaced', async () => {
    serveImmediately()
    const view = await mountWithOldTitle()
    const firstPatch = deferred()
    gatePatch(firstPatch.promise)
    let first: Promise<void> | undefined
    await act(async () => {
      first = view.result.current.handleRenameChatForAgent(AGENT, 'c1', 'first')
    })
    await waitFor(() => expect(patchTitles).toEqual(['first']))

    renameIpcBehaviour.set('second', { fail: true })
    let secondError: unknown
    await act(async () => {
      await view.result.current
        .handleRenameChatForAgent(AGENT, 'c1', 'second')
        .catch(error => (secondError = error))
    })
    expect(secondError).toBeInstanceOf(Error)
    expect(renameIpcTitles).toEqual(['first', 'second'])

    // The first PATCH is still pending: a page requested now carries the old
    // server title and must still be refused.
    expireCatalogCache()
    serveImmediately()
    const before = reconcileCalls.length
    await pollCatalog(view)
    await waitFor(() => expect(agentCalls(before).length).toBeGreaterThan(0))
    expect(serverTitle).toBe('old')
    expect(agentCalls(before).every(call => call.titles.c1 === undefined)).toBe(true)
    expect(await diskTitleAfterRestart()).toBe('first')

    await act(async () => {
      firstPatch.resolve()
      await first
    })
    expect(serverTitle).toBe('first')
    expect(patchTitles).toEqual(['first'])
    await expectFreshPageAccepted(view)
  })

  it('T6c: a failed local write after the replaced rename settled leaves no pending rename', async () => {
    serveImmediately()
    const view = await mountWithOldTitle()
    const firstPatch = deferred()
    gatePatch(firstPatch.promise)
    let first: Promise<void> | undefined
    await act(async () => {
      first = view.result.current.handleRenameChatForAgent(AGENT, 'c1', 'first')
    })
    await waitFor(() => expect(patchTitles).toEqual(['first']))

    const secondReply = deferred()
    renameIpcBehaviour.set('second', { gate: secondReply.promise, fail: true })
    let second: Promise<void> | undefined
    await act(async () => {
      second = view.result.current.handleRenameChatForAgent(AGENT, 'c1', 'second')
    })
    await waitFor(() => expect(renameIpcTitles).toEqual(['first', 'second']))

    // The first rename's 200 lands while the second waits for its local write.
    await act(async () => {
      firstPatch.resolve()
      await first
    })
    expect(serverTitle).toBe('first')

    let secondError: unknown
    await act(async () => {
      secondReply.resolve()
      await second?.catch(error => (secondError = error))
    })
    expect(secondError).toBeInstanceOf(Error)
    expect(patchTitles).toEqual(['first'])
    expect(await diskTitleAfterRestart()).toBe('first')

    // Nothing is pending any more, so a later server title is accepted.
    await expectFreshPageAccepted(view)
  })

  it('T6d: two overlapping failed local writes leave no stuck pending rename', async () => {
    serveImmediately()
    const view = await mountWithOldTitle()
    const firstPatch = deferred()
    gatePatch(firstPatch.promise)
    let first: Promise<void> | undefined
    await act(async () => {
      first = view.result.current.handleRenameChatForAgent(AGENT, 'c1', 'first')
    })
    await waitFor(() => expect(patchTitles).toEqual(['first']))

    const secondReply = deferred()
    const thirdReply = deferred()
    renameIpcBehaviour.set('second', { gate: secondReply.promise, fail: true })
    renameIpcBehaviour.set('third', { gate: thirdReply.promise, fail: true })
    let second: Promise<void> | undefined
    let third: Promise<void> | undefined
    await act(async () => {
      second = view.result.current.handleRenameChatForAgent(AGENT, 'c1', 'second')
    })
    await waitFor(() => expect(renameIpcTitles).toEqual(['first', 'second']))
    await act(async () => {
      third = view.result.current.handleRenameChatForAgent(AGENT, 'c1', 'third')
    })
    await waitFor(() => expect(renameIpcTitles).toEqual(['first', 'second', 'third']))

    // The superseded second write fails first, then the current third one.
    const errors: unknown[] = []
    await act(async () => {
      secondReply.resolve()
      await second?.catch(error => errors.push(error))
    })
    await act(async () => {
      thirdReply.resolve()
      await third?.catch(error => errors.push(error))
    })
    expect(errors).toHaveLength(2)

    await act(async () => {
      firstPatch.resolve()
      await first
    })
    // Witness: only the first rename reached the server.
    expect(patchTitles).toEqual(['first'])
    expect(serverTitle).toBe('first')
    expect(await diskTitleAfterRestart()).toBe('first')

    // No failed rename is left pending, so a later server title is accepted.
    await expectFreshPageAccepted(view)
  })
})
