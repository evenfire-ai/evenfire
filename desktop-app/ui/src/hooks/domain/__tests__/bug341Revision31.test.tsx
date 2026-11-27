// @vitest-environment jsdom
import React from 'react'
import { expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import fc from 'fast-check'
import { promises as fs, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SidebarNav } from '@components/SidebarNav'
import type { SidebarNavProps } from '@components/SidebarNav/types'
import { ChatStore } from '../../../../../src/chatStore'
import { RpcProxyClient, parseSessionsListResult } from '../../../../../src/rpcProxyClient'
import { bug341ScratchRoot, readBug341Fixture } from './__fixtures__/bug341TestSupport'
import { renderController } from './__fixtures__/controllerHarness'
import { installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

// Pin-only, transparent observer. The real dispatch and updater always run.
const trace = vi.hoisted(() => ({ active: false, enqueues: 0, discarded: 0, settled: 0 }))
vi.mock('react', async load => {
  const real = await load<typeof React>()
  const wrapped = new WeakMap()
  return {
    ...real,
    useState(initial: unknown) {
      const [value, dispatch] = real.useState(initial)
      const loc = new Error().stack?.split('\n')[2] ?? ''
      const sites = (process.env.BUG341_STATE_LINES ?? '429,436').split(',')
      if (!sites.some(n => loc.includes('useChatListController.ts:' + n + ':')))
        return [value, dispatch]
      if (!wrapped.has(dispatch))
        wrapped.set(dispatch, (action: any) => {
          const caller = new Error().stack?.split('\n')[2] ?? ''
          if (
            trace.active &&
            caller.includes(
              'useChatListController.ts:' + (process.env.BUG341_SETTLE_LINE ?? '2332') + ':'
            )
          )
            trace.settled++
          if (
            !trace.active ||
            !caller.includes(
              'useChatListController.ts:' + (process.env.BUG341_CATALOG_LINE ?? '508') + ':'
            )
          )
            return dispatch(action)
          trace.enqueues++
          return dispatch((previous: unknown) => {
            const next = action(previous)
            const prop = process.env.BUG341_ROWS_PROP ?? 'rows'
            if (next === previous || (prop && (next as any)[prop] === (previous as any)[prop]))
              trace.discarded++
            return next
          })
        })
      return [value, wrapped.get(dispatch)]
    },
  }
})
const logical = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('../../useChatStore', async load => {
  const real = await load<typeof import('../../useChatStore')>()
  const wrappers = new WeakMap()
  return {
    ...real,
    useChatStore() {
      const store = real.useChatStore()
      const list = store.listSessions
      if (!wrappers.has(list))
        wrappers.set(list, (...args: Parameters<typeof list>) => {
          logical.calls.push(args[0])
          return list(...args)
        })
      return { ...store, listSessions: wrappers.get(list) }
    },
  }
})
const sidebar = vi.hoisted(() => ({ current: () => ({}) as any }))
vi.mock('@contexts/AuthContext', () => ({
  useAuthContext: () => ({ busy: false, me: { name: 'Tester' }, handleLogout: vi.fn() }),
}))
vi.mock('@contexts/ChatListContext', () => ({ useChatListContext: () => sidebar.current() }))
vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => sidebar.current(),
}))
vi.mock('@contexts/NavigationContext', () => ({ useNavigationContext: () => sidebar.current() }))
vi.mock('@components/SidebarNav/FileExplorerTree', () => ({ FileExplorerTree: () => null }))
const props: SidebarNavProps = {
  navItem: 'chat',
  collapsed: false,
  compactMode: false,
  compactMenuOpen: false,
  onCompactMenuOpenChange: vi.fn(),
  onCollapsedChange: vi.fn(),
  onNewChat: vi.fn(),
  onOpenSandboxUiApp: vi.fn(),
  onSelect: vi.fn(),
  onOpenFilesSection: vi.fn(),
  onOpenPreviewSection: vi.fn(),
  pushToast: vi.fn(),
  availableSandboxUiApps: [],
  activeSandboxUiApp: null,
}
const X = 'agent-x',
  Y = 'agent-y',
  A = 'chat-a',
  B = 'chat-b',
  U = 'untouched-chat'
const fixtures = readBug341Fixture('bug341SessionProducer.json', 'BUG341_PRODUCER_OUTPUT') as any
const gone = readBug341Fixture('bug341TaskProgressGone.json', 'BUG341_TERMINAL_OUTPUT') as any
const expectSource = process.env.BUG341_EXPECT_SOURCE === '1'
const defer = () => {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { resolve, promise }
}
type Plan = {
  sample: 'before-write' | 'between-writes' | 'after-mark'
  replacement: boolean
  publishFirst: boolean
  guard?: boolean
  knownOldRow?: boolean
  noRefresh?: boolean
}
async function run(plan: Plan, scheduler: fc.Scheduler) {
  logical.calls = []
  const root = mkdtempSync(join(bug341ScratchRoot(), 'native-'))
  const store = new ChatStore(root)
  const bridge = installMockClerum()
  const rename = fs.rename.bind(fs)
  const nativeGate = defer(),
    reply = defer()
  const pending = new Set<Promise<unknown>>()
  const record = (name: string, value: Promise<any>) => {
    pending.add(value)
    void value.then(
      () => pending.delete(value),
      () => pending.delete(value)
    )
    return value
  }
  const captures: {
    host: string
    unread?: boolean
    group: number
    gate: ReturnType<typeof defer>
  }[] = []
  const catalogs: { host: string; gate: ReturnType<typeof defer> }[] = []
  const samples: (boolean | undefined)[] = []
  const requestLog: string[] = []
  let nativeBlocked = false,
    ackIssued = 0,
    ackFulfilled = 0,
    marks = 0,
    marksSaved = 0,
    group = 0,
    gateCatalog = false
  let clockDelta = 0,
    hideWork: Promise<void> | undefined
  let active = false
  let controller: ReturnType<typeof renderController> | undefined
  let nav: ReturnType<typeof render> | undefined
  const now = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(() => now() + clockDelta)
  for (const [host, id] of [
    [X, A],
    [X, B],
    [X, U],
    [Y, A],
  ])
    await store.createChat(host!, id!)
  for (const [host, id] of [
    [X, A],
    [X, U],
    [Y, A],
  ])
    await store.markUnreadTerminal(host!, id!)
  const before = await store.getIndex(X)
  expect(before.chats.find(r => r.id === A)?.unreadTerminal).toBe(true)
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (active && String(to) === join(root, X, 'index.json') && !nativeBlocked) {
      const data = JSON.parse(await fs.readFile(String(from), 'utf8'))
      const flag = data.chats.find((r: any) => r.id === A)?.unreadTerminal
      if (
        ackIssued &&
        ((plan.sample === 'before-write' && flag === false) ||
          (plan.sample === 'between-writes' && marks && flag === true))
      ) {
        nativeBlocked = true
        await nativeGate.promise
      }
    }
    await rename(from, to)
  })
  const http = new RpcProxyClient(() => 'https://example.test')
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async url =>
        new Response(
          JSON.stringify(String(url).includes('/chat-b/') ? fixtures.idle : fixtures.live)
        )
    )
  bridge.rpc.loadSessionMessages.mockImplementation((host, agent, id, _, query) =>
    http.loadSessionMessages('fixture-token', host, agent, id, query)
  )
  bridge.chat.getIndex.mockImplementation(async host => {
    const currentGroup = group
    const index = await store.getIndex(host)
    if (currentGroup) {
      const gate = defer()
      captures.push({
        host,
        group: currentGroup,
        unread: index.chats.find(r => r.id === A)?.unreadTerminal,
        gate,
      })
      await gate.promise
    }
    return index
  })
  bridge.chat.setLastActive.mockImplementation((host, id) => store.setLastActiveChatId(host, id))
  bridge.chat.loadMessages.mockImplementation((host, id, limit, offset) =>
    store.loadMessages(host, id, limit, offset)
  )
  bridge.chat.clearUnreadTerminal.mockImplementation(async (host, id) => {
    if (host !== X || id !== A) return store.clearUnreadTerminal(host, id)
    ackIssued++
    await store.clearUnreadTerminal(host, id)
    await reply.promise
    ackFulfilled++
  })
  bridge.chat.markUnreadTerminal.mockImplementation(async (host, id) => {
    if (host === X && id === A) marks++
    await store.markUnreadTerminal(host, id)
    if (host === X && id === A) marksSaved++
  })
  bridge.rpc.listSessions.mockImplementation(async host => {
    if (gateCatalog && (!plan.knownOldRow || host === Y)) {
      const gate = defer()
      catalogs.push({ host, gate })
      await gate.promise
      return parseSessionsListResult(fixtures.empty)
    }
    return parseSessionsListResult(fixtures[host])
  })
  for (const [kind, obj] of Object.entries({ chat: bridge.chat, rpc: bridge.rpc }))
    for (const [name, fn] of Object.entries(obj)) {
      if (!vi.isMockFunction(fn)) continue
      const orig = fn.getMockImplementation()
      if (!orig) continue
      fn.mockImplementation((...args: any[]) => {
        requestLog.push(kind + '.' + name)
        const result = orig(...args)
        return result?.then ? record(name, result) : result
      })
    }
  const settle = async () => {
    await waitFor(() => expect(pending.size, 'all existing IPC responses settled').toBe(0))
    await act(async () => {
      await new Promise<void>(r => setImmediate(r))
    })
    expect(pending.size).toBe(0)
  }
  try {
    controller = renderController({ selectedAgent: X, agentNames: [X, Y] })
    const current = () => controller!.result.current
    let selection: Promise<void> | undefined
    sidebar.current = () => ({
      ...current(),
      selectedAgent: X,
      handleSelectChatAgent: (agent: string, item: { chatId: string }) => {
        selection = current().switchToChat(agent, item.chatId)
      },
    })
    nav = render(<SidebarNav {...props} />)
    const row = (host: string, id: string) =>
      nav!.container.querySelector<HTMLElement>(
        '[data-testid="latest-session-row"][data-agent-ref="' +
          host +
          '"][data-chat-id="' +
          id +
          '"]'
      )
    const badge = (host: string, id: string) =>
      within(row(host, id)!).queryByRole('status', { name: 'Completed, unread' }) !== null
    const paint = () => nav!.rerender(<SidebarNav {...props} />)
    const click = (id: string) => {
      paint()
      selection = undefined
      fireEvent.click(within(row(X, id)!).getByRole('button', { name: /^Open / }))
      expect(selection).toBeDefined()
      return selection!
    }
    await waitFor(() =>
      expect(current().latestChatSessions.some(r => r.id === 'catalog-probe')).toBe(true)
    )
    await settle()
    paint()
    expect(badge(X, A)).toBe(true)
    expect(badge(Y, A)).toBe(true)
    const refresh = async (n: number) => {
      group = n
      controller!.hostAuthority.hold(Y, 'uncertain')
      controller!.hostAuthority.release(Y)
      await waitFor(() => expect(captures.filter(r => r.group === n)).toHaveLength(2))
      samples.push(captures.find(r => r.group === n && r.host === X)?.unread)
      group = 0
    }
    active = true
    if (plan.replacement) {
      await refresh(1)
      if (plan.knownOldRow) {
        gateCatalog = true
        clockDelta = 5001
        const previous = current().latestChatSessions
        await act(async () => {
          captures.forEach(s => s.gate.resolve())
        })
        await waitFor(() => expect(current().latestChatSessions).not.toBe(previous))
        await waitFor(() => expect(catalogs.some(x => x.host === Y)).toBe(true))
        gateCatalog = false
      }
    }
    const opening = click(A)
    await waitFor(() => expect(bridge.hasProgressHandler('fixture-completion')).toBe(true))
    await opening
    expect(ackIssued).toBe(1)
    expect(ackFulfilled).toBe(0)
    hideWork = click(B) // visibility changes before the real same-agent last-active write
    const terminal = async () => {
      await act(async () => {
        bridge.emitTaskProgress('fixture-completion', gone)
      })
      await waitFor(() => expect(marks).toBe(1))
    }
    if (!plan.guard) {
      await terminal()
      if (plan.sample === 'after-mark') await waitFor(() => expect(marksSaved).toBe(1))
      else await waitFor(() => expect(nativeBlocked).toBe(true))
    } else {
      await waitFor(async () =>
        expect((await store.getIndex(X)).chats.find(r => r.id === A)?.unreadTerminal).toBe(false)
      )
      await hideWork
      gateCatalog = true
      clockDelta = 5001
    }
    if (!plan.noRefresh) {
      await refresh(2)
      expect(samples.at(-1)).toBe(plan.sample !== 'between-writes' && !plan.guard)
    }
    expect(ackFulfilled).toBe(0)
    nativeGate.resolve()
    const releaseRead = async () => {
      await act(async () => {
        for (const cap of captures)
          void scheduler
            .schedule(Promise.resolve(), cap.host + cap.group)
            .then(() => cap.gate.resolve())
        await scheduler.waitAll()
      })
    }
    if (plan.publishFirst) {
      const previous = current().latestChatSessions
      await releaseRead()
      await waitFor(() => expect(current().latestChatSessions).not.toBe(previous))
      paint()
      expect(ackFulfilled).toBe(0)
      expect(badge(X, A), 'eligible publication before the older clear response').toBe(
        samples.at(-1)
      )
    }
    reply.resolve()
    await hideWork
    await waitFor(() => expect(ackFulfilled).toBe(1))
    if (!plan.publishFirst) await releaseRead()
    if (plan.knownOldRow) catalogs.forEach(x => x.gate.resolve())
    if (plan.guard) {
      await waitFor(() => expect(catalogs).toHaveLength(2))
      Object.assign(trace, { active: true, enqueues: 0, discarded: 0, settled: 0 })
      await act(async () => {
        catalogs.find(x => x.host === X)!.gate.resolve()
        for (let i = 0; i < 25; i++) await Promise.resolve()
        catalogs.find(x => x.host === Y)!.gate.resolve()
        for (let i = 0; i < 25; i++) await Promise.resolve()
        expect(trace.enqueues).toBe(2)
        expect(trace.settled).toBe(1)
        expect(trace.discarded).toBe(0)
        controller!.hostAuthority.hold(Y, 'uncertain')
      })
      expect(trace.discarded).toBeGreaterThan(0)
      await settle()
      paint()
      expect(row(Y, A)).toBeNull()
      expect(badge(X, A)).toBe(false)
      await terminal()
    }
    await settle()
    paint()
    expect(marksSaved).toBe(1)
    expect((await store.getIndex(X)).chats.find(r => r.id === A)?.unreadTerminal).toBe(true)
    expect((await store.getIndex(Y)).chats.find(r => r.id === A)?.unreadTerminal).toBe(true)
    expect(badge(X, U)).toBe(true)
    if (!plan.guard) expect(badge(Y, A)).toBe(true)
    // Fresh-window read sampled independently; earlier mark supplies no new true field.
    const wanted = !plan.guard && samples.at(-1) === true
    const expectedBadge = plan.noRefresh && expectSource ? true : wanted
    expect(badge(X, A), 'exact exposed target badge at quiescence').toBe(expectedBadge)
    console.log(
      'R31-OBS',
      JSON.stringify({
        plan,
        samples,
        wanted,
        nativeBlocked,
        ackIssued,
        ackFulfilled,
        marks,
        marksSaved,
        trace: { ...trace },
        logical: logical.calls,
        requestLog,
      })
    )
    if (process.env.BUG341_PARITY) {
      const vectors = JSON.parse(readFileSync(process.env.BUG341_PARITY, 'utf8'))
      const counts = Object.fromEntries(
        [...new Set(requestLog)].map(method => [
          method,
          requestLog.filter(m => m === method).length,
        ])
      )
      expect({ counts, logical: logical.calls }).toEqual(vectors[JSON.stringify(plan)])
    }
  } finally {
    active = false
    Object.assign(trace, { active: false, enqueues: 0, discarded: 0, settled: 0 })
    nativeGate.resolve()
    reply.resolve()
    captures.forEach(x => x.gate.resolve())
    catalogs.forEach(x => x.gate.resolve())
    await hideWork
    nav?.unmount()
    controller?.unmount()
    await Promise.allSettled([...pending])
    cleanup()
    uninstallMockClerum()
    fetch.mockRestore()
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}
for (const sample of ['before-write', 'between-writes', 'after-mark'] as const)
  for (const replacement of [false, true])
    for (const publishFirst of [false, true]) {
      const plan = { sample, replacement, publishFirst }
      it(
        'preserves the sampled row ' + JSON.stringify(plan),
        async () => {
          await run(plan, fc.sample(fc.scheduler(), { seed: 34131, numRuns: 1 })[0]!)
        },
        12000
      )
    }
it('retires after the last other-Host updater loses its authority before render', async () => {
  await run(
    { sample: 'between-writes', replacement: false, publishFirst: false, guard: true },
    fc.sample(fc.scheduler(), { seed: 34131, numRuns: 1 })[0]!
  )
}, 12000)

for (const sample of ['before-write', 'between-writes'] as const) {
  it(
    'replaces a window with known local membership ' + sample,
    async () => {
      await run(
        { sample, replacement: true, publishFirst: false, knownOldRow: true },
        fc.sample(fc.scheduler(), { seed: 34131, numRuns: 1 })[0]!
      )
    },
    12000
  )
}
it('projects the completed clear when no newer Latest read has published', async () => {
  await run(
    { sample: 'after-mark', replacement: false, publishFirst: false, noRefresh: true },
    fc.sample(fc.scheduler(), { seed: 34131, numRuns: 1 })[0]!
  )
}, 12000)
