// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import fc, { type AsyncCommand, type Scheduler } from 'fast-check'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { useNavigationController } from '@hooks/domain/useNavigationController'
import {
  CHAT_GFS_LINK_UNAVAILABLE_MESSAGE,
  type ChatLinkActivation,
  createChatLinkActivation,
} from '@lib/chatLinkActivation'
import { resolveGfsPreview } from '@lib/gfsPreview'
import { activeWorkspaceTab } from '@lib/workspaceTabs'
import type { SettingsSection, WorkspaceTab } from '@lib/workspaceTabs.types'
import {
  resolveResource,
  resolvedDirectory,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'

// The real navigation controller and the real activation core; only the main
// process bridge (resolve, user-navigation generation, openUrl, sandboxUi) is
// faked. The resolve fake applies main's fence rule: the result is `superseded`
// when the session `(epoch, me.id)` changed between the call and the return.

type Resolution = Awaited<ReturnType<Window['clerum']['gfs']['resolveForNavigation']>>
// Bound to the producer's own output: the renderer `.d.ts` mirror declares
// `pathCache` required while the producer leaves it optional (see the fixture
// module's note on `DownloadResult`).
type ResolvedResource = Awaited<ReturnType<typeof resolveResource>>
type ResolvedKind = 'dir' | 'markdown' | 'image' | 'binary'
type Outcome = { kind: ResolvedKind; index: number } | { kind: 'unavailable' }

const RESOURCE_INDEXES = [0, 1, 2] as const
let producedResources: Record<ResolvedKind, ResolvedResource[]>

beforeAll(async () => {
  const build = (make: (index: number) => Parameters<typeof resolveResource>[0]) =>
    Promise.all(RESOURCE_INDEXES.map(index => resolveResource(make(index))))
  producedResources = {
    dir: await build(i => resolvedDirectory(`dir${i}`, `Folder ${i}`)),
    markdown: await build(i => resolvedFile(`md${i}`, `notes-${i}.md`)),
    image: await build(i => resolvedFile(`img${i}`, `photo-${i}.png`)),
    binary: await build(i => resolvedFile(`bin${i}`, `archive-${i}.zip`)),
  }
})

function resourceFor(outcome: Exclude<Outcome, { kind: 'unavailable' }>): ResolvedResource {
  return producedResources[outcome.kind][outcome.index]!
}

function scriptedResolution(outcome: Outcome): Resolution {
  return outcome.kind === 'unavailable'
    ? { status: 'unavailable' }
    : ({ status: 'resolved', resource: resourceFor(outcome) } as Resolution)
}

function tabKey(tab: WorkspaceTab): string {
  switch (tab.kind) {
    case 'files':
      return `files:${tab.files?.path ?? 'root'}`
    case 'preview':
      return `preview:${tab.preview?.gfsUri}:${tab.preview?.fileKind}`
    case 'settings':
      return `settings:${tab.settings?.section}`
    default:
      return tab.kind
  }
}

/** Independent of `gfsResourceOpenTarget`: the destination L1 requires per kind. */
function expectedDestinationKey(outcome: Exclude<Outcome, { kind: 'unavailable' }>): string {
  const { gfsUri } = resourceFor(outcome)
  switch (outcome.kind) {
    case 'dir':
    case 'binary':
      return `files:${gfsUri}`
    case 'markdown':
      return `preview:${gfsUri}:markdown`
    case 'image':
      return `preview:${gfsUri}:image`
  }
}

const SETTINGS_ROUTE = {
  plugins: DESKTOP_ROUTES.plugins,
  settings: DESKTOP_ROUTES.settings,
  agents: DESKTOP_ROUTES.agents,
  connectors: DESKTOP_ROUTES.connectors,
} as const satisfies Record<SettingsSection, string>

type Gate = (label: string) => Promise<void>

// The core is fired from a click handler with `void`: a rejection would be an
// unhandled error in production, so every activation must settle fulfilled.
const activationRejections: unknown[] = []
const warnSpies: Array<{ mockRestore: () => void }> = []

function manualGates() {
  const releases: Array<() => void> = []
  const gate: Gate = () => new Promise<void>(resolve => releases.push(resolve))
  return {
    gate,
    async release(index: number) {
      await act(async () => {
        releases[index]!()
      })
    },
  }
}

function createHarness(gate: Gate) {
  const session = { epoch: 1, meId: 'user-a' }
  let userNavigationGeneration = 0
  let nextOutcome: Outcome = { kind: 'unavailable' }
  let nextOpenUrlRejects = false
  let nextOpenUrlThrowsSync = false
  let nextResolveRejects = false
  const resolveCalls: string[] = []
  const completions: number[] = []
  const pushToast = vi.fn()
  const setVisible = vi.fn()
  const openUrl = vi.fn((url: string): Promise<void> => {
    // A missing bridge method throws before any promise exists.
    if (nextOpenUrlThrowsSync) throw new TypeError('window.clerum.app.openUrl is not a function')
    // Electron forwards main's error message across `invoke`, and a launch
    // failure there may name the target, so the rejection carries the URL.
    return nextOpenUrlRejects
      ? Promise.reject(new Error(`Error invoking remote method 'app:openUrl': ${url}`))
      : Promise.resolve()
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  warnSpies.push(warn)
  const resolveForNavigation = vi.fn(async (uri: string): Promise<Resolution> => {
    const callId = resolveCalls.push(uri) - 1
    const outcome = nextOutcome
    const captured = { ...session }
    const rejects = nextResolveRejects
    await gate(`resolve #${callId} ${uri}`)
    completions.push(callId)
    if (rejects) throw new Error('resolve bridge failed')
    if (captured.epoch !== session.epoch || captured.meId !== session.meId) {
      return { status: 'superseded' }
    }
    return scriptedResolution(outcome)
  })
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        advanceUserNavigationGeneration: () => ++userNavigationGeneration,
        getUserNavigationGeneration: () => userNavigationGeneration,
        resolveForNavigation,
      },
      app: { openUrl },
      sandboxUi: { setVisible },
    } as unknown as Window['clerum'],
  })

  const hook = renderHook(() => useNavigationController())
  const nav = () => hook.result.current
  const activate: ChatLinkActivation = createChatLinkActivation({
    beginUserNavigationIntent: nav().beginUserNavigationIntent,
    isNavigationIntentCurrent: nav().isNavigationIntentCurrent,
    openPreviewSection: nav().openPreviewSection,
    openFilesSection: nav().openFilesSection,
    pushToast,
    resolveForNavigation: uri => window.clerum.gfs.resolveForNavigation(uri),
    openUrl: url => window.clerum.app.openUrl(url),
  })

  return {
    session,
    resolveCalls,
    completions,
    pushToast,
    setVisible,
    openUrl,
    warn,
    nav,
    tabs: () => nav().workspaceTabs.tabs.map(tabKey),
    activeKey: () => {
      const tab = activeWorkspaceTab(nav().workspaceTabs)
      return tab ? tabKey(tab) : null
    },
    async clickGfs(href: string, outcome: Outcome) {
      nextOutcome = outcome
      await act(async () => {
        void activate(href).catch(error => activationRejections.push(error))
      })
    },
    async clickGfsRejecting(href: string) {
      nextResolveRejects = true
      await act(async () => {
        void activate(href).catch(error => activationRejections.push(error))
      })
      nextResolveRejects = false
    },
    async clickWeb(href: string, rejects = false, throwsSync = false) {
      nextOpenUrlRejects = rejects
      nextOpenUrlThrowsSync = throwsSync
      await act(async () => {
        void activate(href).catch(error => activationRejections.push(error))
      })
    },
    async userNavigation(section: SettingsSection | 'files-root') {
      await act(async () => {
        nav().handleNavSelect(
          section === 'files-root' ? DESKTOP_ROUTES.files : SETTINGS_ROUTE[section]
        )
      })
    },
    async logout() {
      session.epoch += 1
      session.meId = `${session.meId}+`
      await act(async () => nav().resetSessionNavigation())
    },
    switchTeam() {
      session.epoch += 1
    },
    switchAccount() {
      session.epoch += 1
      session.meId = `${session.meId}+`
    },
    async pluginOpensPreview(outcome: { kind: 'markdown' | 'image'; index: number }) {
      const resource = resourceFor(outcome)
      const preview = resolveGfsPreview({
        gfsUri: resource.gfsUri,
        name: resource.name,
        bytes: resource.bytes ?? 0,
        version: resource.version,
      })!
      await act(async () => nav().openPreviewSection(preview))
    },
    unmount: () => hook.unmount(),
  }
}

type Harness = ReturnType<typeof createHarness>

afterEach(() => {
  cleanup()
  delete (window as { clerum?: unknown }).clerum
  for (const spy of warnSpies.splice(0)) spy.mockRestore()
  const rejections = activationRejections.splice(0)
  expect(rejections).toEqual([])
})

const MD0 = { kind: 'markdown', index: 0 } as const
const DIR0 = { kind: 'dir', index: 0 } as const
const DIR1 = { kind: 'dir', index: 1 } as const

describe('chat link activation — scenarios', () => {
  it('opens a folder in Files at the resolved gfsUri, and a previewable file or image in Preview (L1)', async () => {
    const { gate, release } = manualGates()
    const h = createHarness(gate)
    await h.clickGfs('gfs://main/dir0', DIR0)
    await release(0)
    expect(h.activeKey()).toBe(`files:${resourceFor(DIR0).gfsUri}`)

    await h.clickGfs('gfs://main/md0', MD0)
    await release(1)
    expect(h.activeKey()).toBe(`preview:${resourceFor(MD0).gfsUri}:markdown`)

    await h.clickGfs('gfs://main/img0', { kind: 'image', index: 0 })
    await release(2)
    expect(h.activeKey()).toBe(`preview:gfs://main/img0:image`)

    await h.clickGfs('gfs://main/bin0', { kind: 'binary', index: 0 })
    await release(3)
    expect(h.activeKey()).toBe('files:gfs://main/bin0')
    expect(h.pushToast).not.toHaveBeenCalled()
    expect(h.setVisible).not.toHaveBeenCalled()
  })

  it('routes to the gfsUri the resolve returned, not the clicked href', async () => {
    const { gate, release } = manualGates()
    const h = createHarness(gate)
    await h.clickGfs('gfs://shared/dir1', DIR1)
    await release(0)
    expect(h.resolveCalls).toEqual(['gfs://shared/dir1'])
    expect(h.activeKey()).toBe(`files:${resourceFor(DIR1).gfsUri}`)
  })

  it('S-2: a second gfs click before the first resolves wins, whatever order they return in', async () => {
    const { gate, release } = manualGates()
    const h = createHarness(gate)
    await h.clickGfs('gfs://main/dir0', DIR0)
    await h.clickGfs('gfs://main/md0', MD0)
    await release(1)
    await release(0)
    expect(h.tabs()).toEqual(['chat', `preview:${resourceFor(MD0).gfsUri}:markdown`])
    expect(h.activeKey()).toBe(`preview:${resourceFor(MD0).gfsUri}:markdown`)
  })

  it('S-3: user navigation during the resolve keeps the tabs the user chose', async () => {
    const { gate, release } = manualGates()
    const h = createHarness(gate)
    await h.clickGfs('gfs://main/dir0', DIR0)
    await h.userNavigation('plugins')
    await release(0)
    expect(h.tabs()).toEqual(['chat', 'settings:plugins'])
    expect(h.activeKey()).toBe('settings:plugins')
    expect(h.pushToast).not.toHaveBeenCalled()
  })

  it('S-3: an unavailable resolve after user navigation shows no toast', async () => {
    const { gate, release } = manualGates()
    const h = createHarness(gate)
    await h.clickGfs('gfs://main/gone', { kind: 'unavailable' })
    await h.userNavigation('files-root')
    await release(0)
    expect(h.activeKey()).toBe('files:root')
    expect(h.pushToast).not.toHaveBeenCalled()
  })

  it('S-5a: logout during the resolve opens nothing and shows no toast', async () => {
    const { gate, release } = manualGates()
    const h = createHarness(gate)
    await h.clickGfs('gfs://main/dir0', DIR0)
    await h.logout()
    await release(0)
    expect(h.tabs()).toEqual(['chat'])
    expect(h.pushToast).not.toHaveBeenCalled()
  })

  it('S-5a: logout in main before the renderer reset still drops the click silently', async () => {
    const { gate, release } = manualGates()
    const h = createHarness(gate)
    await h.clickGfs('gfs://main/gone', { kind: 'unavailable' })
    h.switchAccount()
    await release(0)
    expect(h.tabs()).toEqual(['chat'])
    expect(h.pushToast).not.toHaveBeenCalled()
  })

  it('S-5b: a team switch that commits during the resolve drops the click; one committed before it does not', async () => {
    const { gate, release } = manualGates()
    const h = createHarness(gate)
    await h.clickGfs('gfs://main/dir0', DIR0)
    h.switchTeam()
    await release(0)
    expect(h.tabs()).toEqual(['chat'])

    await h.clickGfs('gfs://main/dir1', DIR1)
    await release(1)
    expect(h.activeKey()).toBe(`files:${resourceFor(DIR1).gfsUri}`)
  })

  it('S-5c: a different account logging in during the resolve drops the click', async () => {
    const { gate, release } = manualGates()
    const h = createHarness(gate)
    await h.clickGfs('gfs://main/md0', MD0)
    h.switchAccount()
    await release(0)
    expect(h.tabs()).toEqual(['chat'])
    expect(h.pushToast).not.toHaveBeenCalled()
  })

  it('S-5d: a transient team hop that changes neither epoch nor me.id still opens', async () => {
    const { gate, release } = manualGates()
    const h = createHarness(gate)
    await h.clickGfs('gfs://main/md0', MD0)
    await release(0)
    expect(h.activeKey()).toBe(`preview:${resourceFor(MD0).gfsUri}:markdown`)
  })

  it('S-7: an unavailable location shows exactly one toast and leaves the tabs alone (L2)', async () => {
    const { gate, release } = manualGates()
    const h = createHarness(gate)
    await h.userNavigation('plugins')
    const before = { tabs: h.tabs(), active: h.activeKey() }
    await h.clickGfs('gfs://main/gone', { kind: 'unavailable' })
    await release(0)
    expect(h.pushToast.mock.calls).toEqual([[CHAT_GFS_LINK_UNAVAILABLE_MESSAGE, 'error']])
    expect({ tabs: h.tabs(), active: h.activeKey() }).toEqual(before)
  })

  it('S-8: a web click with a gfs resolve pending opens only the browser', async () => {
    const { gate, release } = manualGates()
    const h = createHarness(gate)
    await h.clickGfs('gfs://main/dir0', DIR0)
    await h.clickWeb('https://evenfire.ai/')
    await release(0)
    expect(h.openUrl.mock.calls).toEqual([['https://evenfire.ai/']])
    expect(h.tabs()).toEqual(['chat'])
    expect(h.pushToast).not.toHaveBeenCalled()
  })

  it('opens http, https and mailto links externally; a failed launch shows nothing (L3)', async () => {
    const h = createHarness(manualGates().gate)
    await h.clickWeb('http://example.com/')
    await h.clickWeb('HTTPS://evenfire.ai/', true)
    await h.clickWeb('mailto:a@b.c')
    expect(h.openUrl.mock.calls).toEqual([
      ['http://example.com/'],
      ['HTTPS://evenfire.ai/'],
      ['mailto:a@b.c'],
    ])
    expect(h.tabs()).toEqual(['chat'])
    expect(h.pushToast).not.toHaveBeenCalled()
    expect(h.resolveCalls).toEqual([])
  })

  it('logs a failed external launch without the URL, and logs nothing when it succeeds', async () => {
    const h = createHarness(manualGates().gate)
    await h.clickWeb('https://evenfire.ai/private-path?q=secret')
    expect(h.openUrl.mock.calls).toEqual([['https://evenfire.ai/private-path?q=secret']])
    expect(h.warn).not.toHaveBeenCalled()

    await h.clickWeb('mailto:someone@example.com', true)
    await h.clickWeb('https://evenfire.ai/other', false, true)

    expect(h.openUrl).toHaveBeenCalledTimes(3)
    expect(h.warn).toHaveBeenCalledTimes(2)
    const logged = h.warn.mock.calls.map(call => call.map(String).join(' '))
    expect(logged[0]).toContain('external link open failed')
    expect(logged[0]).toContain('Error')
    expect(logged[1]).toContain('TypeError')
    for (const line of logged) {
      expect(line).not.toContain('someone@example.com')
      expect(line).not.toContain('evenfire.ai')
    }
    expect(h.pushToast).not.toHaveBeenCalled()
  })

  it('settles fulfilled and shows nothing when openUrl throws synchronously', async () => {
    const h = createHarness(manualGates().gate)
    await h.clickWeb('https://evenfire.ai/', false, true)
    expect(h.openUrl.mock.calls).toEqual([['https://evenfire.ai/']])
    expect(activationRejections).toEqual([])
    expect(h.pushToast).not.toHaveBeenCalled()
    expect(h.tabs()).toEqual(['chat'])
  })

  it('a rejected resolve with the click still current shows exactly one toast and leaves the tabs alone', async () => {
    const { gate, release } = manualGates()
    const h = createHarness(gate)
    await h.userNavigation('plugins')
    const before = { tabs: h.tabs(), active: h.activeKey() }
    await h.clickGfsRejecting('gfs://main/dir0')
    await release(0)
    expect(h.completions).toEqual([0])
    expect(h.pushToast.mock.calls).toEqual([[CHAT_GFS_LINK_UNAVAILABLE_MESSAGE, 'error']])
    expect({ tabs: h.tabs(), active: h.activeKey() }).toEqual(before)
  })

  it('a rejected resolve after a user navigation is silent and keeps the tabs the user chose', async () => {
    const { gate, release } = manualGates()
    const h = createHarness(gate)
    await h.clickGfsRejecting('gfs://main/dir0')
    await h.userNavigation('plugins')
    await release(0)
    expect(h.completions).toEqual([0])
    expect(h.pushToast).not.toHaveBeenCalled()
    expect(h.tabs()).toEqual(['chat', 'settings:plugins'])
    expect(h.activeKey()).toBe('settings:plugins')
  })

  it('ignores relative, fragment and unknown-scheme hrefs', async () => {
    const h = createHarness(manualGates().gate)
    for (const href of ['', './nueva-carpeta', '#fn-1', 'javascript:alert(1)', 'file:///etc']) {
      await h.clickWeb(href)
    }
    expect(h.openUrl).not.toHaveBeenCalled()
    expect(h.resolveCalls).toEqual([])
    expect(h.tabs()).toEqual(['chat'])
  })

  it('treats the gfs scheme case-insensitively', async () => {
    const { gate, release } = manualGates()
    const h = createHarness(gate)
    await h.clickGfs('GFS://main/dir0', DIR0)
    await release(0)
    expect(h.resolveCalls).toEqual(['GFS://main/dir0'])
    expect(h.activeKey()).toBe(`files:${resourceFor(DIR0).gfsUri}`)
  })
})

// ---------------------------------------------------------------------------
// Model: "the last navigation event wins; a stale or superseded resolve has no
// effect". The scheduler decides when each pending resolve returns.
// ---------------------------------------------------------------------------

interface PendingClick {
  seq: number
  sessionVersion: number
  outcome: Outcome
}

interface RefModel {
  tabs: string[]
  active: string
  navSeq: number
  sessionVersion: number
  toasts: number
  gfsClicks: number
  openUrls: string[]
  pending: Map<number, PendingClick>
  appliedCompletions: number
}

function initialRefModel(): RefModel {
  return {
    tabs: ['chat'],
    active: 'chat',
    navSeq: 0,
    sessionVersion: 0,
    toasts: 0,
    gfsClicks: 0,
    openUrls: [],
    pending: new Map(),
    appliedCompletions: 0,
  }
}

function openInModel(model: RefModel, key: string) {
  if (!model.tabs.includes(key)) model.tabs.push(key)
  model.active = key
  model.navSeq += 1
}

function applyCompletions(model: RefModel, real: Harness) {
  for (const callId of real.completions.slice(model.appliedCompletions)) {
    const click = model.pending.get(callId)!
    model.pending.delete(callId)
    if (click.seq !== model.navSeq || click.sessionVersion !== model.sessionVersion) continue
    if (click.outcome.kind === 'unavailable') model.toasts += 1
    else openInModel(model, expectedDestinationKey(click.outcome))
  }
  model.appliedCompletions = real.completions.length
}

function assertAtRest(model: RefModel, real: Harness) {
  expect(real.tabs()).toEqual(model.tabs)
  expect(real.activeKey()).toBe(model.active)
  expect(real.pushToast).toHaveBeenCalledTimes(model.toasts)
  for (const call of real.pushToast.mock.calls) {
    expect(call).toEqual([CHAT_GFS_LINK_UNAVAILABLE_MESSAGE, 'error'])
  }
  expect(real.resolveCalls).toHaveLength(model.gfsClicks)
  expect(real.openUrl.mock.calls.map(([url]) => url)).toEqual(model.openUrls)
  expect(real.setVisible).not.toHaveBeenCalled()
  expect(activationRejections).toEqual([])
}

type ModelHarness = Harness & { scheduler: Scheduler }
type Cmd = AsyncCommand<RefModel, ModelHarness>

const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
  fc.record({
    kind: fc.constantFrom<ResolvedKind>('dir', 'markdown', 'image', 'binary'),
    index: fc.constantFrom(...RESOURCE_INDEXES),
  }),
  fc.constant({ kind: 'unavailable' } as const)
)

class GfsClick implements Cmd {
  constructor(readonly outcome: Outcome) {}
  check = () => true
  async run(model: RefModel, real: ModelHarness) {
    const callId = model.gfsClicks
    model.gfsClicks += 1
    model.navSeq += 1
    model.pending.set(callId, {
      seq: model.navSeq,
      sessionVersion: model.sessionVersion,
      outcome: this.outcome,
    })
    await real.clickGfs(`gfs://main/click-${callId}`, this.outcome)
  }
  toString = () => `E1(${JSON.stringify(this.outcome)})`
}

class ReleaseOne implements Cmd {
  check = (model: Readonly<RefModel>) => model.pending.size > 0
  async run(model: RefModel, real: ModelHarness) {
    await act(async () => {
      await real.scheduler.waitOne()
    })
    applyCompletions(model, real)
  }
  toString = () => 'H1:release'
}

class UserNavigation implements Cmd {
  constructor(readonly target: SettingsSection | 'files-root') {}
  check = () => true
  async run(model: RefModel, real: ModelHarness) {
    openInModel(model, this.target === 'files-root' ? 'files:root' : `settings:${this.target}`)
    await real.userNavigation(this.target)
  }
  toString = () => `E3(${this.target})`
}

class Logout implements Cmd {
  check = () => true
  async run(model: RefModel, real: ModelHarness) {
    model.sessionVersion += 1
    model.navSeq += 1
    model.tabs = ['chat']
    model.active = 'chat'
    await real.logout()
  }
  toString = () => 'E5a'
}

class TeamSwitch implements Cmd {
  check = () => true
  async run(model: RefModel, real: ModelHarness) {
    model.sessionVersion += 1
    real.switchTeam()
  }
  toString = () => 'E5b'
}

class TransientTeamHop implements Cmd {
  check = () => true
  async run() {}
  toString = () => 'E5d'
}

class PluginOpensPreview implements Cmd {
  constructor(readonly outcome: { kind: 'markdown' | 'image'; index: number }) {}
  check = () => true
  async run(model: RefModel, real: ModelHarness) {
    openInModel(model, expectedDestinationKey(this.outcome))
    await real.pluginOpensPreview(this.outcome)
  }
  toString = () => `E7(${JSON.stringify(this.outcome)})`
}

class WebClick implements Cmd {
  constructor(
    readonly href: string,
    readonly rejects: boolean
  ) {}
  check = () => true
  async run(model: RefModel, real: ModelHarness) {
    model.navSeq += 1
    model.openUrls.push(this.href)
    await real.clickWeb(this.href, this.rejects)
  }
  toString = () => `E9(${this.href}${this.rejects ? ', rejects' : ''})`
}

const commandArbs: fc.Arbitrary<Cmd>[] = [
  outcomeArb.map(outcome => new GfsClick(outcome)),
  fc.constant(new ReleaseOne()),
  fc.constant(new ReleaseOne()),
  fc
    .constantFrom<SettingsSection | 'files-root'>('plugins', 'settings', 'files-root')
    .map(target => new UserNavigation(target)),
  fc.constant(new Logout()),
  fc.constant(new TeamSwitch()),
  fc.constant(new TransientTeamHop()),
  fc
    .record({
      kind: fc.constantFrom<'markdown' | 'image'>('markdown', 'image'),
      index: fc.constantFrom(...RESOURCE_INDEXES),
    })
    .map(outcome => new PluginOpensPreview(outcome)),
  fc
    .record({
      href: fc.constantFrom('https://evenfire.ai/', 'http://example.com/', 'mailto:a@b.c'),
      rejects: fc.boolean(),
    })
    .map(({ href, rejects }) => new WebClick(href, rejects)),
]

const commandsArb = fc.commands(commandArbs, { maxCommands: 16 })

describe('chat link activation — model (A6)', () => {
  it('matches the reference model at rest for any event sequence and resolve order', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), commandsArb, async (scheduler, commands) => {
        const real = Object.assign(
          createHarness(label => scheduler.schedule(Promise.resolve(), label)),
          { scheduler }
        )
        const model = initialRefModel()
        try {
          await fc.asyncModelRun(() => ({ model, real }), commands)
          await act(async () => {
            await scheduler.waitAll()
          })
          applyCompletions(model, real)
          assertAtRest(model, real)
        } finally {
          real.unmount()
          cleanup()
          delete (window as { clerum?: unknown }).clerum
        }
      }),
      { numRuns: 200 }
    )
  }, 120_000)
})
