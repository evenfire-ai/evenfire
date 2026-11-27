// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import fc from 'fast-check'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SidebarNav } from '@components/SidebarNav'
import type { SidebarNavProps } from '@components/SidebarNav/types'
import { ChatStore } from '../../../../../src/chatStore'
import { RpcProxyClient, parseSessionsListResult } from '../../../../../src/rpcProxyClient'
import { bug341ScratchRoot, readBug341Fixture } from './__fixtures__/bug341TestSupport'
import { checkDiscard, checkReplay } from './__fixtures__/candidateBoundaries'
import { renderController } from './__fixtures__/controllerHarness'
import { installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

const commitTrace = vi.hoisted(() => ({
  active: false,
  catalogEnqueues: 0,
  catalogEvaluations: 0,
  catalogEvaluationsByEnqueue: [] as number[],
  deferFirstCatalogEnqueue: false,
  aggregateSettles: 0,
}))
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof React>()
  const writers = new WeakMap()
  return {
    ...react,
    useState(initial: unknown) {
      const [value, dispatch] = react.useState(initial)
      const location = new Error().stack?.split('\n')[2] ?? ''
      const stateLines = (process.env.BUG341_STATE_LINES ?? '429,436').split(',')
      if (!stateLines.some(line => location.includes(`useChatListController.ts:${line}:`))) {
        return [value, dispatch]
      }
      if (!writers.has(dispatch)) {
        writers.set(dispatch, (action: unknown) => {
          const caller = new Error().stack?.split('\n')[2] ?? ''
          if (
            commitTrace.active &&
            caller.includes(`useChatListController.ts:${process.env.BUG341_SETTLE_LINE ?? '2332'}:`)
          ) {
            commitTrace.aggregateSettles++
          }
          const catalogEnqueue =
            commitTrace.active &&
            caller.includes(`useChatListController.ts:${process.env.BUG341_CATALOG_LINE ?? '508'}:`)
          if (!catalogEnqueue || typeof action !== 'function') {
            return dispatch(action)
          }
          const enqueueId = ++commitTrace.catalogEnqueues
          commitTrace.catalogEvaluationsByEnqueue[enqueueId] = 0
          const wrappedAction = (previous: unknown) => {
            commitTrace.catalogEvaluations++
            commitTrace.catalogEvaluationsByEnqueue[enqueueId]++
            return action(previous)
          }
          if (commitTrace.deferFirstCatalogEnqueue && enqueueId === 1) {
            // Keep the real updater pending through the helper's owner replacement.
            commitTrace.deferFirstCatalogEnqueue = false
            react.startTransition(() => dispatch(wrappedAction))
            return
          }
          return dispatch(wrappedAction)
        })
      }
      return [value, writers.get(dispatch)]
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
const fixtures = readBug341Fixture('bug341SessionProducer.json', 'BUG341_PRODUCER_OUTPUT') as any
const terminal = readBug341Fixture(
  'bug341TaskProgressCompleted.json',
  'BUG341_COMPLETION_OUTPUT'
) as any
const expectCandidate = process.env.BUG341_EXPECT_SOURCE !== '1'
const target = 'agent-x'
const sibling = 'agent-y'
const key = 'chat-a'
const laterChat = 'chat-b'
const label = 'Completed, unread'
const unrelated = 'untouched-chat'
type Order = 'before-open' | 'after-open' | 'after-clear' | 'none'
type Result = 'ok' | 'pre-write-reject' | 'post-write-reject'
type Input = {
  order: Order
  result: Result
  mark: boolean
  field: 'true' | 'absent'
  early: boolean
  fieldOmitted: boolean
  cancel: boolean
  commitGap?: boolean
  delayedReply?: boolean
  dual?: Result
  scopeDiscard?: boolean
  sampleLate?: boolean
}
type Model = {
  disk: boolean
  latest: boolean
  sampled: boolean
  sampledPresence: boolean
  accepted: boolean
  marked: boolean
  sibling: boolean
  row: string
}
type Observation = {
  disk: boolean
  latest: boolean
  sibling: boolean
  selected: boolean | undefined
  field: boolean | undefined
  calls: string[]
  replies: string[]
  requests: Record<string, number>
}
type Pending = { name: string; release: () => void; finished: Promise<unknown> }
type InterStep = 'index' | 'target' | 'mark' | 'repeat' | 'replace' | 'settle'
type InterConfig = {
  steps: InterStep[]
  result: Result
  replace: boolean
  commandSeed?: number
  executed?: InterStep[]
  earlySettle?: boolean
}
type Boundary = 'discard' | 'replay' | 'interrupt'
type Step = 'refresh' | 'open' | 'clear-reply' | 'index-replies'
type Trace = {
  order: Order
  opened: boolean
  clear: boolean
  index: boolean
  early: boolean
}
type Driver = Record<Step, () => Promise<void>>

class Event implements fc.AsyncCommand<Trace, Driver> {
  constructor(private readonly step: Step) {}
  check(trace: Readonly<Trace>) {
    switch (this.step) {
      case 'refresh':
        return trace.order === 'none'
      case 'open':
        return !trace.opened
      case 'clear-reply':
        return trace.opened && !trace.clear
      case 'index-replies':
        return trace.order !== 'none' && !trace.index
    }
  }
  async run(trace: Trace, driver: Driver) {
    switch (this.step) {
      case 'refresh':
        trace.order = trace.clear ? 'after-clear' : trace.opened ? 'after-open' : 'before-open'
        break
      case 'open':
        trace.opened = true
        break
      case 'clear-reply':
        trace.clear = true
        break
      case 'index-replies':
        trace.index = true
        trace.early = !trace.clear
        break
    }
    await driver[this.step]()
  }
  toString() {
    return this.step
  }
}
type Sequence = Iterable<fc.AsyncCommand<Trace, Driver>>
const steps: Step[] = ['refresh', 'open', 'clear-reply', 'index-replies']

const seed = {
  order: 'before-open',
  result: 'ok',
  mark: false,
  field: 'true',
  early: false,
  fieldOmitted: false,
  cancel: false,
} satisfies Input
// Independent reference. One existing unread fact for each exact identity. Reads
// sample the current native fact; an accepted acknowledgment clears; a later real hidden completion in an
// eligible overlapping represented row wins independently of clear success.
function expected(input: Input): Model {
  const initial = input.field === 'true' || !!input.dual
  const wroteClear =
    input.result !== 'pre-write-reject' || (!!input.dual && input.dual !== 'pre-write-reject')
  const accepted = input.result === 'ok' || input.dual === 'ok'
  const eligible = input.order === 'before-open' || input.order === 'after-open'
  const sampled = input.order === 'after-clear' && wroteClear ? false : initial
  const sampledPresence = !input.fieldOmitted
  const markWins = input.mark && eligible && sampledPresence && !input.cancel
  const disk = input.mark || (initial && !wroteClear)
  const latest = input.scopeDiscard
    ? true
    : input.cancel
      ? disk
      : !sampledPresence && eligible
        ? false
        : markWins || (!accepted && sampled)
  const row = input.scopeDiscard
    ? '6/discard'
    : input.cancel
      ? '6/11'
      : input.fieldOmitted
        ? '8c'
        : input.commitGap
          ? '13'
          : input.mark && eligible
            ? input.early
              ? '5/8b/8d'
              : '8e'
            : input.mark
              ? 'settled control'
              : input.order === 'after-clear'
                ? '14'
                : input.order === 'after-open'
                  ? '4b'
                  : input.order === 'before-open'
                    ? '2–4'
                    : '1/7/12'
  return {
    disk,
    latest,
    sampled,
    sampledPresence,
    accepted,
    marked: input.mark,
    sibling: true,
    row,
  }
}
const exact = (node: HTMLElement, agent: string, chat = key) =>
  node.querySelector<HTMLElement>(
    `[data-testid="latest-session-row"][data-agent-ref="${agent}"][data-chat-id="${chat}"]`
  )
const microtaskTurn = () => new Promise<void>(resolve => setImmediate(resolve))

async function observe(
  input: Input,
  scheduler: fc.Scheduler,
  sequence?: Sequence,
  inter?: InterConfig,
  boundary?: Boundary
): Promise<Observation & { input: Input }> {
  const clerum = installMockClerum()
  const scratchRoots: string[] = []
  const newStore = (prefix: string) => {
    const root = mkdtempSync(join(bug341ScratchRoot(), prefix))
    scratchRoots.push(root)
    return new ChatStore(root)
  }
  const store = newStore('matrix-')
  let readStore = store
  const sameAgentControl = !!inter || (input.order === 'none' && !input.mark && !sequence)
  const pending = new Map<Promise<unknown>, string>()
  const rejections: Array<{ name: string; error: unknown }> = []
  const scheduled: Pending[] = []
  const calls: string[] = []
  let controller: ReturnType<typeof renderController> | undefined
  let nav: ReturnType<typeof render> | undefined
  let suspendControllerRender = false
  let controllerRenderSuspensions = 0
  let releaseControllerRender!: () => void
  const controllerRenderGate = new Promise<void>(resolve => {
    releaseControllerRender = resolve
  })
  let holdIndex = false
  let holdCatalog = false
  const clock = Date.now.bind(Date)
  let offset = 0
  const date = vi.spyOn(Date, 'now').mockImplementation(() => clock() + offset)
  const holdClear = true
  let captured = 0
  let catalogIpc = 0
  let targetClears = 0
  let seedFsm = !!input.dual
  let fulfilledClears = 0
  let markCompleted = 0
  let commitGapSeen = false
  let beforeCatalogCommit: unknown
  let readGroupStarted = false
  let refreshGroups = 0
  let switchWork: Promise<void> | undefined
  const timeouts = new Map<ReturnType<typeof setTimeout>, () => void>()
  const frames = new Map<number, FrameRequestCallback>()
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  let nextFrame = 0
  const rejected = new Error('fixture clear failed')
  const needsDualFailureBaseline =
    input.order === 'after-clear' && !!input.dual && input.result !== 'ok' && input.dual !== 'ok'
  const needsMixedClearBaseline =
    process.env.BUG341_G2_MIXED_CLEAR_BOUNDARY === '1' &&
    !!input.dual &&
    (input.result === 'ok') !== (input.dual === 'ok')
  const observerRejections: unknown[] = []
  const captureObserverRejection = (reason: unknown) => observerRejections.push(reason)
  process.on('unhandledRejection', captureObserverRejection)
  const http = new RpcProxyClient(() => 'https://example.test')
  const fetch = input.fieldOmitted
    ? vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => new Response(JSON.stringify(fixtures.history)))
    : undefined
  // Own every animation frame scheduled by this mount, including the two-frame
  // first-paint callback, instead of assuming returned IPC promises are exhaustive.
  const actualTrace: string[] = []
  const requests: Record<string, number> = {}
  const frameSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  const cancelFrame = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => {
    frames.delete(id)
  })
  // Track the paired actual first-paint fallback. Other fixture servers stay out of
  // this mount; tracker timer removal is checked via terminal and subscription teardown.
  const timeoutSpy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation((callback: any, timeout?: number, ...args: any[]) => {
      if (!new Error().stack?.includes('scheduleAfterFirstPaint'))
        return originalSetTimeout(callback, timeout, ...args)
      const id = originalSetTimeout(() => {
        timeouts.delete(id)
        callback(...args)
      }, timeout)
      timeouts.set(id, () => {
        originalClearTimeout(id)
        timeouts.delete(id)
        callback(...args)
      })
      return id
    })
  const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(id => {
    timeouts.delete(id as ReturnType<typeof setTimeout>)
    originalClearTimeout(id)
  })
  const drain = async () => {
    const deadline = clock() + 3000
    while (clock() < deadline) {
      if (frames.size) {
        const next = [...frames.values()]
        frames.clear()
        await act(async () => {
          next.forEach(frame => frame(Date.now()))
        })
        continue
      }
      if (pending.size || timeouts.size) {
        // No promise awaited here may depend on a gate which has not been released.
        await new Promise(resolve => originalSetTimeout(resolve, 1))
        continue
      }
      // No callbacks were left queued by the known producers. Flush React and the
      // next host turn, then check again before sampling the mounted DOM.
      await act(async () => {
        await microtaskTurn()
      })
      if (!pending.size && !frames.size && !timeouts.size) return
    }
    throw new Error(
      `Undrained producer: ${[...pending.values()]} frames=${frames.size} paint=${timeouts.size}`
    )
  }
  function gate<T>(name: string, work: () => Promise<T>): Promise<T> {
    let release!: () => void
    const start = new Promise<void>(resolve => {
      release = resolve
    })
    const answer = start.then(() => {
      const native = work()
      // Register the real rejection immediately even if fast-check has not
      // selected that response yet. The bridge returns the original outcome.
      void native.catch(() => undefined)
      return scheduler.schedule(native, name)
    })
    scheduled.push({ name, release, finished: answer })
    return answer
  }
  async function flushGate(prefix: string, ownsAct = true) {
    const batch = scheduled.filter(item => item.name.startsWith(prefix))
    expect(batch.length, prefix).toBeGreaterThan(0)
    // Scheduler chooses among the released jobs; waitFor can resolve after other
    // ready jobs. Do not expose or wait on still-manually-held gates.
    const release = async () => {
      batch.forEach(item => item.release())
      await Promise.resolve()
      await scheduler.waitAll()
      await Promise.allSettled(batch.map(item => item.finished))
      for (const item of scheduler.report().slice(actualTrace.length))
        actualTrace.push(`${item.label}=${item.status}`)
    }
    if (ownsAct) await act(release)
    else await release()
    batch.forEach(item => {
      scheduled.splice(scheduled.indexOf(item), 1)
    })
  }
  try {
    if (!input.fieldOmitted) {
      await store.createChat(target, key)
      if (input.field === 'true') await store.markUnreadTerminal(target, key)
    }
    await store.createChat(target, laterChat)
    if (sameAgentControl) {
      await store.createChat(target, unrelated)
      await store.markUnreadTerminal(target, unrelated)
    }
    await store.createChat(sibling, key)
    await store.markUnreadTerminal(sibling, key)
    clerum.chat.getIndex.mockImplementation(async agent => {
      calls.push(`index:${agent}`)
      const currentStore = readStore
      if (holdIndex && input.sampleLate && agent === target) {
        return gate(`index:${agent}:late`, () => currentStore.getIndex(agent))
      }
      const index = await currentStore.getIndex(agent)
      if (holdIndex) {
        captured += 1
        return gate(`index:${agent}:${captured}`, async () => index)
      }
      return index
    })
    clerum.chat.loadMessages.mockImplementation((agent, chatId, limit, offset) =>
      store.loadMessages(agent, chatId, limit, offset)
    )
    clerum.chat.create.mockImplementation((agent, chatId) => store.createChat(agent, chatId))
    if (input.fieldOmitted) {
      clerum.rpc.loadSessionMessages.mockImplementation((host, agent, chatId, _, query) =>
        chatId === key
          ? http.loadSessionMessages('fixture-token', host, agent, chatId, query)
          : Promise.resolve({ agent, chatId, turns: [] })
      )
      clerum.chat.replaceMessages.mockImplementation((agent, chatId, messages, options) =>
        store.replaceMessages(agent, chatId, messages, options)
      )
    }
    clerum.chat.appendMessages.mockImplementation(async (agent, chatId, messages) => {
      const result = await store.appendMessages(agent, chatId, messages)
      return result
    })
    clerum.chat.clearUnreadTerminal.mockImplementation((agent, chatId) => {
      calls.push(`clear:${agent}/${chatId}`)
      if (agent !== target || chatId !== key) return store.clearUnreadTerminal(agent, chatId)
      if (seedFsm) return store.clearUnreadTerminal(agent, chatId)
      const clear = ++targetClears
      const result = inter ? inter.result : clear === 1 ? input.result : input.dual
      const write = () =>
        result === 'pre-write-reject' ? Promise.resolve() : store.clearUnreadTerminal(agent, chatId)
      const earlierWrite = input.delayedReply ? write() : undefined
      const work = async () => {
        await (earlierWrite ?? write())
        if (result !== 'ok') throw rejected
        fulfilledClears++
      }
      return holdClear ? gate(`clear:${clear}`, work) : work()
    })
    clerum.chat.markUnreadTerminal.mockImplementation(async (agent, chatId) => {
      calls.push(`mark:${agent}/${chatId}`)
      if (input.commitGap && agent === target && chatId === key) {
        commitGapSeen = controller!.result.current.latestChatSessions === beforeCatalogCommit
      }
      await store.markUnreadTerminal(agent, chatId)
      if (agent === target && chatId === key) markCompleted++
    })
    clerum.rpc.listSessions.mockImplementation((host, _unused, query) => {
      catalogIpc++
      calls.push(`catalog:${host}:${query?.limit}`)
      const reply = async () =>
        parseSessionsListResult(
          (input.commitGap && offset > 0) || (input.scopeDiscard && readStore !== store)
            ? fixtures.empty
            : fixtures[host]
        )
      return holdCatalog ? gate(`catalog:${host}`, reply) : reply()
    })
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'fixture-completion' })
    for (const [group, methods] of Object.entries({ chat: clerum.chat, rpc: clerum.rpc })) {
      for (const [method, fn] of Object.entries(methods)) {
        if (!vi.isMockFunction(fn)) continue
        const original = fn.getMockImplementation()
        if (!original) continue
        fn.mockImplementation((...args: any[]) => {
          const name = `${group}.${method}`
          requests[name] = (requests[name] ?? 0) + 1
          const value = original(...args)
          if (value && typeof value.then === 'function') {
            const promise = Promise.resolve(value)
            pending.set(promise, name)
            void promise.then(
              () => pending.delete(promise),
              error => {
                rejections.push({ name, error })
                pending.delete(promise)
              }
            )
          }
          return value
        })
      }
    }
    controller = renderController(
      { selectedAgent: target, agentNames: [target, sibling] },
      {
        strictMode: boundary === 'replay',
        suspenseBoundary: boundary === 'interrupt',
        onRender: () => {
          if (boundary === 'interrupt' && suspendControllerRender) {
            controllerRenderSuspensions++
            throw controllerRenderGate
          }
        },
      }
    )
    const current = () => controller!.result.current
    sidebar.current = () => ({
      ...current(),
      selectedAgent: target,
      handleSelectChatAgent: (agent: string, item: { chatId: string }) => {
        switchWork = current().switchToChat(agent, item.chatId)
      },
    })
    nav = render(<SidebarNav {...props} />)
    const repaint = () => nav!.rerender(<SidebarNav {...props} />)
    const open = async (chat = key) => {
      repaint()
      const row = exact(nav!.container, target, chat)
      expect(row, `open ${chat}`).not.toBeNull()
      fireEvent.click(within(row!).getByRole('button', { name: /^Open / }))
      const work = switchWork
      expect(work).toBeDefined()
      await act(async () => {
        await work
      })
      switchWork = undefined
    }
    // Initial local + catalog publication, with genuine server-only marker.
    await waitFor(() =>
      expect(current().latestChatSessions.some(row => row.id === 'catalog-probe')).toBe(true)
    )
    await drain()
    repaint()
    if (boundary === 'discard') {
      const view = {
        row: (agent: string, chat: string) => exact(nav!.container, agent, chat),
        drainCommittedWork: async () => {
          await act(async () => {
            await microtaskTurn()
          })
          repaint()
        },
      }
      commitTrace.active = true
      commitTrace.catalogEnqueues = 0
      commitTrace.catalogEvaluations = 0
      commitTrace.catalogEvaluationsByEnqueue = []
      commitTrace.deferFirstCatalogEnqueue = true
      commitTrace.aggregateSettles = 0
      await open()
      await waitFor(() => expect(targetClears).toBe(1))
      await waitFor(async () =>
        expect(
          (await store.getIndex(target)).chats.find(row => row.id === key)?.unreadTerminal
        ).toBe(false)
      )
      await refresh(true)
      await waitFor(() =>
        expect(scheduled.filter(item => item.name.startsWith('index:'))).toHaveLength(2)
      )
      await checkDiscard(
        view,
        async () => {
          await flushGate('index:', false)
          const deadline = clock() + 1000
          while (commitTrace.catalogEnqueues < 1 && clock() < deadline) {
            await new Promise(resolve => originalSetTimeout(resolve, 1))
          }
          expect(commitTrace.catalogEnqueues).toBe(1)
        },
        () => {
          expect(commitTrace.catalogEnqueues).toBe(1)
          expect(
            within(exact(nav!.container, target)!).queryByRole('status', { name: label })
          ).not.toBeNull()
        },
        async () => {
          holdIndex = true
          readStore = newStore('discard-owner-')
          await readStore.createChat(target, key)
          await readStore.renameChat(target, key, 'New owner target')
          await readStore.markUnreadTerminal(target, key)
          await readStore.createChat(sibling, key)
          await readStore.markUnreadTerminal(sibling, key)
          controller!.rerender({
            currentUserId: 'replacement-owner',
            currentTeamId: 'other-team',
            chatAuthorityTeamId: 'other-team',
          })
        },
        async () => {
          if (scheduled.some(item => item.name.startsWith('clear:')))
            await flushGate('clear:', false)
          await act(async () => {
            await microtaskTurn()
          })
        },
        async steps => {
          await act(steps)
        }
      )
      return {
        disk: true,
        latest: true,
        sibling: true,
        selected: true,
        field: true,
        calls,
        replies: actualTrace,
        requests,
        input,
      }
    }
    if (boundary === 'replay') {
      const view = {
        row: (agent: string, chat: string) => exact(nav!.container, agent, chat),
        drainCommittedWork: async () => {
          await drain()
          repaint()
        },
      }
      commitTrace.active = true
      commitTrace.catalogEnqueues = 0
      commitTrace.catalogEvaluations = 0
      commitTrace.catalogEvaluationsByEnqueue = []
      commitTrace.aggregateSettles = 0
      await open()
      await waitFor(() => expect(targetClears).toBe(1))
      await waitFor(async () =>
        expect(
          (await store.getIndex(target)).chats.find(row => row.id === key)?.unreadTerminal
        ).toBe(false)
      )
      await refresh(true)
      await waitFor(() =>
        expect(scheduled.filter(item => item.name.startsWith('index:'))).toHaveLength(2)
      )
      let publicationEnqueue = 0
      await checkReplay(
        view,
        async () => {
          await flushGate('index:')
          await waitFor(() =>
            expect(scheduled.some(item => item.name === 'catalog:agent-x')).toBe(true)
          )
          const before = commitTrace.catalogEnqueues
          await flushGate('catalog:agent-x')
          publicationEnqueue = commitTrace.catalogEnqueues
          expect(publicationEnqueue).toBeGreaterThan(before)
        },
        async () => {
          await sendAndHide()
          await completeTask(1)
          await flushGate('catalog:agent-y')
          await flushGate('clear:')
        },
        () => commitTrace.catalogEvaluationsByEnqueue[publicationEnqueue] ?? 0
      )
      expect(commitTrace.catalogEvaluationsByEnqueue[publicationEnqueue]).toBeGreaterThanOrEqual(2)
      return {
        disk: true,
        latest: true,
        sibling: true,
        selected: true,
        field: true,
        calls,
        replies: actualTrace,
        requests,
        input,
      }
    }
    expect(!!exact(nav.container, target)?.querySelector(`[aria-label="${label}"]`)).toBe(
      input.field === 'true'
    )
    expect(!!exact(nav.container, sibling)?.querySelector(`[aria-label="${label}"]`)).toBe(true)
    if (boundary === 'interrupt') {
      commitTrace.active = true
      commitTrace.catalogEnqueues = 0
      commitTrace.catalogEvaluations = 0
      commitTrace.catalogEvaluationsByEnqueue = []
      commitTrace.deferFirstCatalogEnqueue = true
      commitTrace.aggregateSettles = 0
      await open()
      await waitFor(() => expect(targetClears).toBe(1))
      await refresh(true)
      await waitFor(() =>
        expect(scheduled.filter(item => item.name.startsWith('index:'))).toHaveLength(2)
      )
      await flushGate('index:')
      await waitFor(() =>
        expect(
          scheduled.filter(item => item.name.startsWith('catalog:')).length
        ).toBeGreaterThanOrEqual(2)
      )
      suspendControllerRender = true
      await flushGate('catalog:')
      await waitFor(() => expect(controllerRenderSuspensions).toBeGreaterThan(0))
      await waitFor(() => expect(commitTrace.aggregateSettles).toBe(1))
      await flushGate('clear:')
      await waitFor(() => expect(fulfilledClears).toBe(1))
      await sendAndHide()
      await completeTask(1)
      suspendControllerRender = false
      releaseControllerRender()
      await act(async () => {
        await microtaskTurn()
      })
      await waitFor(() =>
        expect(
          current().latestChatSessions.find(row => row.agentRef === target && row.id === key)
            ?.unreadTerminal
        ).toBe(true)
      )
      await drain()
      repaint()
      expect((await store.getIndex(target)).chats.find(row => row.id === key)?.unreadTerminal).toBe(
        true
      )
      expect(
        within(exact(nav.container, target)!).queryByRole('status', { name: label })
      ).not.toBeNull()
      expect(
        within(exact(nav.container, sibling)!).queryByRole('status', { name: label })
      ).not.toBeNull()
      return {
        disk: true,
        latest: true,
        sibling: true,
        selected: true,
        field: true,
        calls,
        replies: actualTrace,
        requests,
        input,
      }
    }
    async function refresh(withCatalogGates = input.mark && input.order !== 'none') {
      holdIndex = true
      if (withCatalogGates) {
        // Explicit ordinary cache expiry, identical in candidate and mutation.
        // This is a clock input, not an extra production request or timer.
        offset = 5001
        holdCatalog = true
      }
      // Existing Host release invalidates a held Host's Latest read. Do not add
      // a refresh path. Hold the sibling to preserve the target's exact row.
      controller!.hostAuthority.hold(sibling, 'uncertain')
      controller!.hostAuthority.release(sibling)
      refreshGroups++
      await waitFor(() =>
        expect(scheduled.filter(item => item.name.startsWith('index:'))).toHaveLength(2)
      )
      holdIndex = false
      readGroupStarted = true
    }
    const releaseRead = async () => {
      expect(readGroupStarted).toBe(true)
      await flushGate('index:')
      await waitFor(() => expect(!current().latestChatSessionsLoading).toBe(true))
      if (holdCatalog) {
        await waitFor(() =>
          expect(
            scheduled.filter(item => item.name.startsWith('catalog:')).length
          ).toBeGreaterThanOrEqual(2)
        )
        holdCatalog = false
        if (!inter && !input.early && !input.commitGap) {
          await flushGate('catalog:agent-x')
          await waitFor(() =>
            expect(current().latestChatSessions.some(row => row.id === 'catalog-probe')).toBe(true)
          )
        }
      }
    }
    async function sendAndHide() {
      await act(async () => {
        await current().handleSendAgentMessage('fixture request')
      })
      await waitFor(() => expect(clerum.hasProgressHandler('fixture-completion')).toBe(true))
      await open(laterChat)
    }
    async function completeTask(times: number) {
      await act(async () => {
        clerum.emitTaskProgress('fixture-completion', terminal)
      })
      await waitFor(() => expect(markCompleted).toBe(times))
    }
    if (seedFsm) {
      await open()
      await sendAndHide()
      await completeTask(1)
      await drain()
      if (needsDualFailureBaseline || needsMixedClearBaseline) {
        // The seed terminal is a real later unread mark after the preparation
        // open. Read it through an ordinary Latest refresh before testing the
        // clear outcomes; the correction promises no immediate Latest mark.
        await refresh(false)
        await releaseRead()
        await drain()
        readGroupStarted = false
      }
      seedFsm = false
    }
    if (inter) {
      // A real refresh and successful-open entry precede the generated commands.
      // The commands then choose when to publish local/target data, emit the
      // actual hidden completion, repeat the same open, and replace authority.
      await refresh(true)
      await open()
      await waitFor(() => expect(targetClears).toBe(1))
      await flushGate('clear:')
      const state = {
        index: false,
        target: false,
        mark: false,
        repeat: false,
        replace: false,
        settle: false,
      }
      type State = typeof state
      type InterDriver = Record<InterStep, () => Promise<void>>
      class InterEvent implements fc.AsyncCommand<State, InterDriver> {
        constructor(private name: InterStep) {}
        check(m: Readonly<State>) {
          if (m[this.name] || (m.settle && !(inter!.earlySettle && this.name === 'mark')))
            return false
          if (this.name === 'target') return m.index && !m.replace
          if (this.name === 'replace') return inter!.replace && m.index && m.mark && m.repeat
          if (this.name === 'settle')
            return (
              m.index &&
              m.repeat &&
              (m.target || m.replace) &&
              (!inter!.replace || m.replace) &&
              (inter!.earlySettle ? !m.mark : m.mark)
            )
          return true
        }
        async run(m: State, real: InterDriver) {
          await real[this.name]()
          m[this.name] = true
          inter!.executed!.push(this.name)
        }
        toString() {
          return this.name
        }
      }
      const driver: InterDriver = {
        index: releaseRead,
        target: async () => {
          await flushGate('catalog:agent-x')
        },
        mark: async () => {
          await sendAndHide()
          await completeTask(1)
        },
        repeat: async () => {
          const previous = targetClears
          await open()
          await waitFor(() => expect(targetClears).toBeGreaterThan(previous))
          await flushGate('clear:')
        },
        replace: async () => {
          holdCatalog = false
          readStore = newStore('replacement-owner-')
          await readStore.createChat(target, key)
          await readStore.renameChat(target, key, 'New owner target')
          await readStore.markUnreadTerminal(target, key)
          await readStore.createChat(sibling, key)
          await readStore.markUnreadTerminal(sibling, key)
          controller!.rerender({
            currentUserId: 'replacement-owner',
            currentTeamId: 'other-team',
            chatAuthorityTeamId: 'other-team',
          })
          await waitFor(() =>
            expect(current().latestChatSessions.some(row => row.title === 'New owner target')).toBe(
              true
            )
          )
        },
        settle: async () => {
          if (scheduled.some(item => item.name.startsWith('catalog:'))) await flushGate('catalog:')
          await drain()
        },
      }
      inter.executed = []
      const arbitrary = fc.commands(
        (['index', 'target', 'mark', 'repeat', 'replace', 'settle'] as InterStep[]).map(step =>
          fc.constant(new InterEvent(step))
        ),
        { maxCommands: 18 }
      )
      const commands =
        inter.commandSeed === undefined
          ? inter.steps.map(step => new InterEvent(step))
          : fc.sample(arbitrary, { seed: inter.commandSeed, numRuns: 1 })[0]!
      await fc.asyncModelRun(() => ({ model: state, real: driver }), commands)
      if (inter.commandSeed !== undefined) {
        // Complete the generated prefix with actual commands, then observe only
        // after all controlled producers and React work have settled.
        for (const step of [
          'index',
          'target',
          'mark',
          'repeat',
          'replace',
          'settle',
        ] as InterStep[]) {
          const command = new InterEvent(step)
          if (command.check(state)) await command.run(state, driver)
        }
      }
      expect(state.index && state.mark && state.repeat && state.settle).toBe(true)
      expect(state.replace).toBe(inter.replace)
      expect(state.target || state.replace).toBe(true)
      console.log(
        'BUG341-INTERLEAVE',
        JSON.stringify({
          steps: inter.executed,
          seed: inter.commandSeed,
          result: inter.result,
          replace: inter.replace,
          calls,
          replies: actualTrace,
        })
      )
    } else if (sequence) {
      const trace: Trace = {
        order: 'none',
        opened: false,
        clear: false,
        index: false,
        early: false,
      }
      const driver: Driver = {
        refresh: () => refresh(input.mark),
        open: async () => {
          await open()
          await waitFor(() => expect(targetClears).toBeGreaterThan(0))
        },
        'clear-reply': () => flushGate('clear:'),
        'index-replies': releaseRead,
      }
      await fc.asyncModelRun(() => ({ model: trace, real: driver }), sequence)
      // Bring every generated prefix to a mounted quiescent boundary.
      for (const step of ['open', 'clear-reply', 'index-replies'] as const) {
        const event = new Event(step)
        if (event.check(trace)) await event.run(trace, driver)
      }
      input = { ...input, order: trace.order, early: trace.early }
    } else {
      if (input.order === 'before-open') await refresh()
      await open()
      await waitFor(() => expect(targetClears).toBeGreaterThan(0))
      if (input.order === 'after-open') await refresh()
      if (input.scopeDiscard) {
        readStore = newStore('replacement-owner-')
        await readStore.createChat(target, key)
        await readStore.renameChat(target, key, 'New owner target')
        await readStore.markUnreadTerminal(target, key)
        await readStore.createChat(sibling, key)
        await readStore.markUnreadTerminal(sibling, key)
        controller.rerender({
          currentUserId: 'replacement-owner',
          currentTeamId: 'other-team',
          chatAuthorityTeamId: 'other-team',
        })
        await waitFor(() =>
          expect(current().latestChatSessions.some(row => row.title === 'New owner target')).toBe(
            true
          )
        )
      }
      if (readGroupStarted && input.early) await releaseRead()
      if (needsMixedClearBaseline) {
        repaint()
        expect(
          within(exact(nav.container, target)!).queryByRole('status', { name: label })
        ).not.toBeNull()
        if (input.result === 'pre-write-reject') {
          await flushGate('clear:1')
          repaint()
          expect(fulfilledClears).toBe(0)
          expect(
            within(exact(nav.container, target)!).queryByRole('status', { name: label })
          ).not.toBeNull()
          await flushGate('clear:2')
        } else {
          await flushGate('clear:1')
          repaint()
          expect(fulfilledClears).toBe(1)
          expect(
            within(exact(nav.container, target)!).queryByRole('status', { name: label })
          ).toBeNull()
          await flushGate('clear:2')
        }
        if (input.result === 'pre-write-reject') {
          repaint()
          expect(fulfilledClears).toBe(1)
          expect(
            within(exact(nav.container, target)!).queryByRole('status', { name: label })
          ).toBeNull()
        }
      } else if (!input.delayedReply) {
        await flushGate('clear:')
      }
      if (
        input.order === 'after-clear' &&
        input.dual &&
        input.result !== 'ok' &&
        input.dual !== 'ok'
      ) {
        repaint()
        expect(fulfilledClears).toBe(0)
        expect(rejections.filter(e => e.name === 'chat.clearUnreadTerminal')).toHaveLength(2)
        expect(
          within(exact(nav.container, target)!).queryByRole('status', { name: label })
        ).not.toBeNull()
        expect(
          within(exact(nav.container, sibling)!).queryByRole('status', { name: label })
        ).not.toBeNull()
      }
      if (input.order === 'after-clear') await refresh()
      if (readGroupStarted && (!input.early || input.order === 'after-clear')) await releaseRead()
    }
    if (input.mark && !inter) {
      if (input.fieldOmitted) {
        await waitFor(async () => expect((await store.loadMessages(target, key)).length).toBe(2))
      }
      expect(scheduled.some(item => item.name === 'catalog:agent-y')).toBe(input.order !== 'none')
      await sendAndHide()
      if (input.commitGap) {
        expect(current().latestChatSessions.some(row => row.id === 'catalog-probe')).toBe(false)
        const before = clerum.chat.reconcileServerSessions.mock.calls.length
        commitTrace.active = true
        commitTrace.catalogEnqueues = 0
        commitTrace.aggregateSettles = 0
        commitTrace.catalogEvaluations = 0
        beforeCatalogCommit = current().latestChatSessions
        await act(async () => {
          await flushGate('catalog:', false)
          for (let i = 0; i < 16; i++) await Promise.resolve()
          expect(clerum.chat.reconcileServerSessions.mock.calls.length).toBeGreaterThanOrEqual(
            before + 2
          )
          expect(commitTrace.aggregateSettles).toBe(1)
          expect(commitTrace.catalogEnqueues).toBeGreaterThanOrEqual(2)
          const enqueuesBeforeMark = commitTrace.catalogEnqueues
          clerum.emitTaskProgress('fixture-completion', terminal)
          const markDeadline = clock() + 1000
          while (markCompleted === 0 && clock() < markDeadline) {
            await new Promise(resolve => originalSetTimeout(resolve, 1))
          }
          expect(markCompleted).toBe(1)
          expect(commitGapSeen).toBe(true)
          console.log(
            'BUG341-COMMIT-GAP',
            JSON.stringify({
              settled: commitTrace.aggregateSettles,
              enqueuesBeforeMark,
              evaluationsAtCommit: commitTrace.catalogEvaluations,
              committedBeforeMark: !commitGapSeen,
            })
          )
        })
      } else {
        await completeTask(1)
        if (input.order !== 'none') await flushGate('catalog:')
      }
      if (input.delayedReply) await flushGate('clear:')
    }
    if (input.cancel) {
      controller.hostAuthority.hold(sibling, 'uncertain')
      controller.hostAuthority.release(sibling)
      // A newer ordinary refresh must read the disk fact without inheriting the
      // previous eligible batch's events.
      await waitFor(() => expect(calls.filter(call => call === 'index:agent-y')).toHaveLength(3))
    }
    await drain()
    repaint()
    expect(scheduled).toEqual([])
    expect(scheduler.count()).toBe(0)
    if (inter) {
      expect(targetClears).toBe(
        inter.executed!.indexOf('mark') < inter.executed!.indexOf('repeat') ? 3 : 2
      )
      expect(fulfilledClears).toBe(inter.result === 'ok' ? targetClears : 0)
      expect(rejections.filter(item => item.name === 'chat.clearUnreadTerminal')).toHaveLength(
        inter.result === 'ok' ? 0 : targetClears
      )
    } else {
      expect(targetClears).toBe(input.dual ? 2 : 1)
      const outcomes = input.dual ? [input.result, input.dual] : [input.result]
      expect(fulfilledClears).toBe(outcomes.filter(result => result === 'ok').length)
      expect(rejections).toEqual(
        outcomes
          .filter(result => result !== 'ok')
          .map(() => ({ name: 'chat.clearUnreadTerminal', error: rejected }))
      )
      const newCatalog =
        (input.order !== 'none' && (input.mark || input.dual)) ||
        input.scopeDiscard ||
        needsMixedClearBaseline
      expect(catalogIpc).toBe(newCatalog ? 4 : 2)
      const reloads = refreshGroups + Number(input.cancel) + Number(!!input.scopeDiscard)
      expect(calls.filter(call => call === 'index:agent-y')).toHaveLength(1 + reloads)
      expect(calls.filter(call => call === 'clear:agent-x/chat-a')).toHaveLength(input.dual ? 3 : 1)
      expect(calls.filter(call => call === 'mark:agent-x/chat-a')).toHaveLength(
        Number(input.mark) + Number(!!input.dual)
      )
    }
    const rows = current().latestChatSessions
    expect(rows.filter(row => row.agentRef === target && row.id === key)).toHaveLength(1)
    const observedRow = rows.find(row => row.agentRef === target && row.id === key)
    const targetRow = exact(nav.container, target)
    expect(targetRow).not.toBeNull()
    if (input.scopeDiscard || inter?.replace) {
      expect(observedRow?.title).toBe('New owner target')
      expect((await readStore.getIndex(target)).chats[0]?.unreadTerminal).toBe(true)
    }
    if (sameAgentControl && !inter?.replace) {
      expect(
        within(exact(nav.container, target, unrelated)!).queryByRole('status', { name: label })
      ).not.toBeNull()
      expect(
        (await store.getIndex(target)).chats.find(row => row.id === unrelated)?.unreadTerminal
      ).toBe(true)
    }
    if (process.env.BUG341_G2_REQUEST_BASELINE && !inter) {
      const gold = JSON.parse(readFileSync(process.env.BUG341_G2_REQUEST_BASELINE, 'utf8'))
      const expectedRequests = gold[JSON.stringify(input)]
      if (expectedRequests) expect(requests).toEqual(expectedRequests)
    }
    if (inter) {
      const id = JSON.stringify({
        steps: inter.executed,
        result: inter.result,
        replace: inter.replace,
        earlySettle: !!inter.earlySettle,
      })
      console.log('BUG341-INTER-REQUESTS', JSON.stringify({ id, requests }))
      if (process.env.BUG341_INTER_REQUEST_BASELINE) {
        const baseline = JSON.parse(readFileSync(process.env.BUG341_INTER_REQUEST_BASELINE, 'utf8'))
        expect(requests).toEqual(baseline[id])
      }
    }
    if (process.env.BUG341_CAPTURE_REQUEST_BASELINE === '1' && !inter) {
      process.stdout.write(`G2-PARITY-BASELINE ${JSON.stringify({ input, requests })}\n`)
    }
    return {
      disk:
        (await store.getIndex(target)).chats.find(row => row.id === key)?.unreadTerminal === true,
      latest: !!within(targetRow!).queryByRole('status', { name: label }),
      sibling: !!within(exact(nav.container, sibling)!).queryByRole('status', { name: label }),
      selected: current().chatList.find(row => row.id === key)?.unreadTerminal,
      field: observedRow?.unreadTerminal,
      calls,
      replies: actualTrace,
      requests,
      input,
    }
  } catch (error) {
    console.error('BUG341 scenario failed', JSON.stringify(input), error)
    throw error
  } finally {
    commitTrace.active = false
    commitTrace.deferFirstCatalogEnqueue = false
    holdIndex = false
    holdCatalog = false
    for (let round = 0; scheduled.length && round < 8; round++) {
      const batch = [...scheduled]
      await act(async () => {
        batch.forEach(item => item.release())
        await Promise.resolve()
        await scheduler.waitAll()
        await Promise.allSettled(batch.map(item => item.finished))
      })
      batch.forEach(item => {
        const index = scheduled.indexOf(item)
        if (index >= 0) scheduled.splice(index, 1)
      })
      await microtaskTurn()
    }
    expect(scheduled).toEqual([])
    await drain()
    nav?.unmount()
    controller?.tracker.releaseAll()
    controller?.unmount()
    await drain()
    try {
      await new Promise(resolve => originalSetTimeout(resolve, 0))
      expect(observerRejections).toEqual(
        rejections.filter(item => item.name === 'chat.clearUnreadTerminal').map(item => item.error)
      )
      expect(clerum.hasProgressHandler('fixture-completion')).toBe(false)
    } finally {
      process.off('unhandledRejection', captureObserverRejection)
    }
    fetch?.mockRestore()
    date.mockRestore()
    frameSpy.mockRestore()
    cancelFrame.mockRestore()
    timeoutSpy.mockRestore()
    clearTimeoutSpy.mockRestore()
    cleanup()
    uninstallMockClerum()
    scratchRoots.forEach(root =>
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    )
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  uninstallMockClerum()
})

const baseMatrix = [
  { ...seed, order: 'none' },
  seed,
  { ...seed, early: true },
  { ...seed, order: 'after-open' },
  { ...seed, order: 'after-open', early: true },
  { ...seed, order: 'after-open', result: 'pre-write-reject' },
  { ...seed, order: 'after-clear', result: 'post-write-reject' },
  { ...seed, order: 'after-clear', result: 'pre-write-reject' },
  { ...seed, order: 'after-clear' },
  { ...seed, order: 'none', field: 'absent', mark: true },
  { ...seed, field: 'absent', mark: true },
  { ...seed, field: 'absent', mark: true, early: true },
  { ...seed, field: 'absent', mark: true, fieldOmitted: true },
  { ...seed, field: 'absent', mark: true, delayedReply: true },
  { ...seed, field: 'absent', mark: true, commitGap: true },
  { ...seed, mark: true },
  { ...seed, order: 'none', result: 'pre-write-reject', dual: 'ok' },
  { ...seed, order: 'none', result: 'ok', dual: 'pre-write-reject' },
  { ...seed, order: 'after-clear', result: 'pre-write-reject', dual: 'pre-write-reject' },
  { ...seed, order: 'after-clear', result: 'post-write-reject', dual: 'post-write-reject' },
  { ...seed, order: 'after-open', cancel: true },
  { ...seed, order: 'after-open', scopeDiscard: true },
  { ...seed, sampleLate: true, early: true },
  { ...seed, field: 'absent', mark: true, result: 'pre-write-reject' },
  { ...seed, field: 'true', mark: true, result: 'pre-write-reject' },
  { ...seed, field: 'absent', mark: true, result: 'pre-write-reject', dual: 'pre-write-reject' },
  { ...seed, field: 'absent', mark: true, result: 'pre-write-reject', delayedReply: true },
  { ...seed, field: 'absent', mark: true, result: 'post-write-reject', delayedReply: true },
] satisfies Input[]

it('compares scheduled real-hook and rendered row outcomes with the independent contract', async () => {
  const red = new Set<string>()
  const coverage = new Map<string, number>()
  if (process.env.BUG341_G2_REQUEST_BASELINE) {
    const gold = JSON.parse(readFileSync(process.env.BUG341_G2_REQUEST_BASELINE, 'utf8'))
    expect(Object.keys(gold).sort()).toEqual(baseMatrix.map(input => JSON.stringify(input)).sort())
  }
  async function check(input: Input, scheduler: fc.Scheduler, sequence?: Sequence) {
    const seen = await observe(input, scheduler, sequence)
    input = seen.input
    const model = expected(input)
    expect(seen.sibling).toBe(model.sibling)
    if (expectCandidate) {
      expect(seen.latest, JSON.stringify(input)).toBe(model.latest)
    }
    expect(seen.disk).toBe(model.disk)
    if (input.fieldOmitted || (input.field === 'absent' && !model.latest))
      expect(seen.field).toBeUndefined()
    if (input.mark) expect(seen.selected).toBe(true)
    if (!input.mark && !input.scopeDiscard && !input.cancel) expect(seen.selected).not.toBe(true)
    const expectedSourceRed =
      (input.field === 'true' &&
        model.accepted &&
        input.order !== 'after-clear' &&
        !input.cancel &&
        !input.scopeDiscard &&
        !input.mark) ||
      (input.field === 'absent' &&
        input.mark &&
        (input.order === 'before-open' || input.order === 'after-open') &&
        !input.fieldOmitted &&
        !input.dual)
    if (expectCandidate) return
    if (seen.latest !== model.latest) {
      expect(expectedSourceRed, JSON.stringify({ input, model, seen })).toBe(true)
      red.add(model.row)
    } else {
      expect(expectedSourceRed, JSON.stringify({ input, model, seen })).toBe(false)
    }
    coverage.set(model.row, (coverage.get(model.row) ?? 0) + 1)
    console.log(
      'BUG341',
      JSON.stringify({
        input,
        expectedBadge: model.latest,
        actualBadge: seen.latest,
        calls: seen.calls,
        replies: seen.replies,
        requests: seen.requests,
        row: model.row,
      })
    )
  }
  const caseIndex = process.env.BUG341_CASE
  const matrix = caseIndex === undefined ? baseMatrix : [baseMatrix[Number(caseIndex)]!]
  for (const input of matrix) {
    await check(input, fc.sample(fc.scheduler(), { seed: 34129, numRuns: 1 })[0]!)
  }
  if (caseIndex !== undefined) return
  const commands = fc.commands(
    steps.map(step => fc.constant(new Event(step))),
    { maxCommands: 14 }
  )
  await fc.assert(
    fc.asyncProperty(
      commands,
      fc.scheduler(),
      fc.boolean(),
      fc.constantFrom<Result>('ok', 'pre-write-reject'),
      async (sequence, scheduler, mark, result) => {
        await check(
          mark ? { ...seed, mark, field: 'absent', result } : { ...seed, result },
          scheduler,
          sequence
        )
      }
    ),
    { seed: 34129, numRuns: 36, endOnFailure: true }
  )
  if (expectCandidate) return
  expect([...red].sort()).toEqual(['1/7/12', '13', '2–4', '4b', '5/8b/8d', '8e'])
  expect(coverage.get('settled control')).toBeGreaterThan(0)
  expect(coverage.get('14')).toBeGreaterThan(2)
  console.log('BUG341-COVERAGE', JSON.stringify(Object.fromEntries(coverage)))
}, 60000)

it('interleaves actual later mark and repeated open with stale publications', async () => {
  const scenarios: InterConfig[] = [
    { steps: ['index', 'target', 'repeat', 'mark', 'settle'], result: 'ok', replace: false },
    {
      steps: ['index', 'target', 'repeat', 'settle', 'mark'],
      result: 'ok',
      replace: false,
      earlySettle: true,
    },
    { steps: ['mark', 'repeat', 'index', 'target', 'settle'], result: 'ok', replace: false },
    {
      steps: ['repeat', 'mark', 'index', 'target', 'settle'],
      result: 'pre-write-reject',
      replace: false,
    },
    {
      steps: ['index', 'mark', 'target', 'repeat', 'replace', 'settle'],
      result: 'pre-write-reject',
      replace: true,
    },
    {
      steps: ['mark', 'index', 'repeat', 'replace', 'target', 'settle'],
      result: 'ok',
      replace: true,
    },
  ]
  // Exhaust the bounded issue-order classes rather than assuming 32 generated
  // samples cover their cross product. A target catalog cannot publish before
  // its local-index aggregate releases; scope replacement can discard it.
  const permutations = <T,>(xs: T[]): T[][] =>
    xs.length === 0
      ? [[]]
      : xs.flatMap((x, i) =>
          permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(rest => [x, ...rest])
        )
  for (const order of permutations<InterStep>(['index', 'target', 'mark', 'repeat'])) {
    if (order.indexOf('index') > order.indexOf('target')) continue
    for (const result of ['ok', 'pre-write-reject'] as Result[]) {
      for (const replace of [false, true]) {
        scenarios.push({
          steps: [...order, ...(replace ? ['replace' as const] : []), 'settle'],
          result,
          replace,
        })
      }
    }
  }
  for (const order of permutations<InterStep>(['index', 'mark', 'repeat'])) {
    for (const result of ['ok', 'pre-write-reject'] as Result[]) {
      scenarios.push({ steps: [...order, 'replace', 'target', 'settle'], result, replace: true })
    }
  }
  for (let i = 0; i < 32; i++)
    scenarios.push({
      steps: [],
      commandSeed: 341300 + i,
      result: i % 2 ? 'pre-write-reject' : 'ok',
      replace: (i & 2) !== 0,
    })
  const coverage = new Set<string>()
  const selected = process.env.BUG341_INTER_CASE
  for (const inter of selected === undefined ? scenarios : [scenarios[Number(selected)]!]) {
    const input = { ...seed, field: 'absent', mark: true } satisfies Input
    const seen = await observe(
      input,
      fc.sample(fc.scheduler(), { seed: inter.commandSeed ?? 127341, numRuns: 1 })[0]!,
      undefined,
      inter
    )
    const repeatAfterMark = inter.executed!.indexOf('repeat') > inter.executed!.indexOf('mark')
    const finalUnread = !(repeatAfterMark && inter.result === 'ok')
    const steps = inter.executed!
    coverage.add(
      `mark-${steps.indexOf('mark') < steps.indexOf('index') ? 'before' : 'after'}-index`
    )
    coverage.add(`repeat-${repeatAfterMark ? 'after' : 'before'}-mark`)
    coverage.add(
      `target-${steps.includes('target') ? (steps.indexOf('target') < steps.indexOf('mark') ? 'before' : 'after') : 'discarded'}-mark`
    )
    coverage.add(`${inter.result}-${inter.replace}`)
    expect(seen.disk).toBe(finalUnread)
    expect(seen.sibling).toBe(true)
    if (!inter.replace) {
      expect(seen.selected).toBe(!repeatAfterMark)
      // Baseline lacks C1/C2 Latest projection. Candidate is compared with the
      // independent issue-order contract, including all-rejected clears.
      expect(seen.latest).toBe(expectCandidate && !inter.earlySettle ? finalUnread : false)
    } else {
      expect(seen.latest).toBe(true)
    }
  }
  if (selected !== undefined) return
  for (const item of [
    'mark-before-index',
    'mark-after-index',
    'repeat-before-mark',
    'repeat-after-mark',
    'target-before-mark',
    'target-after-mark',
    'target-discarded-mark',
    'ok-true',
    'ok-false',
    'pre-write-reject-true',
    'pre-write-reject-false',
  ])
    expect(coverage.has(item), item).toBe(true)
  console.log('BUG341-INTERLEAVE-COVERAGE', JSON.stringify([...coverage].sort()))
}, 120000)

it('discards a queued stale local projection after same-key owner replacement', async () => {
  await observe(
    { ...seed, field: 'true', mark: true, delayedReply: true },
    fc.sample(fc.scheduler(), { seed: 3412101, numRuns: 1 })[0]!,
    undefined,
    undefined,
    'discard'
  )
}, 30000)

it('replays the identified target publication under StrictMode and preserves a later hidden mark', async () => {
  await observe(
    { ...seed, mark: true, delayedReply: true },
    fc.sample(fc.scheduler(), { seed: 3412102, numRuns: 1 })[0]!,
    undefined,
    undefined,
    'replay'
  )
}, 30000)

it('keeps an evaluated interrupted publication live through settlement and replay', async () => {
  await observe(
    { ...seed, field: 'absent', mark: true },
    fc.sample(fc.scheduler(), { seed: 3412103, numRuns: 1 })[0]!,
    undefined,
    undefined,
    'interrupt'
  )
}, 30000)
