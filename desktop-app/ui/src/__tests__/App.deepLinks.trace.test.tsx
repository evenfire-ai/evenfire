// @vitest-environment jsdom
import { createElement, useLayoutEffect, useRef } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { act } from '@testing-library/react'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createWorkspaceTabsState, openChatTab } from '@lib/workspaceTabs'
import type { FilesPageProps } from '@pages/FilesPage.types'
import type { SandboxUiPageProps } from '@pages/SandboxUiPage.types'
import { App } from '@/App'
import {
  type ConfirmDialogRecord,
  type TraceHarness,
  type TraceOptions,
  type TraceSinks,
  type TraceVariant,
  USER_A,
  USER_B,
  USER_C,
  gfsUri,
  startTrace,
} from './__fixtures__/deepLinkTraceHarness'

// The sandbox-ui main fake runs the real main process; these are the layers
// under it that the suite does not stand up.
vi.mock(
  'electron',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiElectronFakes')).electronModule
)
vi.mock('../../../src/config', async () => ({
  ...(await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks')).configModule,
  getActiveRuntimeConfigOptionId: () => null,
}))
vi.mock(
  '../../../src/sandboxUiPartitionGc',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks')).partitionGcModule
)
vi.mock(
  '../../../src/rpcTokenManager',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks'))
      .rpcTokenManagerModule
)
vi.mock(
  '../../../src/authClient',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks')).authClientModule
)
vi.mock(
  '../../../src/tokenStore',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks')).tokenStoreModule
)

const sinks: TraceSinks = vi.hoisted(() => ({
  dialogs: new Map(),
  filesPages: new Map(),
  sandboxUiPage: { props: null },
  controller: { use: null },
}))

// The controller is the harness's stub; App reads it through the real hook name.
vi.mock('@hooks/useAppController', () => ({
  useAppController: () => {
    if (!sinks.controller.use) throw new Error('no trace controller installed')
    return sinks.controller.use()
  },
}))
// Chat actions are outside the deep-link surface and need the real controller.
vi.mock('@hooks/useAgentChatActionsValue', () => ({ useAgentChatActionsValue: () => ({}) }))
// Chrome surfaces without deep-link behavior: rendered as nothing.
vi.mock('@components/AppHeader', () => ({ AppHeader: () => null }))
vi.mock('@components/ChatLocalSearch', () => ({ ChatLocalSearch: () => null }))
vi.mock('@components/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('@components/BootSplash', () => ({ BootSplash: () => null }))
vi.mock('@components/SidebarNav', () => ({ SidebarNav: () => null }))
vi.mock('@components/WorkspaceTabStrip', () => ({ WorkspaceTabStrip: () => null }))
// Buttons render natively so the revalidation banner's Retry is clickable;
// toasts are read from the log, not the DOM.
vi.mock('@components/Common', async () => {
  const actual = await vi.importActual<typeof import('@components/Common')>('@components/Common')
  return {
    ...actual,
    Button: (props: Parameters<typeof actual.Button>[0]) =>
      createElement(
        'button',
        { disabled: props.disabled, onClick: props.onClick, type: props.type ?? 'button' },
        props.children
      ),
    IconButton: () => null,
    ToastStack: () => null,
  }
})
// Recorder: every mounted dialog's latest props, removed on unmount.
vi.mock('@components/ConfirmDialog', () => ({
  ConfirmDialog: (props: ConfirmDialogRecord) => {
    const key = useRef({}).current
    useLayoutEffect(() => {
      sinks.dialogs.set(key, props)
      return () => {
        sinks.dialogs.delete(key)
      }
    })
    return null
  },
}))
// Recorder: the deep-link props of the mounted Files page.
vi.mock('@pages/FilesPage', () => ({
  FilesPage: (props: FilesPageProps) => {
    const key = useRef({}).current
    useLayoutEffect(() => {
      sinks.filesPages.set(key, props)
      return () => {
        sinks.filesPages.delete(key)
      }
    })
    return null
  },
}))
// Like the real page it measures the slot while mounted, so launches reach main.
vi.mock('@pages/SandboxUiPage', () => {
  const SLOT_BOUNDS = { x: 16, y: 12, width: 400, height: 300, dpr: 1 }
  return {
    SandboxUiPage: (props: SandboxUiPageProps) => {
      sinks.sandboxUiPage.props = props
      const { embed } = props
      useLayoutEffect(() => embed.registerMeasurer(async () => SLOT_BOUNDS), [embed])
      return null
    },
  }
})
// Pages with no deep-link behavior.
vi.mock('@pages/AgentsPage', () => ({ AgentsPage: () => null }))
vi.mock('@pages/AuthPage', () => ({ AuthPage: () => null }))
vi.mock('@pages/ChatPage', () => ({ ChatPage: () => null }))
vi.mock('@pages/McpServersPage', () => ({ McpServersPage: () => null }))
vi.mock('@pages/SettingsPage', () => ({ SettingsPage: () => null }))
vi.mock('@pages/UnavailablePage', () => ({ UnavailablePage: () => null }))
vi.mock('@pages/WorkflowsPage', () => ({ WorkflowsPage: () => null }))

const GOLDEN_PATH = path.join(__dirname, '__fixtures__', 'deepLinks.trace.golden.json')
const UPDATE_GOLDEN = process.env.UPDATE_DEEPLINK_GOLDEN === '1'
const golden: Record<string, string[]> = UPDATE_GOLDEN
  ? {}
  : (JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, string[]>)
const produced: Record<string, string[]> = {}
const registered = new Set<string>()

const VARIANTS: TraceVariant[] = ['plain', 'strict']
const GFS_DIALOG = 'Open EvenDrive link?'
const APP_DIALOG = 'Open app link?'
const APP_FAILED_DIALOG = 'App link could not be opened'

let current: TraceHarness | null = null
let realUseAppController: TraceOptions['realController']

beforeAll(async () => {
  realUseAppController = (
    await vi.importActual<typeof import('@hooks/useAppController')>('@hooks/useAppController')
  ).useAppController as TraceOptions['realController']
})

afterEach(async () => {
  const h = current
  current = null
  await h?.dispose()
})

afterAll(() => {
  if (!UPDATE_GOLDEN) {
    // A golden key with no scenario behind it is a scenario that was renamed
    // or dropped without regenerating on the base.
    expect(Object.keys(golden).filter(key => !registered.has(key))).toEqual([])
    return
  }
  // A filtered run (`-t`) would write a partial golden over the full one.
  const missing = [...registered].filter(key => !(key in produced))
  if (missing.length > 0) {
    throw new Error(
      `refusing to write the golden: ${missing.length} scenario runs did not produce a log (filtered or failed run)`
    )
  }
  const ordered = Object.fromEntries(
    Object.keys(produced)
      .sort()
      .map(key => [key, produced[key]])
  )
  writeFileSync(GOLDEN_PATH, `${JSON.stringify(ordered, null, 2)}\n`)
})

async function start(options: ScenarioOptions, variant: TraceVariant) {
  current = await startTrace(sinks, App, { ...options, variant })
  return current
}

/**
 * Runs a scenario in both variants. The body asserts the scenario's scope
 * signal; the harness then checks the invariants that hold at every rest
 * (one live listener per channel, no activation of another identity's link)
 * and compares the whole log with the golden generated on the base.
 */
type ScenarioOptions = Omit<TraceOptions, 'variant'>

function scenario(
  name: string,
  // A factory, so stateful fakes (a one-shot rejection) are fresh per variant.
  options: ScenarioOptions | (() => ScenarioOptions),
  body: (h: TraceHarness, variant: TraceVariant) => Promise<void>,
  extra: { listenersAtRest?: Record<string, number> } = {}
) {
  describe(name, () => {
    for (const variant of VARIANTS) {
      registered.add(`${name} × ${variant}`)
      it(variant, async () => {
        const h = await start(typeof options === 'function' ? options() : options, variant)
        try {
          await body(h, variant)
        } finally {
          // Debug aid: TRACE_DUMP=<dir> writes each scenario's log, failing or not.
          if (process.env.TRACE_DUMP) {
            writeFileSync(
              path.join(process.env.TRACE_DUMP, `${name} ${variant}.log`.replace(/[^\w. -]/g, '_')),
              `${h.log.join('\n')}\n`
            )
          }
        }
        expect(h.igViolations).toEqual([])
        expect(h.lastRest().listeners).toEqual(
          extra.listenersAtRest ?? {
            'sandboxUi:sessionInvalidated': 1,
            'sandboxUi:deepLink': 1,
            'gfs:deepLink': 1,
          }
        )
        const key = `${name} × ${variant}`
        produced[key] = [...h.log]
        if (!UPDATE_GOLDEN) expect(h.log).toEqual(golden[key])
      })
    }
  })
}

// --- helpers used by several scenarios --------------------------------------

async function linkWithDialog(h: TraceHarness, n = 1) {
  const link = await h.produceGfs(n)
  await h.settle('link')
  expect(h.hasDialog(GFS_DIALOG)).toBe(true)
  return link
}

async function activeLink(h: TraceHarness, n = 1) {
  const link = await linkWithDialog(h, n)
  await h.confirm(GFS_DIALOG)
  await h.settle('confirmed')
  expect(h.count('vm.activateGfsResourceNavigation [')).toBe(1)
  expect(h.lastRest().files?.[0]?.pendingGfsDeepLink?.id).toBe(link.id)
  return link
}

function ackCalls(h: TraceHarness, id: number, from = 0): string[] {
  return h.entries(`call gfs.acknowledgeDeepLink#`, from).filter(entry => {
    const args = JSON.parse(entry.slice(entry.indexOf('['))) as unknown[]
    return args[0] === id
  })
}

function plainAckCalls(h: TraceHarness, id: number, from = 0): string[] {
  return ackCalls(h, id, from).filter(entry => entry.endsWith(`[${id}]`))
}

function sandboxAckCalls(h: TraceHarness, id: number, from = 0): string[] {
  return h.entries(`call sandboxUi.acknowledgeDeepLink#`, from).filter(entry => {
    const args = JSON.parse(entry.slice(entry.indexOf('['))) as unknown[]
    return args[0] === id
  })
}

function gfsDialogs(h: TraceHarness): number {
  return h.lastRest().dialogs.filter(dialog => dialog.title === GFS_DIALOG).length
}

/** Confirms the rendered dialog and mutates the controller in the same commit. */
async function confirmAnd(h: TraceHarness, title: string, mutate: (c: Controller) => void) {
  const props = h.dialog(title)
  h.record(`user confirm "${title}" (same act)`)
  await h.update(controller => {
    props.onConfirm()
    mutate(controller)
  })
}

/** Dismisses GFS dialogs until none is left; returns the ids each dismissal acknowledged. */
async function dismissAllGfs(h: TraceHarness): Promise<number[]> {
  const acknowledged: number[] = []
  for (let round = 0; round < 10 && h.hasDialog(GFS_DIALOG); round += 1) {
    const from = h.log.length
    await h.dismiss(GFS_DIALOG)
    await h.settle('dismissed')
    for (const entry of h.entries('call gfs.acknowledgeDeepLink#', from)) {
      const args = JSON.parse(entry.slice(entry.indexOf('['))) as unknown[]
      acknowledged.push(args[0] as number)
    }
  }
  return acknowledged
}

type Controller = TraceHarness['controller']

const transientTeamError = () => Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })

const READY_APPS = [
  { appRef: 'ns/app', title: 'App', defaultPath: '/', ready: true, phase: 'active' },
  { appRef: 'ns/app-two', title: 'App Two', defaultPath: '/', ready: true, phase: 'active' },
]

const ALL_CHANNELS_ZERO = {
  'sandboxUi:sessionInvalidated': 0,
  'sandboxUi:deepLink': 0,
  'gfs:deepLink': 0,
}

describe('App deep-link scenario oracle', () => {
  // --- Montaje y listeners -------------------------------------------------

  scenario('S-M1', {}, async h => {
    const at = (prefix: string) => h.indexOf(prefix)
    expect(at('sub sandboxUi:sessionInvalidated#1')).toBeGreaterThanOrEqual(0)
    expect(at('sub sandboxUi:sessionInvalidated#1')).toBeLessThan(at('sub sandboxUi:deepLink#1'))
    expect(at('sub sandboxUi:deepLink#1')).toBeLessThan(at('call sandboxUi.listPendingDeepLinks#1'))
    expect(at('call sandboxUi.listPendingDeepLinks#1')).toBeLessThan(at('sub gfs:deepLink#1'))
  })

  scenario(
    'S-M2',
    {},
    async h => {
      h.mark('unmount')
      const from = h.log.length
      await h.unmount()
      await h.settle('unmounted')
      for (const channel of [
        'sandboxUi:sessionInvalidated',
        'sandboxUi:deepLink',
        'gfs:deepLink',
      ]) {
        expect(h.count(`unsub ${channel}#`, from), channel).toBe(1)
      }
      expect(h.liveCounts()).toEqual(ALL_CHANNELS_ZERO)
    },
    { listenersAtRest: ALL_CHANNELS_ZERO }
  )

  scenario('S-M3', {}, async h => {
    h.mark('generation')
    const from = h.log.length
    await h.update(controller => {
      h.service.sessionGeneration = 8
      ;(controller as { sessionGeneration: number }).sessionGeneration = 8
    })
    await h.settle('generation')
    const unsubscribe = h.indexOf('unsub sandboxUi:sessionInvalidated#', from)
    const subscribe = h.indexOf('sub sandboxUi:sessionInvalidated#', from)
    expect(unsubscribe).toBeGreaterThanOrEqual(from)
    expect(subscribe).toBeGreaterThan(unsubscribe)
    expect(h.count('sub gfs:deepLink#', from)).toBe(0)
    expect(h.count('unsub gfs:deepLink#', from)).toBe(0)
  })

  scenario('S-M4', {}, async h => {
    h.mark('identity+generation')
    const from = h.log.length
    await h.update(() => h.publish(USER_B, 8))
    await h.settle('changed')
    const unsubscribe = h.indexOf('unsub sandboxUi:sessionInvalidated#', from)
    const clear = h.indexOf('call sandboxUi.clearPendingDeepLinks#', from)
    const subscribe = h.indexOf('sub sandboxUi:sessionInvalidated#', from)
    expect(unsubscribe).toBeGreaterThanOrEqual(from)
    expect(clear).toBeGreaterThan(unsubscribe)
    expect(subscribe).toBeGreaterThan(clear)
  })

  // --- Identidad, barrera y purga -------------------------------------------

  async function retainedConfirmation(
    h: TraceHarness,
    hold: 'booting' | 'initialExperienceLoading'
  ) {
    const link = await linkWithDialog(h)
    await confirmAnd(h, GFS_DIALOG, controller => {
      ;(controller as Record<string, unknown>)[hold] = true
    })
    await h.settle('retained')
    expect(h.count('vm.beginConfirmedGfsResourceNavigation [')).toBe(1)
    expect(h.count('vm.activateGfsResourceNavigation [')).toBe(0)
    return link
  }

  for (const [name, hold] of [
    ['S-1', 'booting'],
    ['S-1i', 'initialExperienceLoading'],
  ] as const) {
    scenario(name, {}, async h => {
      const link = await retainedConfirmation(h, hold)
      h.mark('release+identity')
      const from = h.log.length
      await h.update(controller => {
        ;(controller as Record<string, unknown>)[hold] = false
        h.publish(USER_B, 7)
      })
      await h.settle('identity B')
      expect(h.count('vm.activateGfsResourceNavigation [')).toBe(0)
      expect(ackCalls(h, link.id)).toEqual([])
      expect(h.count('call gfs.clearPendingDeepLinks#', from)).toBeGreaterThanOrEqual(1)
      expect(gfsDialogs(h)).toBe(0)
      expect(h.lastRest().listeners['gfs:deepLink']).toBe(1)
    })
  }

  scenario('S-1c', {}, async h => {
    await retainedConfirmation(h, 'booting')
    await h.update(controller => {
      ;(controller as Record<string, unknown>).booting = false
    })
    await h.settle('released')
    expect(h.count('vm.activateGfsResourceNavigation [')).toBe(1)
  })

  scenario('S-1b', {}, async h => {
    const link = await activeLink(h)
    h.mark('identity')
    const from = h.log.length
    await h.update(() => h.publish(USER_B, 7))
    await h.settle('identity B')
    expect(ackCalls(h, link.id, from)).toEqual([])
    expect(h.count('call gfs.clearPendingDeepLinks#', from)).toBe(1)
    expect(h.count('vm.activateGfsResourceNavigation [')).toBe(1)
    // App resets the workspace store on a principal change, so the Files page
    // that carried the active link is gone rather than showing it as null.
    expect(h.lastRest().files).toBeNull()
    expect(h.lastRest().workspace.tabs).toEqual(['chat-tab-1:chat'])
  })

  scenario('S-2', {}, async h => {
    h.endSession(8)
    await h.settle('barrier')
    h.mark('identity under barrier')
    const from = h.log.length
    await h.update(controller => {
      h.publish(USER_B, 8)
      // The renderer has not loaded the replacement generation yet.
      ;(controller as { sessionGeneration: number }).sessionGeneration = 7
    })
    await h.settle('identity B')
    const resubscribe = h.indexOf('sub gfs:deepLink#', from)
    const replay = h.indexOf('call auth.getSessionState#', from)
    expect(resubscribe).toBeGreaterThanOrEqual(from)
    expect(replay).toBeGreaterThan(resubscribe)
  })

  scenario('S-P', {}, async h => {
    h.gate('gfs.clearPendingDeepLinks')
    h.mark('identity')
    const from = h.log.length
    await h.update(() => h.publish(USER_B, 7))
    await h.settle('clear held')
    const link = await h.produceGfs(1)
    await h.settle('link during hold')
    expect(gfsDialogs(h)).toBe(0)
    await h.release('gfs.clearPendingDeepLinks')
    await h.settle('released')
    expect(h.count('call gfs.listPendingDeepLinks#', from)).toBe(1)
    const listed = h.entries('resp gfs.listPendingDeepLinks#', from)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toContain(`"id":${link.id}`)
    expect(gfsDialogs(h)).toBe(1)
    expect(await dismissAllGfs(h)).toEqual([link.id])
  })

  scenario('S-P3', {}, async h => {
    h.gate('gfs.clearPendingDeepLinks', 2)
    h.mark('A→B')
    const from = h.log.length
    await h.update(() => h.publish(USER_B, 7))
    await h.settle('B held')
    await h.update(() => h.publish(USER_C, 7))
    await h.settle('C held')
    await h.release('gfs.clearPendingDeepLinks')
    await h.settle('first released')
    await h.release('gfs.clearPendingDeepLinks')
    await h.settle('second released')
    expect(h.count('call gfs.listPendingDeepLinks#', from)).toBe(1)
    const lastClear = h.log.lastIndexOf(h.entries('resp gfs.clearPendingDeepLinks#').at(-1)!)
    expect(h.indexOf('call gfs.listPendingDeepLinks#', from)).toBeGreaterThan(lastClear)
  })

  scenario('S-P4', {}, async h => {
    h.gate('gfs.clearPendingDeepLinks')
    h.gate('auth.getSessionState')
    await h.update(() => h.publish(USER_B, 7))
    await h.settle('clear held')
    h.endSession(8)
    await h.settle('invalidated, session read held')
    h.mark('release clear')
    const from = h.log.length
    await h.release('gfs.clearPendingDeepLinks')
    await h.settle('clear released')
    expect(h.count('call gfs.listPendingDeepLinks#', from)).toBe(0)
    h.mark('release session read')
    await h.release('auth.getSessionState')
    await h.settle('session read released')
  })

  for (const [name, clear] of [
    ['S-P5 zero', () => Promise.resolve(0)],
    ['S-P5 reject', () => Promise.reject(new Error('clear failed'))],
  ] as const) {
    scenario(name, {}, async h => {
      // Hand-written: the real queue's clear always returns sequence + 1 and never rejects.
      h.override('gfs.clearPendingDeepLinks', clear)
      h.mark('identity')
      const from = h.log.length
      await h.update(() => h.publish(USER_B, 7))
      await h.settle('identity B')
      expect(
        h
          .entries('vm.pushToast ', from)
          .some(entry =>
            entry.includes(
              'Could not safely refresh pending EvenDrive links after the account changed.'
            )
          )
      ).toBe(true)
      expect(h.count('call gfs.listPendingDeepLinks#', from)).toBe(0)
    })
  }

  scenario('S-P6', {}, async h => {
    h.gate('gfs.clearPendingDeepLinks')
    await h.update(() => h.publish(USER_B, 7))
    await h.settle('clear held')
    h.traceVm('pushToast', vi.fn())
    await h.render()
    await h.settle('new pushToast')
    h.mark('release')
    const from = h.log.length
    await h.release('gfs.clearPendingDeepLinks')
    await h.settle('released')
    expect(h.count('call gfs.listPendingDeepLinks#', from)).toBe(1)
  })

  // --- Enqueue ---------------------------------------------------------------

  scenario('S-E1', {}, async h => {
    const link = await linkWithDialog(h)
    expect(h.lastRest().dialogs.map(dialog => dialog.title)).toEqual([GFS_DIALOG])
    await h.dismiss(GFS_DIALOG)
    await h.settle('dismissed')
    expect(plainAckCalls(h, link.id)).toHaveLength(1)
  })

  scenario('S-E2', {}, async h => {
    const link = await linkWithDialog(h)
    await h.deliver(link)
    await h.settle('delivered again')
    expect(gfsDialogs(h)).toBe(1)
    expect(await dismissAllGfs(h)).toEqual([link.id])
    expect(gfsDialogs(h)).toBe(0)
  })

  scenario('S-E2b', {}, async h => {
    h.gate('gfs.clearPendingDeepLinks')
    h.gate('gfs.listPendingDeepLinks')
    await h.update(() => h.publish(USER_B, 7))
    await h.settle('clear held')
    // Queued after the clear emptied main's queue, so the list snapshot carries it.
    const link = h.pushQueued(1)
    await h.release('gfs.clearPendingDeepLinks')
    await h.settle('list held')
    expect(h.entries('call gfs.listPendingDeepLinks#').length).toBeGreaterThan(0)
    await h.deliver(link)
    await h.settle('delivered while listing')
    await h.release('gfs.listPendingDeepLinks')
    await h.settle('list released')
    expect(h.entries('resp gfs.listPendingDeepLinks#').at(-1)).toContain(`"id":${link.id}`)
    expect(gfsDialogs(h)).toBe(1)
    expect(await dismissAllGfs(h)).toEqual([link.id])
    expect(plainAckCalls(h, link.id)).toHaveLength(1)
  })

  async function staleBelowFloor(h: TraceHarness) {
    const stale = h.pushQueued(1)
    await h.update(() => h.publish(USER_B, 7))
    await h.settle('identity B')
    expect(h.entries('resp gfs.clearPendingDeepLinks#').at(-1)).toMatch(/ 2$/)
    return stale
  }

  scenario('S-E3', {}, async h => {
    const stale = await staleBelowFloor(h)
    await h.deliver(stale)
    await h.settle('stale delivered')
    expect(gfsDialogs(h)).toBe(0)
  })

  scenario('S-E3c', {}, async h => {
    await staleBelowFloor(h)
    const atFloor = await h.produceGfs(2)
    expect(atFloor.id).toBe(2)
    await h.settle('at floor')
    expect(gfsDialogs(h)).toBe(1)
  })

  const invalidIds = [0, -1, 1.5]

  scenario('S-E4', {}, async h => {
    h.mark('invalid ids')
    const from = h.log.length
    await h.injectGfs(
      ...invalidIds.map(id => ({ id, uri: gfsUri(1), userNavigationGenerationAtActivation: 0 }))
    )
    await h.settle('injected')
    expect(gfsDialogs(h)).toBe(0)
    expect(h.count('call ', from)).toBe(0)
    expect(h.count('sync ', from)).toBe(0)
  })

  for (const [name, ids] of [
    ['S-E4b', invalidIds],
    ['S-E4b control', [1]],
  ] as const) {
    scenario(name, {}, async h => {
      h.endSession(8)
      await h.settle('barrier')
      h.gate('gfs.listPendingDeepLinks')
      await h.update(controller => {
        ;(controller as { sessionGeneration: number }).sessionGeneration = 8
      })
      await h.settle('replay listing held')
      h.mark('inject under barrier')
      const from = h.log.length
      await h.injectGfs(
        ...ids.map(id => ({ id, uri: gfsUri(1), userNavigationGenerationAtActivation: 0 }))
      )
      await h.release('gfs.listPendingDeepLinks')
      await h.settle('released')
      // Without a queue change the replay finishes in one pass: the latest and
      // the final session reads. A revision bump restarts it from the top.
      if (name === 'S-E4b') expect(h.count('call auth.getSessionState#', from)).toBe(2)
      else expect(h.count('call auth.getSessionState#', from)).toBeGreaterThan(2)
    })
  }

  scenario('S-E5', {}, async h => {
    h.mark('malformed')
    const from = h.log.length
    await h.injectGfs({
      id: 1,
      uri: 'gfs://drive/not-hex',
      userNavigationGenerationAtActivation: 0,
    })
    await h.settle('injected')
    const toast = h.indexOf(
      'vm.pushToast ["Could not open EvenDrive link: the resource route is malformed."',
      from
    )
    const ack = h.indexOf('call gfs.acknowledgeDeepLink#', from)
    expect(toast).toBeGreaterThanOrEqual(from)
    expect(ack).toBeGreaterThan(toast)
  })

  scenario('S-E6', {}, async h => {
    // Ids 1-4 are taken before the account change, so the burst is 5, 6 and 7.
    for (const n of [1, 2, 3, 4]) h.pushQueued(n)
    h.gate('gfs.clearPendingDeepLinks')
    await h.update(() => h.publish(USER_B, 7))
    await h.settle('clear held')
    const links = [h.pushQueued(5), h.pushQueued(6), h.pushQueued(7)]
    expect(links.map(link => link.id)).toEqual([5, 6, 7])
    await h.release('gfs.clearPendingDeepLinks')
    await h.settle('released')
    expect(gfsDialogs(h)).toBe(1)
    expect(await dismissAllGfs(h)).toEqual(links.map(link => link.id))
  })

  scenario('S-E7', { principal: null }, async h => {
    const link = await h.produceGfs(1)
    await h.settle('before login')
    expect(gfsDialogs(h)).toBe(0)
    h.mark('login')
    const from = h.log.length
    await h.update(() => h.publish(USER_A, 7))
    await h.settle('signed in')
    expect(h.count('call gfs.clearPendingDeepLinks#', from)).toBe(0)
    expect(gfsDialogs(h)).toBe(1)
    await h.confirm(GFS_DIALOG)
    await h.settle('confirmed')
    expect(h.entries('vm.activateGfsResourceNavigation [')).toHaveLength(1)
    expect(h.entries('vm.activateGfsResourceNavigation [')[0]).toContain(`"id":${link.id}`)
  })

  // --- Diálogo GFS y gating L1 ------------------------------------------------

  scenario('S-D1', { apps: READY_APPS }, async h => {
    await h.produceApp({ appName: 'app', teamId: 'team-a' })
    await h.settle('app link')
    expect(h.hasDialog(APP_DIALOG)).toBe(true)
    await h.produceGfs(1)
    await h.settle('gfs link')
    expect(gfsDialogs(h)).toBe(0)
    await h.dismiss(APP_DIALOG)
    await h.settle('app link dismissed')
    expect(gfsDialogs(h)).toBe(1)
  })

  scenario(
    'S-D2',
    {
      controller: {
        handleEnsureTeamContext: vi.fn(async () => Promise.reject(transientTeamError())),
      } as never,
    },
    async h => {
      await h.produceApp({ appName: 'app', teamId: 'team-b' })
      await h.settle('app link')
      await h.confirm(APP_DIALOG)
      await h.settle('app confirmed')
      await h.produceGfs(1)
      await h.settle('gfs link')
      for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000]) {
        await h.advance(delay)
        await h.settle(`retry after ${delay}`)
        expect(gfsDialogs(h)).toBe(0)
      }
      expect(h.hasDialog(APP_FAILED_DIALOG)).toBe(true)
      await h.dismiss(APP_FAILED_DIALOG)
      await h.settle('failure dismissed')
      expect(gfsDialogs(h)).toBe(1)
    }
  )

  scenario(
    'S-D3',
    () => ({
      controller: {
        handleEnsureTeamContext: vi
          .fn()
          .mockRejectedValueOnce(transientTeamError())
          .mockResolvedValue(true),
      } as never,
    }),
    async h => {
      await h.produceApp({ appName: 'app', teamId: 'team-b' })
      await h.settle('app link')
      await h.confirm(APP_DIALOG)
      await h.settle('app deferred')
      expect(h.lastRest().dialogs).toEqual([])
      await h.produceGfs(1)
      await h.settle('gfs link')
      expect(gfsDialogs(h)).toBe(0)
      await h.advance(1_000)
      await h.settle('app retried')
      expect(h.count('vm.handleEnsureTeamContext ')).toBe(2)
      expect(gfsDialogs(h)).toBe(1)
    }
  )

  scenario('S-D4', {}, async h => {
    let rejectTeamSwitch: (error: Error) => void = () => {}
    h.traceVm(
      'handleEnsureTeamContext',
      () =>
        new Promise<boolean>((_, reject) => {
          rejectTeamSwitch = reject
        })
    )
    await h.render()
    await h.produceApp({ appName: 'app', teamId: 'team-b' })
    await h.settle('app link')
    await h.confirm(APP_DIALOG)
    await h.settle('app processing')
    await h.produceGfs(1)
    await h.settle('gfs link')
    expect(gfsDialogs(h)).toBe(0)
    h.record('world team switch rejects')
    await act(async () => {
      rejectTeamSwitch(new Error('team switch denied'))
    })
    await h.settle('app resolved')
    expect(gfsDialogs(h)).toBe(1)
  })

  scenario('S-D5', { controller: { booting: true } as never }, async h => {
    await h.produceGfs(1)
    await h.settle('while booting')
    expect(gfsDialogs(h)).toBe(0)
    await h.update(controller => {
      ;(controller as Record<string, unknown>).booting = false
    })
    await h.settle('booted')
    expect(gfsDialogs(h)).toBe(1)
  })

  // --- Confirmar, descartar y activar ----------------------------------------

  scenario('S-C1', {}, async h => {
    const link = await linkWithDialog(h)
    const from = h.log.length
    await h.confirm(GFS_DIALOG)
    await h.settle('confirmed')
    const begin = h.indexOf('vm.beginConfirmedGfsResourceNavigation [', from)
    const activate = h.indexOf('vm.activateGfsResourceNavigation [', from)
    expect(begin).toBeGreaterThanOrEqual(from)
    expect(activate).toBeGreaterThan(begin)
    expect(h.lastRest().files?.[0]?.pendingGfsDeepLink?.id).toBe(link.id)
  })

  scenario('S-C2', {}, async h => {
    const link = await linkWithDialog(h)
    const from = h.log.length
    await h.dismiss(GFS_DIALOG)
    await h.settle('dismissed')
    expect(plainAckCalls(h, link.id, from)).toHaveLength(1)
    expect(h.count('vm.beginConfirmedGfsResourceNavigation [')).toBe(0)
  })

  for (const outcome of ['opened', 'terminal', 'retryable', 'superseded'] as const) {
    scenario(`S-C3 ${outcome}`, {}, async h => {
      const link = await activeLink(h)
      const from = h.log.length
      await h.outcome(link.id, outcome)
      await h.settle(outcome)
      expect(plainAckCalls(h, link.id, from)).toHaveLength(outcome === 'retryable' ? 0 : 1)
    })
  }

  scenario(
    'S-C4',
    { controller: { activateGfsResourceNavigation: vi.fn(() => false) } as never },
    async h => {
      const link = await linkWithDialog(h)
      const from = h.log.length
      await h.confirm(GFS_DIALOG)
      await h.settle('confirmed')
      const activate = h.indexOf('vm.activateGfsResourceNavigation -> false', from)
      expect(activate).toBeGreaterThanOrEqual(from)
      expect(h.indexOf(`call gfs.acknowledgeDeepLink#1 [${link.id}]`, activate)).toBeGreaterThan(
        activate
      )
    }
  )

  scenario(
    'S-C5',
    {
      controller: {
        activateGfsResourceNavigation: vi.fn(() => {
          throw new Error('navigation exploded')
        }),
      } as never,
    },
    async h => {
      const link = await linkWithDialog(h)
      const from = h.log.length
      await h.confirm(GFS_DIALOG)
      await h.settle('confirmed')
      expect(plainAckCalls(h, link.id, from)).toHaveLength(1)
      expect(
        h
          .entries('vm.pushToast ', from)
          .some(entry => entry.includes('Could not open EvenDrive link: navigation exploded'))
      ).toBe(true)
      // The activation threw before opening a Files tab, so the reset of the
      // active link shows as App accepting the next link: its dialog requires
      // no active and no processing link, and Open starts a new request.
      expect(h.lastRest().files).toBeNull()
      const next = await linkWithDialog(h, 2)
      const nextFrom = h.log.length
      await h.confirm(GFS_DIALOG)
      await h.settle('next confirmed')
      expect(
        h.indexOf(`vm.beginConfirmedGfsResourceNavigation [${next.id},`, nextFrom)
      ).toBeGreaterThanOrEqual(nextFrom)
      expect(h.indexOf('vm.activateGfsResourceNavigation [', nextFrom)).toBeGreaterThanOrEqual(
        nextFrom
      )
    }
  )

  scenario('S-C6', {}, async h => {
    const begin = h.controller.beginConfirmedGfsResourceNavigation
    h.traceVm('beginConfirmedGfsResourceNavigation', ((
      id: number,
      uri: string,
      generation: number
    ) => {
      const request = begin(id, uri, generation)
      // Defensive: an uri that `normalizeGfsResourceUri` rejects.
      return request && { ...request, uri: 'gfs://drive/not-hex' }
    }) as never)
    await h.render()
    const link = await linkWithDialog(h)
    const from = h.log.length
    await h.confirm(GFS_DIALOG)
    await h.settle('confirmed')
    const ack = h.indexOf(`call gfs.acknowledgeDeepLink#1 [${link.id}]`, from)
    const toast = h.indexOf(
      'vm.pushToast ["Could not open EvenDrive link: the resource route is malformed."',
      from
    )
    expect(ack).toBeGreaterThanOrEqual(from)
    expect(toast).toBeGreaterThan(ack)
    expect(h.count('vm.activateGfsResourceNavigation [')).toBe(0)
  })

  scenario('S-C7a', {}, async h => {
    const link = await retainedConfirmation(h, 'booting')
    h.mark('intent')
    const from = h.log.length
    await h.update(controller => {
      controller.beginUserNavigationIntent()
    })
    await h.settle('intent changed')
    expect(plainAckCalls(h, link.id, from)).toHaveLength(1)
    expect(h.count('vm.activateGfsResourceNavigation [')).toBe(0)
  })

  scenario('S-C7b', {}, async h => {
    const link = await activeLink(h)
    h.mark('intent')
    const from = h.log.length
    await h.update(controller => {
      controller.beginUserNavigationIntent()
    })
    await h.settle('intent changed')
    expect(plainAckCalls(h, link.id, from)).toHaveLength(1)
  })

  scenario('S-X1', {}, async h => {
    const link = await activeLink(h)
    await h.produceApp({ appName: 'app', teamId: 'team-a' })
    await h.settle('app link')
    h.mark('confirm app link')
    const from = h.log.length
    await h.confirm(APP_DIALOG)
    await h.settle('app confirmed')
    const ack = h.indexOf(`call gfs.acknowledgeDeepLink#1 [${link.id}]`, from)
    const capture = h.indexOf('vm.captureWorkspaceNavigation ', from)
    expect(ack).toBeGreaterThanOrEqual(from)
    expect(capture).toBeGreaterThan(ack)
  })

  // --- Replay de invalidación -------------------------------------------------

  async function signedOutInvalidation(h: TraceHarness) {
    h.gate('auth.getSessionState')
    h.mark('logout + invalidation')
    await h.update(() => {
      h.publish(null, null)
      h.endSession(8)
    })
    await h.settle('session read held')
    const link = await h.produceGfs(1)
    await h.settle('held link')
    return link
  }

  scenario('S-R1', {}, async h => {
    const link = await signedOutInvalidation(h)
    const from = h.log.length
    await h.release('auth.getSessionState')
    await h.settle('retired')
    const retire = h.indexOf(
      `call gfs.acknowledgeDeepLink#1 [${link.id},{"sessionGeneration":8,"userNavigationGeneration":0}]`,
      from
    )
    expect(retire).toBeGreaterThanOrEqual(from)
    expect(h.indexOf('resp gfs.acknowledgeDeepLink#1 true', retire)).toBeGreaterThan(retire)
    expect(h.indexOf('call auth.getSessionState#', retire)).toBeGreaterThan(retire)
    expect(h.lastRest().banner).toBeNull()
  })

  // A controller with no published generation keeps the older reset-only
  // handling: no barrier and no replay, so a later link is offered at once.
  scenario('S-R1 legacy', { controller: { sessionGeneration: undefined } as never }, async h => {
    h.mark('invalidation')
    const from = h.log.length
    h.endSession(8)
    await h.settle('invalidated')
    expect(h.count('call auth.getSessionState#', from)).toBe(0)
    await h.produceGfs(1)
    await h.settle('link after invalidation')
    expect(gfsDialogs(h)).toBe(1)
  })

  scenario('S-R1b', {}, async h => {
    h.mark('invalidation + logout')
    const logoutFrom = h.log.length
    await act(async () => {
      h.endSession(8)
      await h.main.settle()
      h.publish(null, null)
      await h.render()
    })
    await h.settle('signed out under barrier')
    expect(h.count('call gfs.clearPendingDeepLinks#', logoutFrom)).toBe(0)
    const link = await h.produceGfs(1)
    await h.settle('link before login')
    h.mark('login B')
    const from = h.log.length
    await h.update(() => h.publish(USER_B, 9))
    await h.settle('signed in as B')
    expect(h.count('call gfs.clearPendingDeepLinks#', from)).toBe(0)
    expect(gfsDialogs(h)).toBe(1)
    expect(await dismissAllGfs(h)).toEqual([link.id])
  })

  async function heldAcrossInvalidation(h: TraceHarness) {
    h.endSession(8)
    await h.settle('barrier')
    const apps = [
      await h.produceApp({ appName: 'app', path: '/one', teamId: 'team-a' }),
      await h.produceApp({ appName: 'app-two', path: '/two', teamId: 'team-a' }),
    ]
    const resources = [await h.produceGfs(1), await h.produceGfs(2)]
    await h.settle('held links')
    return { apps, resources }
  }

  scenario('S-R2', { apps: READY_APPS }, async h => {
    const { apps, resources } = await heldAcrossInvalidation(h)
    h.mark('republish')
    const from = h.log.length
    await h.update(controller => {
      ;(controller as { sessionGeneration: number }).sessionGeneration = 8
    })
    await h.settle('republished')
    for (const app of apps) {
      expect(h.hasDialog(APP_DIALOG)).toBe(true)
      await h.dismiss(APP_DIALOG)
      await h.settle('app dismissed')
      expect(sandboxAckCalls(h, app.id, from)).toHaveLength(1)
    }
    expect(await dismissAllGfs(h)).toEqual(resources.map(link => link.id))
  })

  scenario('S-R3', {}, async h => {
    let reads = 0
    h.override('auth.getSessionState', () => {
      reads += 1
      return reads === 1
        ? Promise.reject(new Error('session read failed'))
        : h.service.getSessionState()
    })
    h.endSession(8)
    await h.settle('read failed')
    expect(h.lastRest().banner).toContain('Could not verify pending links')
    const from = h.log.length
    await h.clickRetryVerification()
    await h.settle('retried')
    expect(h.count('call auth.getSessionState#', from)).toBeGreaterThanOrEqual(1)
  })

  scenario('S-R4', {}, async h => {
    h.gate('auth.getSessionState', 2)
    h.endSession(8)
    await h.settle('first read held')
    h.endSession(9)
    await h.settle('second read held')
    expect(h.count('call auth.getSessionState#')).toBe(2)
    h.mark('release first')
    const from = h.log.length
    await h.release('auth.getSessionState')
    await h.settle('first released')
    expect(h.count('call ', from)).toBe(0)
    expect(h.count('sync ', from)).toBe(0)
    h.mark('release second')
    await h.release('auth.getSessionState')
    await h.settle('second released')
  })

  for (const [name, produce] of [
    ['S-R5a', (h: TraceHarness) => h.produceGfs(1)],
    ['S-R5a app', (h: TraceHarness) => h.produceApp({ appName: 'app', teamId: 'team-a' })],
  ] as const) {
    scenario(name, {}, async h => {
      h.gate('gfs.listPendingDeepLinks')
      h.endSession(8)
      await h.settle('replay listing held')
      await produce(h)
      await h.settle('link during listing')
      h.mark('release listing')
      const from = h.log.length
      await h.release('gfs.listPendingDeepLinks')
      await h.settle('released')
      expect(h.count('call gfs.listPendingDeepLinks#', from)).toBeGreaterThanOrEqual(1)
      expect(h.count('call auth.getSessionState#', from)).toBeGreaterThanOrEqual(1)
    })
  }

  scenario('S-R5b', {}, async h => {
    await signedOutInvalidation(h)
    h.gate('gfs.listPendingDeepLinks')
    await h.release('auth.getSessionState')
    await h.settle('listing held')
    h.record('world navigation.advance')
    h.navigation.advance()
    const from = h.log.length
    await h.release('gfs.listPendingDeepLinks')
    await h.settle('released')
    const refused = h.indexOf('resp gfs.acknowledgeDeepLink#1 false', from)
    expect(refused).toBeGreaterThanOrEqual(from)
    expect(h.indexOf('call auth.getSessionState#', refused)).toBeGreaterThan(refused)
  })

  scenario(
    'S-R6',
    {
      apps: READY_APPS,
      controller: {
        workspaceTabs: openChatTab(createWorkspaceTabsState('chat-tab-1'), {
          id: 'chat-tab-1',
          agentRef: 'agent-x',
          chatId: 'chat-1',
        }),
        selectedAgent: 'agent-x',
        activeChatId: 'chat-1',
        chatList: [{ id: 'chat-1', title: 'First chat', agentRef: 'agent-x' }],
      } as never,
    },
    async h => {
      h.endSession(8)
      await h.settle('barrier')
      await h.produceApp({ appName: 'app', path: '/inbox', teamId: 'team-a' })
      await h.settle('held app link')
      // The final snapshot's runtime read (third of the replay) holds the Promise.all.
      h.gate('auth.getRuntimeConfigState', 1, 2)
      await h.update(controller => {
        ;(controller as { sessionGeneration: number }).sessionGeneration = 8
      })
      await h.settle('final snapshot held')
      expect(h.heldCount()).toBe(1)
      h.mark('conversation changes')
      await h.update(controller => {
        ;(controller as { activeChatId: string }).activeChatId = 'chat-2'
        ;(controller as { chatList: unknown[] }).chatList = [
          ...(controller.chatList as unknown[]),
          { id: 'chat-2', title: 'Second chat', agentRef: 'agent-x' },
        ]
      })
      await h.release('auth.getRuntimeConfigState')
      await h.settle('reemitted')
      expect(h.hasDialog(APP_DIALOG)).toBe(true)
      const from = h.log.length
      await h.confirm(APP_DIALOG)
      await h.settle('app confirmed')
      const seeded = h.entries('vm.handleSelectChatAgent ', from)
      expect(seeded.length).toBeGreaterThan(0)
      expect(seeded[0]).toContain('"chatId":"chat-2"')
    }
  )

  scenario('S-R7', {}, async h => {
    h.gate('auth.getSessionState')
    h.endSession(8)
    await h.settle('session read held')
    h.mark('re-render')
    const from = h.log.length
    await h.render()
    await h.settle('re-rendered')
    expect(h.count('call auth.', from)).toBe(0)
    expect(h.count('call gfs.listPendingDeepLinks#', from)).toBe(0)
    expect(h.count('call sandboxUi.listPendingDeepLinks#', from)).toBe(0)
    expect(h.count('sub gfs:deepLink#', from)).toBe(0)
    expect(h.count('unsub gfs:deepLink#', from)).toBe(0)
    await h.release('auth.getSessionState')
    await h.settle('released')
  })

  scenario('S-R8', {}, async h => {
    h.endSession(8)
    await h.settle('barrier')
    await h.produceGfs(1)
    await h.settle('held link')
    h.gate('gfs.listPendingDeepLinks')
    await h.update(controller => {
      ;(controller as { sessionGeneration: number }).sessionGeneration = 8
    })
    await h.settle('replay listing held')
    h.mark('intent in place, no render')
    h.controller.beginUserNavigationIntent()
    await h.release('gfs.listPendingDeepLinks')
    await h.settle('released')
    expect(gfsDialogs(h)).toBe(1)
  })

  scenario('S-R9', {}, async h => {
    h.gate('auth.getSessionState', 2)
    h.endSession(8)
    await h.settle('first read held')
    await h.update(controller => {
      ;(controller as { currentTeamId: string }).currentTeamId = 'team-b'
    })
    await h.settle('second read held')
    h.mark('release both')
    const from = h.log.length
    await h.release('auth.getSessionState')
    await h.release('auth.getSessionState')
    await h.settle('released')
    expect(h.count('call sandboxUi.listPendingDeepLinks#', from)).toBe(1)
    expect(h.count('call gfs.listPendingDeepLinks#', from)).toBe(1)
  })

  scenario('S-R10', {}, async h => {
    const link = await activeLink(h)
    h.mark('invalidation')
    const from = h.log.length
    h.endSession(8)
    await h.settle('invalidated')
    expect(h.lastRest().files?.[0]?.pendingGfsDeepLink ?? null).toBeNull()
    await h.update(controller => {
      ;(controller as { sessionGeneration: number }).sessionGeneration = 8
    })
    await h.settle('republished')
    expect(plainAckCalls(h, link.id, from)).toEqual([])
    // Main resets its queue on invalidation (`main.ts` onSandboxUiSessionInvalidated),
    // so the active link can leave neither by an authority retire nor by reemission.
    expect(h.gfsQueue.list().map(queued => queued.id)).not.toContain(link.id)
    expect(ackCalls(h, link.id, from)).toEqual([])
  })

  scenario('S-R11', {}, async h => {
    const queued = Array.from({ length: 11 }, (_, index) => h.pushQueued(index + 1))
    for (const link of queued) {
      if (link.id !== 6 && link.id !== 11) {
        h.record(`world gfs.acknowledge #${link.id}`)
        h.gfsQueue.acknowledge(link.id)
      }
    }
    h.service.sessionGeneration = 8
    await h.injectInvalidation(
      { sessionGeneration: 8, appDeepLinkMinimumId: 1, gfsDeepLinkMinimumId: 10 },
      { sessionGeneration: 7, appDeepLinkMinimumId: 1, gfsDeepLinkMinimumId: 5 }
    )
    await h.settle('two invalidations')
    await h.update(controller => {
      ;(controller as { sessionGeneration: number }).sessionGeneration = 8
    })
    await h.settle('republished')
    expect(await dismissAllGfs(h)).toEqual([11])
  })

  // --- Reloj ---------------------------------------------------------------

  scenario(
    'S-T1',
    () => ({
      controller: {
        handleEnsureTeamContext: vi
          .fn()
          .mockRejectedValueOnce(transientTeamError())
          .mockResolvedValue(true),
      } as never,
    }),
    async h => {
      await h.produceApp({ appName: 'app', teamId: 'team-b' })
      await h.settle('app link')
      await h.confirm(APP_DIALOG)
      await h.settle('app deferred')
      h.mark('before retry')
      const from = h.log.length
      await h.advance(999)
      await h.settle('999ms')
      expect(h.count('vm.handleEnsureTeamContext ', from)).toBe(0)
      await h.advance(1)
      await h.settle('1000ms')
      expect(h.count('vm.handleEnsureTeamContext ', from)).toBe(1)
    }
  )

  // --- H-R: the real controller --------------------------------------------

  function expectRealSessionAdopted(h: TraceHarness) {
    const vm = h.vmNow()
    expect(vm.booting).toBe(false)
    expect(vm.isAuthenticated).toBe(true)
    expect(vm.initialExperienceLoading).toBe(false)
  }

  scenario(
    'S-M1 H-R',
    () => ({ realController: realUseAppController }),
    async h => {
      expectRealSessionAdopted(h)
      const at = (prefix: string) => h.indexOf(prefix)
      expect(at('sub sandboxUi:sessionInvalidated#1')).toBeGreaterThanOrEqual(0)
      expect(at('sub sandboxUi:sessionInvalidated#1')).toBeLessThan(at('sub sandboxUi:deepLink#1'))
      expect(at('sub sandboxUi:deepLink#1')).toBeLessThan(
        at('call sandboxUi.listPendingDeepLinks#1')
      )
      expect(at('call sandboxUi.listPendingDeepLinks#1')).toBeLessThan(at('sub gfs:deepLink#1'))
    }
  )

  scenario(
    'S-R2R',
    () => ({ realController: realUseAppController, apps: READY_APPS }),
    async h => {
      expectRealSessionAdopted(h)
      const { apps, resources } = await heldAcrossInvalidation(h)
      h.mark('republish')
      const from = h.log.length
      await act(async () => {
        await h.vmNow().loadSession()
      })
      await h.settle('republished')
      expect(h.vmNow().sessionGeneration).toBe(8)
      for (const app of apps) {
        expect(h.hasDialog(APP_DIALOG)).toBe(true)
        await h.dismiss(APP_DIALOG)
        await h.settle('app dismissed')
        expect(sandboxAckCalls(h, app.id, from)).toHaveLength(1)
      }
      expect(await dismissAllGfs(h)).toEqual(resources.map(link => link.id))
    }
  )
})
