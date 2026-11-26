import { describe, expect, expectTypeOf, it } from 'vitest'
import fc from 'fast-check'
import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import { DESKTOP_ROUTES } from '@constants/navigation'
import type { FilesPageProps } from '@pages/FilesPage.types'
import type { NavItem } from '@/uiTypes'
import type { GfsWatchEvent } from '../../../../src/types'
import { GfsWatchEventSource } from '../../gfs/__fixtures__/gfsWatchEvents'
import { type WatchHarnessLike, newWatchHarness } from '../../gfs/__fixtures__/mainWatchHarness'
import { gfsRidOfResourceId, gfsWatchKey } from '../gfsWatchKeys'
import {
  bumpRevision,
  deriveTabReferenceTarget,
  fileUrisOfWatchEvent,
} from '../tabReferenceSuggestion'
import type { FilesResolvedLocation, TabReferenceRevision } from '../tabReferenceSuggestion.types'
import {
  activeWorkspaceTab,
  createEmptyWorkspaceTabsState,
  createWorkspaceTabsState,
  openAppTab,
  openFilesTab,
  openPreviewTab,
  openSettingsTab,
  refreshPreviewTab,
  setFilesTabPath,
} from '../workspaceTabs'
import type { OpenPreviewTabInput, WorkspaceTab } from '../workspaceTabs.types'
import { mapKindToRoute } from '../workspaceTabsRoute'

// A Files/preview URI carries the rid gfsc derives from the resource UUID.
const FILE_URI = `gfs://main/${gfsRidOfResourceId('0b9f3c1e-7a42-4d4e-9c1a-5f6e7d8c9b0a')}`
const OTHER_FILE_URI = `gfs://main/${gfsRidOfResourceId('1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f')}`
const THIRD_FILE_URI = `gfs://main/${gfsRidOfResourceId('2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a')}`
const BY_PATH_URI = 'gfs://main/docs/report.md'

function previewTab(input: Partial<OpenPreviewTabInput> = {}): WorkspaceTab {
  const state = openPreviewTab(createEmptyWorkspaceTabsState(), {
    id: 'preview-1',
    title: 'report.md',
    gfsUri: FILE_URI,
    fileKind: 'markdown',
    byteLength: 120,
    ...input,
  })
  return activeWorkspaceTab(state)!
}

function filesTab(path: string | null): WorkspaceTab {
  return activeWorkspaceTab(openFilesTab(createEmptyWorkspaceTabsState(), { id: 'files-1', path }))!
}

/** The target with the tab shown on the route the app navigates to for it. */
function derive(
  tab: WorkspaceTab | undefined,
  location: FilesResolvedLocation,
  revision: TabReferenceRevision
) {
  return deriveTabReferenceTarget(tab, mapKindToRoute(tab), location, revision)
}

/** The Files key of `uri` at `revision`, with Files resolved on that file. */
function filesKeyOf(uri: string, revision: TabReferenceRevision): string {
  return derive(filesTab(uri), { gfsUri: uri, kind: 'file' }, revision)!.prefetchKey
}

describe('FilesResolvedLocation', () => {
  it('is the location FilesPage reports', () => {
    expectTypeOf<
      Parameters<NonNullable<FilesPageProps['onResolvedLocationChange']>>[0]
    >().toEqualTypeOf<FilesResolvedLocation>()
    expectTypeOf<FilesResolvedLocation>().toEqualTypeOf<{
      gfsUri: string
      kind: 'file' | 'directory'
    } | null>()
  })
})

describe('deriveTabReferenceTarget — by active tab', () => {
  it('offers the file of an available preview', () => {
    expect(derive(previewTab(), null, 0)).toEqual({
      gfsUri: FILE_URI,
      prefetchKey: `${FILE_URI}#0#`,
    })
  })

  it('offers nothing for an unavailable preview', () => {
    const state = refreshPreviewTab(
      openPreviewTab(createEmptyWorkspaceTabsState(), {
        id: 'preview-1',
        gfsUri: FILE_URI,
        fileKind: 'markdown',
        byteLength: 120,
      }),
      FILE_URI,
      { status: 'unavailable', shellTitle: 'File unavailable' }
    )
    const tab = activeWorkspaceTab(state)!
    expect(tab.preview?.unavailable).toBe(true)
    expect(derive(tab, null, 0)).toBeNull()
  })

  it('offers the file Files has resolved at its path', () => {
    expect(derive(filesTab(FILE_URI), { gfsUri: FILE_URI, kind: 'file' }, 0)).toEqual({
      gfsUri: FILE_URI,
      prefetchKey: `${FILE_URI}#r0`,
    })
  })

  it('offers the folder Files is on', () => {
    expect(derive(filesTab(FILE_URI), { gfsUri: FILE_URI, kind: 'directory' }, 0)).toEqual({
      kind: 'folder',
      gfsUri: FILE_URI,
      prefetchKey: `${FILE_URI}#folder`,
    })
  })

  it('offers nothing at the Files root', () => {
    const tab = filesTab(null)
    expect(tab.files?.path).toBeNull()
    expect(derive(tab, null, 0)).toBeNull()
  })

  it('offers nothing while the resolved location is still the previous one', () => {
    const opened = openFilesTab(createEmptyWorkspaceTabsState(), { id: 'files-1', path: FILE_URI })
    const tab = activeWorkspaceTab(setFilesTabPath(opened, 'files-1', OTHER_FILE_URI, 'Other'))!
    expect(tab.files?.path).toBe(OTHER_FILE_URI)
    expect(derive(tab, { gfsUri: FILE_URI, kind: 'file' }, 0)).toBeNull()
  })

  it('offers nothing for app, settings or chat tabs', () => {
    const app = activeWorkspaceTab(
      openAppTab(createEmptyWorkspaceTabsState(), { id: 'app-1', appRef: 'notes' })
    )
    const settings = activeWorkspaceTab(
      openSettingsTab(createEmptyWorkspaceTabsState(), { id: 'settings-1', section: 'settings' })
    )
    const chat = activeWorkspaceTab(createWorkspaceTabsState('chat-1'))
    const resolved = { gfsUri: FILE_URI, kind: 'file' } as const
    expect(derive(app, resolved, 0)).toBeNull()
    expect(derive(settings, resolved, 0)).toBeNull()
    expect(derive(chat, resolved, 0)).toBeNull()
    expect(derive(undefined, resolved, 0)).toBeNull()
  })

  it('offers nothing for a URI without a stable rid', () => {
    expect(derive(previewTab({ gfsUri: BY_PATH_URI }), null, 0)).toBeNull()
    expect(derive(filesTab(BY_PATH_URI), { gfsUri: BY_PATH_URI, kind: 'file' }, 0)).toBeNull()
  })

  it('returns the canonical URI when the tab carries an upper-case rid', () => {
    const upper = FILE_URI.replace(/[0-9a-f]{32}$/, rid => rid.toUpperCase())
    expect(derive(previewTab({ gfsUri: upper }), null, 0)?.gfsUri).toBe(FILE_URI)
  })
})

describe('deriveTabReferenceTarget — by route', () => {
  it('offers nothing for a preview while another route covers it', () => {
    const tab = previewTab()
    expect(deriveTabReferenceTarget(tab, DESKTOP_ROUTES.preview, null, 0)).not.toBeNull()
    expect(deriveTabReferenceTarget(tab, DESKTOP_ROUTES.apps, null, 0)).toBeNull()
  })

  it('offers nothing for a Files file while another route covers it', () => {
    const tab = filesTab(FILE_URI)
    const resolved = { gfsUri: FILE_URI, kind: 'file' } as const
    expect(deriveTabReferenceTarget(tab, DESKTOP_ROUTES.files, resolved, 0)).not.toBeNull()
    expect(deriveTabReferenceTarget(tab, DESKTOP_ROUTES.apps, resolved, 0)).toBeNull()
  })

  it('does not take a preview route for a Files tab, nor the reverse', () => {
    const resolved = { gfsUri: FILE_URI, kind: 'file' } as const
    expect(deriveTabReferenceTarget(previewTab(), DESKTOP_ROUTES.files, null, 0)).toBeNull()
    expect(
      deriveTabReferenceTarget(filesTab(FILE_URI), DESKTOP_ROUTES.preview, resolved, 0)
    ).toBeNull()
  })
})

describe('deriveTabReferenceTarget — prefetch key', () => {
  it('keys a preview on its reload and resource versions', () => {
    expect(derive(previewTab({ resourceVersion: 7 }), null, 0)?.prefetchKey).toBe(`${FILE_URI}#0#7`)
  })

  it('re-keys a preview when its entity is invalidated', () => {
    const opened = openPreviewTab(createEmptyWorkspaceTabsState(), {
      id: 'preview-1',
      gfsUri: FILE_URI,
      fileKind: 'markdown',
      byteLength: 120,
      resourceVersion: 7,
    })
    const before = derive(activeWorkspaceTab(opened), null, 0)
    const refreshed = refreshPreviewTab(opened, FILE_URI, {
      status: 'available',
      title: 'report.md',
      fileKind: 'markdown',
      byteLength: 120,
      resourceVersion: 7,
      mimeType: 'text/markdown',
    })
    const tab = activeWorkspaceTab(refreshed)!
    expect(tab.preview?.reloadVersion).toBe(1)
    const after = derive(tab, null, 0)
    expect(after?.prefetchKey).toBe(`${FILE_URI}#1#7`)
    expect(after?.prefetchKey).not.toBe(before?.prefetchKey)
  })

  it('ignores the watch revision for a preview', () => {
    expect(derive(previewTab(), null, 4)?.prefetchKey).toBe(`${FILE_URI}#0#`)
  })

  it('re-keys a Files file only when its own change is counted', () => {
    const before = filesKeyOf(FILE_URI, 0)
    const unrelated = bumpRevision(0, OTHER_FILE_URI, FILE_URI)
    expect(filesKeyOf(FILE_URI, unrelated)).toBe(before)
    const bumped = bumpRevision(unrelated, FILE_URI, FILE_URI)
    expect(filesKeyOf(FILE_URI, bumped)).toBe(`${FILE_URI}#r1`)
  })
})

describe('bumpRevision', () => {
  it('counts a change of the target, by its normalized URI', () => {
    const upper = FILE_URI.replace(/[0-9a-f]{32}$/, rid => rid.toUpperCase())
    expect(bumpRevision(3, upper, FILE_URI)).toBe(4)
  })

  it('ignores a change of anything that is not the target', () => {
    expect(bumpRevision(3, OTHER_FILE_URI, FILE_URI)).toBe(3)
    expect(bumpRevision(3, BY_PATH_URI, FILE_URI)).toBe(3)
    expect(bumpRevision(3, FILE_URI, null)).toBe(3)
  })

  it('never brings a file back to a key it had before a change (A→B→A)', () => {
    let revision: TabReferenceRevision = 0
    const keyBeforeChange = filesKeyOf(FILE_URI, revision)
    revision = bumpRevision(revision, FILE_URI, FILE_URI)
    revision = bumpRevision(revision, OTHER_FILE_URI, OTHER_FILE_URI)
    expect(filesKeyOf(FILE_URI, revision)).not.toBe(keyBeforeChange)
  })
})

// ── watch events, as main's watch client emits them ───────────────────────────

describe('fileUrisOfWatchEvent', () => {
  const fileKey = gfsWatchKey('file', FILE_URI)!
  const otherFileKey = gfsWatchKey('file', OTHER_FILE_URI)!
  const dirKey = gfsWatchKey('dir', THIRD_FILE_URI)!
  /** A fresh real watch client over `keys`, as each renderer suite uses it. */
  async function withSource<T>(keys: string[], run: (source: GfsWatchEventSource) => Promise<T>) {
    const source = await new GfsWatchEventSource().start(keys)
    try {
      return await run(source)
    } finally {
      await source.stop()
    }
  }

  const ofType = <T extends GfsWatchEvent['type']>(events: GfsWatchEvent[], type: T) => {
    const found = events.filter(
      (event): event is Extract<GfsWatchEvent, { type: T }> => event.type === type
    )
    expect(found.length).toBeGreaterThan(0)
    return found
  }

  it('returns the file URIs of a resync when the stream opens', async () => {
    const [resync] = ofType(
      await withSource([], source => source.opened([dirKey, fileKey])),
      'resync'
    )
    expect(resync!.keys).toEqual(expect.arrayContaining([dirKey, fileKey]))
    expect(fileUrisOfWatchEvent(resync!)).toEqual([FILE_URI])
  })

  it('returns the file URIs of a changed event, ignoring folder keys', async () => {
    const [changed] = ofType(
      await withSource([fileKey, dirKey], source => source.changed([fileKey, dirKey])),
      'changed'
    )
    expect(fileUrisOfWatchEvent(changed!)).toEqual([FILE_URI])
  })

  it('returns a key repeated within one event once', async () => {
    const [changed] = ofType(
      await withSource([fileKey], source => source.changed([fileKey, fileKey])),
      'changed'
    )
    expect(changed!.keys).toEqual([fileKey, fileKey])
    expect(fileUrisOfWatchEvent(changed!)).toEqual([FILE_URI])
  })

  it('returns nothing for the keys the server rejected', async () => {
    const harness = await newWatchHarness()
    await harness.start()
    try {
      await harness.login()
      await assertRejectedYieldsNothing(harness)
    } finally {
      await harness.stop()
    }
  })

  async function assertRejectedYieldsNothing(harness: WatchHarnessLike) {
    const server = harness.server as typeof harness.server & {
      putPolicy: () => {
        kind: 'accept'
        decide: (keys: string[]) => { accepted: string[]; rejected: string[]; deferred: string[] }
      }
    }
    server.putPolicy = () => ({
      kind: 'accept',
      decide: keys => ({
        accepted: keys.filter(key => key !== otherFileKey),
        rejected: keys.filter(key => key === otherFileKey),
        deferred: [],
      }),
    })
    const owner = harness.owner(1)
    const from = owner.events.length
    await harness.subscribe([fileKey, otherFileKey])
    const events = owner.events.slice(from)
    const [rejected] = ofType(events, 'rejected')
    expect(rejected!.keys).toEqual([otherFileKey])
    expect(fileUrisOfWatchEvent(rejected!)).toEqual([])
    const [resync] = ofType(events, 'resync')
    expect(fileUrisOfWatchEvent(resync!)).toEqual([FILE_URI])
  }

  it('returns nothing for events without keys', async () => {
    const events = await withSource([fileKey], source => source.rootsChanged([fileKey]))
    ofType(events, 'accessChangedRoots')
    for (const event of events) expect(fileUrisOfWatchEvent(event)).toEqual([])
  })

  it('feeds bumpRevision with the URI the target was watched under', async () => {
    const [changed] = ofType(
      await withSource([fileKey], source => source.changed([fileKey])),
      'changed'
    )
    const target = derive(filesTab(FILE_URI), { gfsUri: FILE_URI, kind: 'file' }, 0)!
    expect(gfsWatchKey('file', target.gfsUri)).toBe(fileKey)
    const revision = fileUrisOfWatchEvent(changed!).reduce(
      (current, uri) => bumpRevision(current, uri, target.gfsUri),
      0
    )
    expect(filesKeyOf(FILE_URI, revision)).toBe(`${FILE_URI}#r1`)
  })
})

// ── properties ────────────────────────────────────────────────────────────────

const hex = fc.constantFrom(...'0123456789abcdefABCDEF'.split(''))
const ridArb = fc.string({ unit: hex, minLength: 32, maxLength: 32 })
const driveArb = fc.constantFrom('main', 'd1', 'drive-2', 'Main.Drive')
const canonicalUriArb = fc
  .tuple(driveArb, ridArb)
  .map(([drive, rid]) => `gfs://${drive}/${rid.toLowerCase()}`)
const anyUriArb = fc.oneof(
  fc.tuple(driveArb, ridArb).map(([drive, rid]) => `gfs://${drive}/${rid}`),
  fc.tuple(driveArb, ridArb).map(([drive, rid]) => `gfs://${drive}/report-${rid}`),
  fc.constant(BY_PATH_URI),
  fc.string({ maxLength: 40 })
)
const revisionArb = fc.nat({ max: 1_000 })

type Step = { op: 'navigate' | 'bump'; uri: string }

/**
 * Runs navigate/bump steps and checks, for every pair of instants and every
 * URI, that its Files key is unchanged iff no change was counted in between,
 * and that the count never goes down. Generic over the revision so the check
 * can also be pointed at a revision that is not a global count.
 */
function assertNoAba<R>(
  steps: Step[],
  uris: string[],
  impl: {
    initial: R
    bump: (revision: R, uri: string, target: string | null) => R
    keyOf: (uri: string, revision: R) => string
  }
): void {
  let revision = impl.initial
  let target: string | null = null
  let counted = 0
  const history: Array<{ counted: number; keys: string[] }> = []
  const snapshot = () => history.push({ counted, keys: uris.map(uri => impl.keyOf(uri, revision)) })
  snapshot()
  for (const step of steps) {
    if (step.op === 'navigate') {
      target = normalizeGfsResourceUri(step.uri)
    } else {
      const next = impl.bump(revision, step.uri, target)
      if (normalizeGfsResourceUri(step.uri) === target && target !== null) counted += 1
      revision = next
    }
    snapshot()
  }
  for (let t1 = 0; t1 < history.length; t1 += 1) {
    for (let t2 = t1 + 1; t2 < history.length; t2 += 1) {
      const changesBetween = history[t2]!.counted - history[t1]!.counted
      uris.forEach((uri, i) => {
        const same = history[t1]!.keys[i] === history[t2]!.keys[i]
        if (same !== (changesBetween === 0)) {
          throw new Error(`ABA on ${uri} between steps ${t1} and ${t2}`)
        }
      })
    }
  }
}

const realRevision = {
  initial: 0 as TabReferenceRevision,
  bump: bumpRevision,
  keyOf: filesKeyOf,
}

describe('properties', () => {
  const pool = [FILE_URI, OTHER_FILE_URI, THIRD_FILE_URI]
  const stepArb: fc.Arbitrary<Step> = fc.record({
    op: fc.constantFrom('navigate' as const, 'bump' as const),
    uri: fc.oneof(
      fc.constantFrom(...pool),
      fc.constantFrom(...pool).map(uri => uri.replace(/[0-9a-f]{32}$/, rid => rid.toUpperCase()))
    ),
  })

  it('no ABA: a file key is unchanged iff no change was counted in between', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 25 }), steps => {
        assertNoAba(steps, pool, realRevision)
      }),
      { numRuns: 2000 }
    )
  })

  it('the no-ABA check rejects a per-file revision that restarts on a new target', () => {
    type Entry = { gfsUri: string; n: number } | null
    const nOf = (entry: Entry, uri: string) => (entry?.gfsUri === uri ? entry.n : 0)
    const restarting = {
      initial: null as Entry,
      bump: (entry: Entry, uri: string, target: string | null): Entry => {
        const gfsUri = normalizeGfsResourceUri(uri)
        return gfsUri !== null && gfsUri === target ? { gfsUri, n: nOf(entry, gfsUri) + 1 } : entry
      },
      keyOf: (uri: string, entry: Entry) => filesKeyOf(uri, nOf(entry, uri)),
    }
    const steps: Step[] = [
      { op: 'navigate', uri: FILE_URI },
      { op: 'bump', uri: FILE_URI },
      { op: 'navigate', uri: OTHER_FILE_URI },
      { op: 'bump', uri: OTHER_FILE_URI },
      { op: 'navigate', uri: FILE_URI },
    ]
    expect(() => assertNoAba(steps, pool, restarting)).toThrow(/ABA/)
    expect(() => assertNoAba(steps, pool, realRevision)).not.toThrow()
  })

  it('a bump changes the revision iff the normalized URI is the target, and never lowers it', () => {
    fc.assert(
      fc.property(
        revisionArb,
        fc.option(canonicalUriArb, { nil: null }),
        fc.oneof(anyUriArb, canonicalUriArb),
        (revision, target, uri) => {
          const next = bumpRevision(revision, uri, target)
          const matches = target !== null && normalizeGfsResourceUri(uri) === target
          expect(next).toBe(matches ? revision + 1 : revision)
          expect(next).toBeGreaterThanOrEqual(revision)
        }
      ),
      { numRuns: 2000 }
    )
  })

  it('a derived target is null or already normalized', () => {
    const tabArb = fc.oneof(
      fc
        .record({
          gfsUri: anyUriArb,
          resourceVersion: fc.option(fc.nat(), { nil: undefined }),
        })
        .map(({ gfsUri, resourceVersion }) =>
          previewTab({ gfsUri, ...(resourceVersion !== undefined ? { resourceVersion } : {}) })
        ),
      fc.option(anyUriArb, { nil: null }).map(filesTab),
      fc.constant(
        activeWorkspaceTab(openAppTab(createEmptyWorkspaceTabsState(), { id: 'a', appRef: 'x' }))!
      )
    )
    const resolvedArb = fc.option(
      fc.record({
        gfsUri: anyUriArb,
        kind: fc.constantFrom('file' as const, 'directory' as const),
      }),
      { nil: null }
    )
    const navArb = fc.constantFrom<NavItem>(...Object.values(DESKTOP_ROUTES))
    fc.assert(
      fc.property(
        tabArb,
        resolvedArb,
        fc.boolean(),
        fc.oneof(navArb, fc.constant(null)),
        revisionArb,
        (tab, resolved, sync, nav, revision) => {
          const location =
            sync && tab.kind === 'files' && tab.files?.path
              ? { gfsUri: tab.files.path, kind: resolved?.kind ?? 'file' }
              : resolved
          const navItem = nav ?? mapKindToRoute(tab)
          const target = deriveTabReferenceTarget(tab, navItem, location, revision)
          if (target === null) return
          expect(navItem).toBe(mapKindToRoute(tab))
          expect(normalizeGfsResourceUri(target.gfsUri)).toBe(target.gfsUri)
          expect(target.prefetchKey.startsWith(`${target.gfsUri}#`)).toBe(true)
        }
      ),
      { numRuns: 2000 }
    )
  })
})
