// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { TAB_REFERENCE_RETRY_DELAYS_MS } from '@constants/tabReferenceSuggestion'
import type { ResolvedGfsResource } from '../../../../src/gfs/uriHandler'
import type { GfsWatchEvent } from '../../../../src/types'
import { GfsWatchEventSource } from '../../gfs/__fixtures__/gfsWatchEvents'
import {
  type NavigationResolution,
  gfscResourceView,
  resolvedNavigation,
  supersededNavigation,
  unavailableNavigation,
} from '../../gfs/__fixtures__/navigationResolutionFixtures'
import { gfsWatchKey } from '../../lib/gfsWatchKeys'
import { fileUrisOfWatchEvent } from '../../lib/tabReferenceSuggestion'
import {
  activeWorkspaceTab,
  createEmptyWorkspaceTabsState,
  openFilesTab,
  openPreviewTab,
  openSettingsTab,
  refreshPreviewTab,
} from '../../lib/workspaceTabs'
import type { WorkspaceTabsState } from '../../lib/workspaceTabs.types'
import { useTabReferenceSuggestion } from '../useTabReferenceSuggestion'
import type { TabReferenceSuggestionInput } from '../useTabReferenceSuggestion.types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const A_ID = '0b9f3c1e-7a42-4d4e-9c1a-5f6e7d8c9b0a'
const B_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const SCOPE = 'dev:true:user-1:'
const OTHER_SCOPE = 'dev:true:user-1:team-2'
const [FIRST_RETRY_MS, SECOND_RETRY_MS] = TAB_REFERENCE_RETRY_DELAYS_MS

type Views = {
  a1: ResolvedGfsResource
  a2: ResolvedGfsResource
  b1: ResolvedGfsResource
  aDirectory: ResolvedGfsResource
}
let views: Views
let A: string
let B: string
const answers = {} as {
  a1: NavigationResolution
  a2: NavigationResolution
  b1: NavigationResolution
  aDirectory: NavigationResolution
  bForA: NavigationResolution
  unavailable: NavigationResolution
  superseded: NavigationResolution
}
let aChanged: GfsWatchEvent
let bChanged: GfsWatchEvent

beforeAll(async () => {
  views = {
    a1: await gfscResourceView({ resourceId: A_ID, name: 'report.md', version: 1, bytes: 11 }),
    a2: await gfscResourceView({ resourceId: A_ID, name: 'report.md', version: 2, bytes: 14 }),
    b1: await gfscResourceView({ resourceId: B_ID, name: 'notes.md', version: 1, bytes: 7 }),
    aDirectory: await gfscResourceView({
      resourceId: A_ID,
      name: 'report.md',
      version: 1,
      bytes: 0,
      kind: 'directory',
    }),
  }
  A = views.a1.gfsUri
  B = views.b1.gfsUri
  answers.a1 = await resolvedNavigation(views.a1)
  answers.a2 = await resolvedNavigation(views.a2)
  answers.b1 = await resolvedNavigation(views.b1)
  answers.aDirectory = await resolvedNavigation(views.aDirectory)
  answers.bForA = await resolvedNavigation(views.b1, A)
  answers.unavailable = await unavailableNavigation(A)
  answers.superseded = await supersededNavigation(A)

  const source = await new GfsWatchEventSource().start([
    gfsWatchKey('file', A)!,
    gfsWatchKey('file', B)!,
  ])
  try {
    aChanged = (await source.changed([gfsWatchKey('file', A)!])).find(e => e.type === 'changed')!
    bChanged = (await source.changed([gfsWatchKey('file', B)!])).find(e => e.type === 'changed')!
  } finally {
    await source.stop()
  }
})

type PendingCall = {
  uri: string
  resolve: (answer: NavigationResolution) => void
  reject: (error: unknown) => void
}

let calls: PendingCall[]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  calls = []
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        resolveForNavigation: (uri: string) =>
          new Promise<NavigationResolution>((resolve, reject) => {
            calls.push({ uri, resolve, reject })
          }),
      },
    } as unknown as Window['clerum'],
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const callsFor = (uri: string) => calls.filter(call => call.uri === uri)

async function settle(call: PendingCall | undefined, answer: NavigationResolution | Error) {
  if (!call) throw new Error('no such resolve call')
  await act(async () => {
    if (answer instanceof Error) call.reject(answer)
    else call.resolve(answer)
  })
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function filesInput(uri: string, overrides: Partial<TabReferenceSuggestionInput> = {}) {
  return {
    activeTab: activeWorkspaceTab(
      openFilesTab(createEmptyWorkspaceTabsState(), { id: 'files-1', path: uri })
    ),
    navItem: DESKTOP_ROUTES.files,
    filesResolvedLocation: { gfsUri: uri, kind: 'file' as const },
    authorityScope: SCOPE,
    drawerVisible: true,
    ...overrides,
  } satisfies TabReferenceSuggestionInput
}

function openPreview(uri: string, resourceVersion?: number): WorkspaceTabsState {
  return openPreviewTab(createEmptyWorkspaceTabsState(), {
    id: 'preview-1',
    title: 'report.md',
    gfsUri: uri,
    fileKind: 'markdown',
    byteLength: 11,
    ...(resourceVersion !== undefined ? { resourceVersion } : {}),
  })
}

function previewInput(
  state: WorkspaceTabsState,
  overrides: Partial<TabReferenceSuggestionInput> = {}
) {
  return {
    activeTab: activeWorkspaceTab(state),
    navItem: DESKTOP_ROUTES.preview,
    filesResolvedLocation: null,
    authorityScope: SCOPE,
    drawerVisible: true,
    ...overrides,
  } satisfies TabReferenceSuggestionInput
}

function settingsInput(): TabReferenceSuggestionInput {
  return {
    activeTab: activeWorkspaceTab(
      openSettingsTab(createEmptyWorkspaceTabsState(), { id: 'settings-1', section: 'settings' })
    ),
    navItem: DESKTOP_ROUTES.settings,
    filesResolvedLocation: null,
    authorityScope: SCOPE,
    drawerVisible: true,
  }
}

function mount(input: TabReferenceSuggestionInput, options: { strict?: boolean } = {}) {
  return renderHook((props: TabReferenceSuggestionInput) => useTabReferenceSuggestion(props), {
    initialProps: input,
    reactStrictMode: options.strict ?? false,
  })
}

/** The composer reference the picker would build for the same gfsc view. */
function referenceOf(view: ResolvedGfsResource) {
  return {
    id: `global-file:${view.drive}:${view.resourceId}`,
    type: 'global_file',
    resourceId: view.resourceId,
    drive: view.drive,
    gfsUri: view.gfsUri,
    label: view.name,
    version: view.version,
    bytes: view.bytes,
  }
}

async function cachedOn(uri: string, answer: NavigationResolution) {
  const hook = mount(filesInput(uri))
  await settle(calls.at(-1), answer)
  return hook
}

describe('useTabReferenceSuggestion — fixtures', () => {
  it('resolves gfsc views whose resource id is the UUID and whose URI carries its rid', () => {
    expect(views.a1.resourceId).toBe(A_ID)
    expect(views.a1.rid).toMatch(/^[0-9a-f]{32}$/)
    expect(views.a1.gfsUri).toBe(`gfs://main/${views.a1.rid}`)
    expect(answers.a1).toEqual({ status: 'resolved', resource: views.a1 })
    expect(answers.unavailable).toEqual({ status: 'unavailable' })
    expect(answers.superseded).toEqual({ status: 'superseded' })
  })
})

describe('useTabReferenceSuggestion — target', () => {
  it('offers the resolved file of a Files location', async () => {
    const hook = mount(filesInput(A))
    expect(hook.result.current.candidate).toBeNull()
    expect(calls.map(call => call.uri)).toEqual([A])
    await settle(calls[0], answers.a1)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
  })

  it('offers the resolved file of a preview', async () => {
    const hook = mount(previewInput(openPreview(A, 1)))
    await settle(calls[0], answers.a1)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
  })

  it('asks nothing and offers nothing without a target or with the drawer hidden', async () => {
    const hook = mount(settingsInput())
    hook.rerender(filesInput(A, { drawerVisible: false }))
    hook.rerender(filesInput(A, { navItem: DESKTOP_ROUTES.apps }))
    await advance(SECOND_RETRY_MS * 2)
    expect(calls).toEqual([])
    expect(hook.result.current.candidate).toBeNull()
    // Liveness: the same hook does ask once a target is visible.
    hook.rerender(filesInput(A))
    expect(calls.map(call => call.uri)).toEqual([A])
  })

  it('hides a cached candidate while the drawer is hidden or the tab offers none', async () => {
    const hook = await cachedOn(A, answers.a1)
    expect(hook.result.current.candidate).not.toBeNull()
    hook.rerender(filesInput(A, { drawerVisible: false }))
    expect(hook.result.current.candidate).toBeNull()
    hook.rerender(settingsInput())
    expect(hook.result.current.candidate).toBeNull()
    hook.rerender(filesInput(A))
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
    expect(calls).toHaveLength(1)
  })

  it('mounts in StrictMode with a single resolve', async () => {
    const hook = mount(filesInput(A), { strict: true })
    expect(calls).toHaveLength(1)
    await settle(calls[0], answers.a1)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
    expect(calls).toHaveLength(1)
  })
})

describe('useTabReferenceSuggestion — usability', () => {
  it('caches a folder as nothing to offer and does not retry it', async () => {
    const hook = mount(filesInput(A))
    await settle(calls[0], answers.aDirectory)
    await advance(SECOND_RETRY_MS * 2)
    expect(hook.result.current.candidate).toBeNull()
    expect(calls).toHaveLength(1)
  })

  // Hardening: the producer resolves a URI to the resource it names, so it
  // cannot answer with another file today. The guard keeps a server bug from
  // turning into a reference to the wrong file.
  it('hardening: does not offer a resource resolved for another URI', async () => {
    const hook = mount(filesInput(A))
    await settle(calls[0], answers.bForA)
    await advance(SECOND_RETRY_MS * 2)
    expect(hook.result.current.candidate).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('retries a preview resolve older than the version on screen, then takes the current one', async () => {
    const hook = mount(previewInput(openPreview(A, 2)))
    await settle(calls[0], answers.a1)
    expect(hook.result.current.candidate).toBeNull()
    await advance(FIRST_RETRY_MS - 1)
    expect(calls).toHaveLength(1)
    await advance(1)
    expect(calls).toHaveLength(2)
    await settle(calls[1], answers.a2)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a2))
  })

  it('gives up on a preview whose resolve stays older than the version on screen', async () => {
    const hook = mount(previewInput(openPreview(A, 2)))
    await settle(calls[0], answers.a1)
    await advance(FIRST_RETRY_MS)
    await settle(calls[1], answers.a1)
    await advance(SECOND_RETRY_MS)
    await settle(calls[2], answers.a1)
    await advance(SECOND_RETRY_MS * 2)
    expect(hook.result.current.candidate).toBeNull()
    expect(calls).toHaveLength(3)
  })
})

describe('useTabReferenceSuggestion — latest request wins', () => {
  it('S-1: drops the answer for a target the user left', async () => {
    const hook = mount(filesInput(A))
    hook.rerender(filesInput(B))
    await settle(callsFor(A)[0], answers.a1)
    expect(hook.result.current.candidate).toBeNull()
    await settle(callsFor(B)[0], answers.b1)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.b1))
  })

  it('S-1: an answer for the left target arriving last does not replace the current one', async () => {
    const hook = mount(filesInput(A))
    hook.rerender(filesInput(B))
    await settle(callsFor(B)[0], answers.b1)
    await settle(callsFor(A)[0], answers.a1)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.b1))
  })

  it('S-1b: coming back to a cached target keeps it and drops what was in flight', async () => {
    const hook = await cachedOn(A, answers.a1)
    hook.rerender(filesInput(B))
    expect(hook.result.current.candidate).toBeNull()
    hook.rerender(filesInput(A))
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
    await settle(callsFor(B)[0], answers.b1)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
    expect(callsFor(A)).toHaveLength(1)
  })

  it('S-1c: of two requests for the same key, the later one wins even if it lands first', async () => {
    const hook = mount(filesInput(A))
    hook.rerender(filesInput(B))
    hook.rerender(filesInput(A))
    expect(callsFor(A)).toHaveLength(2)
    await settle(callsFor(A)[1], answers.a2)
    await settle(callsFor(A)[0], answers.a1)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a2))
  })

  it('S-1c: the earlier request landing first is not shown', async () => {
    const hook = mount(filesInput(A))
    hook.rerender(filesInput(B))
    hook.rerender(filesInput(A))
    await settle(callsFor(A)[0], answers.a1)
    expect(hook.result.current.candidate).toBeNull()
    await settle(callsFor(A)[1], answers.a2)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a2))
  })

  it('S-2: a preview reload asks again; an unavailable preview asks nothing', async () => {
    let state = openPreview(A, 1)
    const hook = mount(previewInput(state))
    state = refreshPreviewTab(state, A, {
      status: 'available',
      title: 'report.md',
      fileKind: 'markdown',
      byteLength: 14,
      resourceVersion: 2,
    })
    hook.rerender(previewInput(state))
    expect(calls).toHaveLength(2)
    await settle(calls[0], answers.a1)
    expect(hook.result.current.candidate).toBeNull()
    await settle(calls[1], answers.a2)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a2))

    state = refreshPreviewTab(state, A, { status: 'unavailable', shellTitle: 'File unavailable' })
    hook.rerender(previewInput(state))
    await advance(SECOND_RETRY_MS * 2)
    expect(hook.result.current.candidate).toBeNull()
    expect(calls).toHaveLength(2)
  })

  it('S-3: closing the drawer drops the request in flight; reopening asks again', async () => {
    const hook = mount(filesInput(A))
    hook.rerender(filesInput(A, { drawerVisible: false }))
    await settle(calls[0], answers.a1)
    hook.rerender(filesInput(A))
    expect(hook.result.current.candidate).toBeNull()
    expect(calls).toHaveLength(2)
    await settle(calls[1], answers.a1)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
  })

  it('S-5: a session change drops the request in flight and hides the old candidate', async () => {
    const hook = await cachedOn(A, answers.a1)
    hook.rerender(filesInput(A, { authorityScope: OTHER_SCOPE }))
    expect(hook.result.current.candidate).toBeNull()
    expect(calls).toHaveLength(2)
    hook.rerender(filesInput(A, { authorityScope: SCOPE }))
    hook.rerender(filesInput(A, { authorityScope: OTHER_SCOPE }))
    expect(calls).toHaveLength(3)
    await settle(calls[1], answers.a2)
    expect(hook.result.current.candidate).toBeNull()
    await settle(calls[2], answers.a2)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a2))
  })

  it('S-5: a superseded answer is retried, not cached', async () => {
    const hook = mount(filesInput(A))
    await settle(calls[0], answers.superseded)
    await advance(FIRST_RETRY_MS)
    expect(calls).toHaveLength(2)
    await settle(calls[1], answers.a1)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
  })
})

describe('useTabReferenceSuggestion — retries', () => {
  it('S-9: retries at 2 s and 8 s and gives up on the third failure', async () => {
    const hook = mount(filesInput(A))
    await settle(calls[0], answers.unavailable)
    await advance(FIRST_RETRY_MS - 1)
    expect(calls).toHaveLength(1)
    await advance(1)
    expect(calls).toHaveLength(2)
    await settle(calls[1], answers.superseded)
    await advance(SECOND_RETRY_MS - 1)
    expect(calls).toHaveLength(2)
    await advance(1)
    expect(calls).toHaveLength(3)
    await settle(calls[2], new Error('bridge failed'))
    await advance(SECOND_RETRY_MS * 4)
    expect(calls).toHaveLength(3)
    expect(hook.result.current.candidate).toBeNull()
    // Giving up is final for that key: coming back does not ask again.
    hook.rerender(filesInput(A, { drawerVisible: false }))
    hook.rerender(filesInput(A))
    expect(calls).toHaveLength(3)
  })

  it('S-9: offers the file once a retry succeeds', async () => {
    const hook = mount(filesInput(A))
    await settle(calls[0], new Error('bridge failed'))
    await advance(FIRST_RETRY_MS)
    await settle(calls[1], answers.a1)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
    await advance(SECOND_RETRY_MS * 2)
    expect(calls).toHaveLength(2)
  })

  it('hiding the drawer cancels a pending retry', async () => {
    const hook = mount(filesInput(A))
    await settle(calls[0], answers.unavailable)
    hook.rerender(filesInput(A, { drawerVisible: false }))
    await advance(SECOND_RETRY_MS * 2)
    expect(calls).toHaveLength(1)
    // Liveness: showing the drawer again asks right away.
    hook.rerender(filesInput(A))
    expect(calls).toHaveLength(2)
  })

  it('a retry cancelled by hiding the drawer does not fire after it reopens', async () => {
    const hook = mount(filesInput(A))
    await settle(calls[0], answers.unavailable)
    await advance(FIRST_RETRY_MS / 2)
    hook.rerender(filesInput(A, { drawerVisible: false }))
    await advance(FIRST_RETRY_MS / 4)
    hook.rerender(filesInput(A))
    expect(calls).toHaveLength(2)
    await settle(calls[1], answers.unavailable)
    // The cancelled retry was due here; the next one is a full second backoff away.
    await advance(FIRST_RETRY_MS / 2)
    expect(calls).toHaveLength(2)
    await advance(SECOND_RETRY_MS - FIRST_RETRY_MS / 2)
    expect(calls).toHaveLength(3)
  })

  it('counts only consecutive failures of a key', async () => {
    const hook = mount(filesInput(A))
    await settle(calls[0], answers.unavailable)
    await advance(FIRST_RETRY_MS)
    await settle(calls[1], answers.a1)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
    hook.rerender(filesInput(A, { authorityScope: OTHER_SCOPE }))
    await settle(calls[2], answers.a1)
    hook.rerender(filesInput(A))
    expect(calls).toHaveLength(4)
    // A fresh first failure: the short backoff, and two more attempts.
    await settle(calls[3], answers.unavailable)
    await advance(FIRST_RETRY_MS)
    expect(calls).toHaveLength(5)
    await settle(calls[4], answers.unavailable)
    await advance(SECOND_RETRY_MS)
    expect(calls).toHaveLength(6)
    await settle(calls[5], answers.unavailable)
    await advance(SECOND_RETRY_MS * 2)
    expect(calls).toHaveLength(6)
  })

  it('a retry pending for another key does not fire for the current one', async () => {
    const hook = mount(filesInput(A))
    await settle(calls[0], answers.unavailable)
    await advance(FIRST_RETRY_MS / 2)
    hook.rerender(filesInput(B))
    await settle(callsFor(B)[0], answers.unavailable)
    // A's retry would have fired here; B's own backoff runs from its failure.
    await advance(FIRST_RETRY_MS / 2 + 1)
    expect(callsFor(B)).toHaveLength(1)
    await advance(FIRST_RETRY_MS / 2)
    expect(callsFor(B)).toHaveLength(2)
    expect(callsFor(A)).toHaveLength(1)
  })

  it('sets no retry after the hook unmounts', async () => {
    const hook = mount(filesInput(A))
    hook.unmount()
    await settle(calls[0], answers.unavailable)
    expect(vi.getTimerCount()).toBe(0)
    await advance(SECOND_RETRY_MS * 2)
    expect(calls).toHaveLength(1)
  })
})

describe('useTabReferenceSuggestion — observed changes', () => {
  function invalidateWith(hook: ReturnType<typeof mount>, event: GfsWatchEvent) {
    const uris = fileUrisOfWatchEvent(event)
    expect(uris.length).toBeGreaterThan(0)
    act(() => {
      for (const uri of uris) hook.result.current.invalidate(uri)
    })
  }

  it('keeps invalidate stable across renders', async () => {
    const hook = await cachedOn(A, answers.a1)
    const first = hook.result.current.invalidate
    hook.rerender(filesInput(B))
    expect(hook.result.current.invalidate).toBe(first)
  })

  it('S-10: a watched change of the Files file asks again and offers the new version', async () => {
    const hook = await cachedOn(A, answers.a1)
    invalidateWith(hook, aChanged)
    expect(calls).toHaveLength(2)
    await settle(calls[1], answers.a2)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a2))
  })

  it('S-10: a watched change of another file asks nothing', async () => {
    const hook = await cachedOn(A, answers.a1)
    invalidateWith(hook, bChanged)
    expect(calls).toHaveLength(1)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
  })

  it('S-10b: the old candidate stays during a revalidation and after it fails three times', async () => {
    const hook = await cachedOn(A, answers.a1)
    invalidateWith(hook, aChanged)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
    await settle(calls[1], answers.unavailable)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
    await advance(FIRST_RETRY_MS)
    await settle(calls[2], answers.superseded)
    await advance(SECOND_RETRY_MS)
    await settle(calls[3], new Error('bridge failed'))
    await advance(SECOND_RETRY_MS * 2)
    expect(calls).toHaveLength(4)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
  })

  it('S-10b: a revalidation that resolves to a folder replaces the candidate', async () => {
    const hook = await cachedOn(A, answers.a1)
    invalidateWith(hook, aChanged)
    await settle(calls[1], answers.aDirectory)
    expect(hook.result.current.candidate).toBeNull()
  })

  it('a preview never shows a revalidating candidate older than the version on screen', async () => {
    let state = openPreview(A, 1)
    const hook = mount(previewInput(state))
    await settle(calls[0], answers.a1)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
    state = refreshPreviewTab(state, A, {
      status: 'available',
      title: 'report.md',
      fileKind: 'markdown',
      byteLength: 14,
      resourceVersion: 2,
    })
    hook.rerender(previewInput(state))
    expect(hook.result.current.candidate).toBeNull()
    // Nor once the revalidation gives up.
    await settle(calls[1], answers.unavailable)
    await advance(FIRST_RETRY_MS)
    await settle(calls[2], answers.unavailable)
    await advance(SECOND_RETRY_MS)
    await settle(calls[3], answers.unavailable)
    expect(hook.result.current.candidate).toBeNull()
    expect(calls).toHaveLength(4)
  })

  it('a preview reload of the same version keeps the candidate while it revalidates', async () => {
    let state = openPreview(A, 1)
    const hook = mount(previewInput(state))
    await settle(calls[0], answers.a1)
    state = refreshPreviewTab(state, A, {
      status: 'available',
      title: 'report.md',
      fileKind: 'markdown',
      byteLength: 12,
      resourceVersion: 1,
    })
    hook.rerender(previewInput(state))
    expect(calls).toHaveLength(2)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
  })

  it('S-10c: changes seen away from a cached file make it ask again on return', async () => {
    const hook = await cachedOn(A, answers.a1)
    hook.rerender(filesInput(A, { drawerVisible: false }))
    invalidateWith(hook, aChanged)
    hook.rerender(filesInput(B, { drawerVisible: false }))
    invalidateWith(hook, bChanged)
    hook.rerender(filesInput(A, { drawerVisible: false }))
    expect(calls).toHaveLength(1)
    hook.rerender(filesInput(A))
    expect(callsFor(A)).toHaveLength(2)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
    await settle(callsFor(A)[1], answers.a2)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a2))
  })

  it('S-10c: a revalidation dropped in flight does not let the old key come back', async () => {
    const hook = await cachedOn(A, answers.a1)
    invalidateWith(hook, aChanged)
    const dropped = calls[1]
    hook.rerender(filesInput(B))
    invalidateWith(hook, bChanged)
    hook.rerender(filesInput(A))
    expect(callsFor(A)).toHaveLength(3)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
    await settle(dropped, answers.a1)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
    await settle(callsFor(A)[2], answers.a2)
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a2))
  })

  it('S-10c control: away and back with no change seen asks nothing more', async () => {
    const hook = await cachedOn(A, answers.a1)
    hook.rerender(filesInput(A, { drawerVisible: false }))
    hook.rerender(filesInput(B, { drawerVisible: false }))
    hook.rerender(filesInput(A, { drawerVisible: false }))
    hook.rerender(filesInput(A))
    expect(hook.result.current.candidate).toEqual(referenceOf(views.a1))
    expect(calls).toHaveLength(1)
  })
})
