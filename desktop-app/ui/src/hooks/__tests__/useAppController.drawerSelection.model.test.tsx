// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import fc, { type AsyncCommand, type Scheduler } from 'fast-check'
import { AGENT_WORKSPACE_ROUTES, DESKTOP_ROUTES } from '@constants/navigation'
import type { AccessCatalog } from '../../../../src/types'
import { byUpdatedDesc } from '../../lib/catalogMerge'
import {
  HARNESS_ME,
  installAppControllerClerum,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import {
  type AppUnderTest,
  bootApp,
  errorToasts,
  gfsPreview,
  messageIdFor,
  routeIndexThroughStore,
  seedChats,
} from '../domain/__tests__/__fixtures__/drawerSelectionFixtures'
import { type MockClerum, uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Model-based oracle for the drawer's conversation selection.
 *
 * Generated sequences of user gestures run against the real app controller
 * (only `window.clerum` is mocked) while `fc.scheduler()` decides when each
 * chat index read, last-active write, transcript read and team switch
 * resolves. Non-chat tab changes land inside every await of the selection
 * flow (list read, latest/specific/implicit opening, team switch), and so does
 * a same-agent drawer pick while a team switch is pending. Every other gesture
 * first lets the scheduler drain: a selection that lands inside another
 * selection's await is decided by run cancellation and intent revisions, which
 * a trivial reference cannot express and other suites pin. At rest the
 * controller must agree with a deliberately trivial reference:
 *
 * - a change between two non-chat tabs changes nothing;
 * - an explicit pick shows that chat;
 * - a selection boundary (entering or leaving chat, another agent, another
 *   team) replays the agent's pending request — a concrete chat, its latest
 *   chat, or nothing — and without one shows the latest chat in chat and
 *   nothing elsewhere;
 * - a team switch forgets every request for a concrete chat.
 *
 * A request for the already-selected agent with no chat (drawer "latest" or
 * "new chat", opening the agent workspace) is not replayed until the next
 * boundary; the reference records it exactly like that.
 */

const AGENTS = ['agent-x', 'agent-y'] as const
type Agent = (typeof AGENTS)[number]
const CHATS: Record<Agent, string[]> = { 'agent-x': ['x-1', 'x-2'], 'agent-y': ['y-1', 'y-2'] }
const TEAMS = ['team-a', 'team-b'] as const

type Pending = { mode: 'specific'; chatId: string } | { mode: 'latest' } | { mode: 'none' }

interface Model {
  tab: 'chat' | 'other'
  picker: boolean
  selectedAgent: Agent
  team: string
  visible: string | null
  pending: Partial<Record<Agent, Pending>>
  teamSwitchInFlight: boolean
}

interface Real {
  app: AppUnderTest
  clerum: MockClerum
  scheduler: Scheduler
  latest: Record<Agent, string>
  failNextOpen: boolean
  rejectedOpens: number
  teamSwitches: Promise<unknown>[]
}

const isChat = (model: Model) => model.tab === 'chat' && !model.picker

/** The selection effect re-ran for `model.selectedAgent`: replay its request. */
function replay(model: Model, latest: Record<Agent, string>) {
  const agent = model.selectedAgent
  const request = model.pending[agent]
  delete model.pending[agent]
  if (request?.mode === 'specific') model.visible = request.chatId
  else if (request?.mode === 'latest') model.visible = latest[agent]
  else if (request?.mode === 'none') model.visible = null
  else model.visible = isChat(model) ? latest[agent] : null
}

/** Applies a gesture's writes, then replays when it crossed a selection boundary. */
function transition(
  model: Model,
  real: Real,
  change: (model: Model) => void,
  options: { forceReplay?: boolean } = {}
) {
  const wasChat = isChat(model)
  const agentBefore = model.selectedAgent
  change(model)
  if (options.forceReplay || wasChat !== isChat(model) || agentBefore !== model.selectedAgent) {
    replay(model, real.latest)
  }
}

function catalogListing(teamId: string): AccessCatalog {
  const agents = [...AGENTS]
  return {
    userId: HARNESS_ME.id,
    teamId,
    userContextIds: [],
    userAgentNames: [],
    teamContextIds: [],
    teamAgentNames: agents,
    contextIds: [],
    agentNames: agents,
    mcpServersByAgent: {},
    agentContextByName: Object.fromEntries(agents.map(agent => [agent, null])),
    agentProviderByName: Object.fromEntries(agents.map(agent => [agent, null])),
    agentDisplayByName: Object.fromEntries(agents.map(agent => [agent, agent])),
  }
}

const expectedRoute = (model: Model) => {
  if (model.picker) return DESKTOP_ROUTES.apps
  return model.tab === 'chat' ? DESKTOP_ROUTES.chat : undefined
}

function chatIpcCalls(clerum: MockClerum) {
  return (
    clerum.chat.getIndex.mock.calls.length +
    clerum.chat.setLastActive.mock.calls.length +
    clerum.chat.loadMessages.mock.calls.length
  )
}

/** Resolves every scheduled IPC call and team switch, including the ones they start. */
async function drain(real: Real) {
  for (let round = 0; round < 30; round += 1) {
    await act(async () => {
      await real.scheduler.waitAll()
    })
    await act(async () => {
      await Promise.allSettled(real.teamSwitches)
    })
    if (real.scheduler.count() === 0) return
  }
  throw new Error('the scheduler did not drain')
}

/** Lets the scheduler resolve up to `releases` pending IPC calls, in its own order. */
async function release(real: Real, releases: number) {
  for (let step = 0; step < releases && real.scheduler.count() > 0; step += 1) {
    await act(async () => {
      await real.scheduler.waitOne()
    })
  }
}

type Cmd = AsyncCommand<Model, Real>

/** A change between two non-chat tabs: no replay and no chat IPC call. */
function nonChatTabCommand(
  label: string,
  gesture: (app: AppUnderTest) => void,
  apply: (model: Model) => void,
  releases: number
): Cmd {
  return {
    check: model => !isChat(model),
    async run(model, real) {
      const calls = chatIpcCalls(real.clerum)
      act(() => gesture(real.app))
      expect(chatIpcCalls(real.clerum), `${label} must not touch chat IPC`).toBe(calls)
      transition(model, real, apply)
      await release(real, releases)
    },
    toString: () => `${label} (release ${releases})`,
  }
}

const releasesArb = fc.integer({ min: 0, max: 2 })

type DrawerPickKind = 'specific-0' | 'specific-1' | 'latest' | 'none'
const drawerPickKindArb = fc.constantFrom<DrawerPickKind>(
  'specific-0',
  'specific-1',
  'latest',
  'none'
)

function drawerPickCommand(
  agent: Agent,
  kind: DrawerPickKind,
  nudgeBatch: boolean,
  releases: number
): Cmd {
  return {
    // While a team switch is pending only a same-agent concrete pick may
    // land inside it (the request the switch must forget).
    check: model =>
      !isChat(model) &&
      (!model.teamSwitchInFlight ||
        (!nudgeBatch && kind.startsWith('specific') && agent === model.selectedAgent)),
    async run(model, real) {
      if (!model.teamSwitchInFlight) await drain(real)
      const chatId = kind.startsWith('specific') ? CHATS[agent][Number(kind.at(-1))]! : null
      act(() => {
        if (nudgeBatch) real.app.result.current.clearAppsPicker()
        real.app.result.current.handleSelectChatAgent(agent, {
          ...(chatId ? { chatId } : {}),
          selectLatest: kind === 'latest',
          keepNavItem: true,
        })
      })
      transition(model, real, m => {
        if (nudgeBatch) m.picker = false
        m.pending[agent] = chatId
          ? { mode: 'specific', chatId }
          : kind === 'latest'
            ? { mode: 'latest' }
            : { mode: 'none' }
        // Same agent: the pick shows its chat at once (or blanks), and a
        // concrete pick stays recorded until the next boundary.
        m.visible = chatId
        m.selectedAgent = agent
      })
      await release(real, releases)
    },
    toString: () =>
      `drawer pick ${agent} ${kind}${nudgeBatch ? ' with the picker closed' : ''} (release ${releases})`,
  }
}

function teamSwitchCommand(releases: number): Cmd {
  return {
    check: model => !model.teamSwitchInFlight,
    async run(model, real) {
      await drain(real)
      const target = model.team === TEAMS[0] ? TEAMS[1] : TEAMS[0]
      model.teamSwitchInFlight = true
      let switching!: Promise<unknown>
      act(() => {
        switching = real.app.result.current.handleEnsureTeamContext({ teamId: target })
      })
      real.teamSwitches.push(switching)
      void switching.then(() => {
        model.teamSwitchInFlight = false
      })
      await release(real, releases)
    },
    toString: () => `switch team (release ${releases})`,
  }
}

const concretePickThenTeamSwitchArb = fc
  .tuple(
    fc.constantFrom<DrawerPickKind>('specific-0', 'specific-1'),
    fc.boolean(),
    releasesArb,
    releasesArb
  )
  .map(
    ([kind, changeTab, pickReleases, switchReleases]): Cmd => ({
      check: model => !isChat(model) && !model.teamSwitchInFlight,
      async run(model, real) {
        await drawerPickCommand(model.selectedAgent, kind, false, pickReleases).run(model, real)
        if (changeTab) {
          const calls = chatIpcCalls(real.clerum)
          act(() => real.app.result.current.openPreviewSection(gfsPreview()))
          expect(chatIpcCalls(real.clerum), 'open Preview must not touch chat IPC').toBe(calls)
          transition(model, real, m => {
            m.tab = 'other'
            m.picker = false
          })
        }
        await teamSwitchCommand(switchReleases).run(model, real)
      },
      toString: () =>
        `same-agent drawer pick ${kind}${changeTab ? ', open Preview' : ''}, switch team`,
    })
  )

const commandArbs = [
  releasesArb.map(releases =>
    nonChatTabCommand(
      'open Files',
      app => app.result.current.openFilesSection(null),
      model => {
        model.tab = 'other'
        model.picker = false
      },
      releases
    )
  ),
  releasesArb.map(releases =>
    nonChatTabCommand(
      'open Preview',
      app => app.result.current.openPreviewSection(gfsPreview()),
      model => {
        model.tab = 'other'
        model.picker = false
      },
      releases
    )
  ),
  releasesArb.map(releases =>
    nonChatTabCommand(
      'open Settings',
      app => app.result.current.handleNavSelect(DESKTOP_ROUTES.settings),
      model => {
        model.tab = 'other'
        model.picker = false
      },
      releases
    )
  ),
  releasesArb.map(releases =>
    nonChatTabCommand(
      'toggle the Apps picker',
      app =>
        app.result.current.appsPickerActive
          ? app.result.current.clearAppsPicker()
          : app.result.current.showAppsPicker(),
      model => {
        model.picker = !model.picker
      },
      releases
    )
  ),
  // Leaving chat for Files.
  releasesArb.map(
    (releases): Cmd => ({
      check: model => isChat(model) && !model.teamSwitchInFlight,
      async run(model, real) {
        await drain(real)
        act(() => real.app.result.current.openFilesSection(null))
        transition(model, real, m => {
          m.tab = 'other'
          m.picker = false
        })
        await release(real, releases)
      },
      toString: () => `leave chat for Files (release ${releases})`,
    })
  ),
  // Opening a conversation full screen (or a same-route pick while on chat).
  fc.tuple(fc.constantFrom(...AGENTS), fc.integer({ min: 0, max: 1 }), releasesArb).map(
    ([agent, index, releases]): Cmd => ({
      check: model => !model.teamSwitchInFlight,
      async run(model, real) {
        await drain(real)
        const chatId = CHATS[agent][index]!
        const fastPath = isChat(model) && model.selectedAgent === agent
        act(() =>
          real.app.result.current.handleSelectChatAgent(agent, { chatId, selectLatest: false })
        )
        if (fastPath) {
          const request = model.pending[agent]
          if (!(request?.mode === 'specific' && request.chatId === chatId)) {
            delete model.pending[agent]
          }
          model.visible = chatId
        } else {
          transition(
            model,
            real,
            m => {
              m.pending[agent] = { mode: 'specific', chatId }
              m.selectedAgent = agent
              m.tab = 'chat'
              m.picker = false
            },
            { forceReplay: true }
          )
        }
        await release(real, releases)
      },
      toString: () => `open ${agent}/${CHATS[agent][index]} full screen (release ${releases})`,
    })
  ),
  // Drawer pick of a chat, the latest chat or a new chat, for the same or another agent,
  // optionally batched with closing the Apps picker as the NudgeArea "new chat" does.
  fc
    .tuple(fc.constantFrom(...AGENTS), drawerPickKindArb, fc.boolean(), releasesArb)
    .map(([agent, kind, nudgeBatch, releases]) =>
      drawerPickCommand(agent, kind, nudgeBatch, releases)
    ),
  // Sidebar / list pick of a chat of the selected agent.
  fc.tuple(fc.integer({ min: 0, max: 1 }), releasesArb).map(
    ([index, releases]): Cmd => ({
      check: model => !model.teamSwitchInFlight,
      async run(model, real) {
        await drain(real)
        const agent = model.selectedAgent
        const chatId = CHATS[agent][index]!
        act(() => {
          void real.app.result.current.handleSelectChat(chatId)
        })
        const request = model.pending[agent]
        if (!(request?.mode === 'specific' && request.chatId === chatId))
          delete model.pending[agent]
        model.visible = chatId
        await release(real, releases)
      },
      toString: () => `sidebar pick chat #${index} (release ${releases})`,
    })
  ),
  // Opening an agent workspace: records `none`, blanks, moves to the agents route.
  fc.tuple(fc.constantFrom(...AGENTS), releasesArb).map(
    ([agent, releases]): Cmd => ({
      check: model => !model.teamSwitchInFlight,
      async run(model, real) {
        await drain(real)
        act(() =>
          real.app.result.current.handleOpenAgentWorkspace(agent, AGENT_WORKSPACE_ROUTES.members)
        )
        transition(model, real, m => {
          m.pending[agent] = { mode: 'none' }
          m.visible = null
          m.selectedAgent = agent
          m.tab = 'other'
          m.picker = false
        })
        await release(real, releases)
      },
      toString: () => `open the ${agent} workspace (release ${releases})`,
    })
  ),
  // Make the next last-active write fail.
  fc.constant<Cmd>({
    check: () => true,
    async run(_model, real) {
      real.failNextOpen = true
    },
    toString: () => 'fail the next conversation opening',
  }),
  // Team switch. It completes when the scheduler lets `team.switch` resolve.
  releasesArb.map(teamSwitchCommand),
  // The sequence a team switch must defend against, generated far more often
  // than chance would: a concrete same-agent drawer pick, maybe a non-chat tab
  // change, then the switch.
  ...Array.from({ length: 4 }, () => concretePickThenTeamSwitchArb),
]

async function setup(scheduler: Scheduler): Promise<{ model: Model; real: Real }> {
  const { clerum, handle } = installAppControllerClerum({
    agentNames: [...AGENTS],
    me: { teamId: TEAMS[0], teamName: TEAMS[0] },
    teamDirectory: { items: [], currentTeamId: TEAMS[0] },
  })
  routeIndexThroughStore(clerum)
  for (const agent of AGENTS) {
    for (const chatId of CHATS[agent]) {
      await seedChats(clerum, agent, [chatId])
      // Distinct update times make "latest" a single, stable chat.
      await new Promise(resolve => setTimeout(resolve, 3))
    }
  }
  const latest = {} as Record<Agent, string>
  for (const agent of AGENTS) {
    const { chats } = await clerum.readIndex(agent)
    // The list's own ordering decides which chat is "latest".
    const newest = [...chats].sort(byUpdatedDesc)
    expect(newest[0]!.updatedAt).not.toBe(newest[1]!.updatedAt)
    latest[agent] = newest[0]!.id
  }

  let activeTeam: string = TEAMS[0]
  handle.refreshCatalog.mockImplementation(async () => catalogListing(activeTeam))

  const app = await bootApp()
  act(() => app.result.current.openFilesSection(null))
  act(() =>
    app.result.current.handleSelectChatAgent('agent-x', {
      chatId: 'x-1',
      selectLatest: false,
      keepNavItem: true,
    })
  )
  await waitFor(() => {
    expect(app.result.current.activeChatId).toBe('x-1')
    expect(app.result.current.chatMessagesLoading).toBe(false)
    expect(app.result.current.chatListLoading).toBe(false)
  })

  const real: Real = {
    app,
    clerum,
    scheduler,
    latest,
    failNextOpen: false,
    rejectedOpens: 0,
    teamSwitches: [],
  }
  const model: Model = {
    tab: 'other',
    picker: false,
    selectedAgent: 'agent-x',
    team: TEAMS[0],
    visible: 'x-1',
    pending: {},
    teamSwitchInFlight: false,
  }

  // From here on the scheduler owns every await of the selection flow.
  const readIndex = scheduler.scheduleFunction((agent: string) => clerum.readIndex(agent))
  clerum.chat.getIndex.mockImplementation((agent: string) => readIndex(agent))
  const open = scheduler.scheduleFunction(async (agent: string, chatId: string) =>
    clerum.persistLastActive(agent, chatId)
  )
  clerum.chat.setLastActive.mockImplementation((agent: string, chatId: string) => {
    if (real.failNextOpen) {
      real.failNextOpen = false
      real.rejectedOpens += 1
      return open(agent, chatId).then(() => {
        throw new Error(`opening ${chatId} failed`)
      })
    }
    return open(agent, chatId)
  })
  const persistedMessages = clerum.chat.loadMessages.getMockImplementation()!
  const readMessages = scheduler.scheduleFunction(
    (agent: string, chatId: string, limit?: number, offset?: number) =>
      persistedMessages(agent, chatId, limit, offset)
  )
  clerum.chat.loadMessages.mockImplementation(readMessages)
  const switchTeam = handle.switchTeam.getMockImplementation() as (
    teamId: string
  ) => Promise<unknown>
  const scheduledSwitch = scheduler.scheduleFunction(async (teamId: string) => teamId)
  handle.switchTeam.mockImplementation(async (teamId: string) => {
    await scheduledSwitch(teamId)
    // The controller tears the old team down and adopts the new one right after
    // this resolves, with no await in between: the reference does the same.
    activeTeam = teamId
    model.team = teamId
    for (const agent of AGENTS) {
      if (model.pending[agent]?.mode === 'specific') delete model.pending[agent]
    }
    replay(model, real.latest)
    return switchTeam(teamId)
  })

  return { model, real }
}

async function assertAtRest(model: Model, real: Real) {
  await drain(real)
  const { app } = real
  await waitFor(() => {
    // Nothing is left loading.
    expect(app.result.current.chatListLoading).toBe(false)
    expect(app.result.current.chatMessagesLoading).toBe(false)
  })
  expect(real.scheduler.count()).toBe(0)
  expect(app.result.current.currentTeamId).toBe(model.team)
  expect(app.result.current.selectedAgent).toBe(model.selectedAgent)
  const route = expectedRoute(model)
  if (route) expect(app.result.current.navItem).toBe(route)
  else expect(app.result.current.navItem).not.toBe(DESKTOP_ROUTES.chat)

  // The visible conversation is the reference's (so no request survives a team switch).
  expect(app.result.current.activeChatId).toBe(model.visible)
  // Messages, if any, belong to the visible chat of the selected agent.
  const messageIds = app.result.current.activeMessages.map(message => message.id)
  if (model.visible === null) expect(messageIds).toEqual([])
  else if (real.rejectedOpens === 0) expect(messageIds).toEqual([messageIdFor(model.visible)])
  else expect([[], [messageIdFor(model.visible)]]).toContainEqual(messageIds)
  if (model.visible) expect(CHATS[model.selectedAgent]).toContain(model.visible)

  // A failed opening is reported at most once; nothing else reports errors.
  expect(errorToasts(app).length).toBeLessThanOrEqual(real.rejectedOpens)
}

describe('useAppController — drawer selection reference model', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    uninstallMockClerum()
  })

  it('agrees with the reference model at rest for scheduled gesture sequences', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands(commandArbs, { maxCommands: 8 }),
        async (scheduler, commands) => {
          const { model, real } = await setup(scheduler)
          try {
            await fc.asyncModelRun(() => ({ model, real }), commands)
            await assertAtRest(model, real)
          } finally {
            real.app.unmount()
            cleanup()
            uninstallMockClerum()
          }
        }
      ),
      { numRuns: 40, endOnFailure: true }
    )
  }, 240_000)
})
