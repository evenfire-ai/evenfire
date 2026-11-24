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
  unavailableNavigation,
} from '../../gfs/__fixtures__/navigationResolutionFixtures'
import { gfsWatchKey } from '../../lib/gfsWatchKeys'
import { fileUrisOfWatchEvent } from '../../lib/tabReferenceSuggestion'
import {
  activeWorkspaceTab,
  createEmptyWorkspaceTabsState,
  openFilesTab,
} from '../../lib/workspaceTabs'
import { useTabReferenceSuggestion } from '../useTabReferenceSuggestion'
import type { TabReferenceSuggestionInput } from '../useTabReferenceSuggestion.types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const A_ID = '7d1e2f3a-4b5c-4d6e-8f7a-0000000000a1'
const B_ID = '7d1e2f3a-4b5c-4d6e-8f7a-0000000000b2'
const FILE_ID = '0b9f3c1e-7a42-4d4e-9c1a-5f6e7d8c9b0a'
const SCOPE = 'dev:true:user-1:'
const [FIRST_RETRY_MS, SECOND_RETRY_MS] = TAB_REFERENCE_RETRY_DELAYS_MS

let folderA: ResolvedGfsResource
let folderB: ResolvedGfsResource
let fileInA: ResolvedGfsResource
let A: string
let B: string
let FILE: string
const answers = {} as {
  folderA: NavigationResolution
  folderB: NavigationResolution
  fileInA: NavigationResolution
  /** gfsc says the URI open as a folder is a file. */
  aAsFile: NavigationResolution
  /** gfsc answers with another folder than the one asked for. */
  bForA: NavigationResolution
  unavailable: NavigationResolution
}
let aDirChanged: GfsWatchEvent

beforeAll(async () => {
  folderA = await gfscResourceView({
    resourceId: A_ID,
    name: 'Reports',
    kind: 'directory',
    version: 1,
    bytes: 0,
  })
  folderB = await gfscResourceView({
    resourceId: B_ID,
    name: 'Invoices',
    kind: 'directory',
    version: 1,
    bytes: 0,
  })
  fileInA = await gfscResourceView({
    resourceId: FILE_ID,
    parentResourceId: A_ID,
    name: 'q3.md',
    version: 2,
    bytes: 11,
  })
  A = folderA.gfsUri
  B = folderB.gfsUri
  FILE = fileInA.gfsUri
  answers.folderA = await resolvedNavigation(folderA)
  answers.folderB = await resolvedNavigation(folderB)
  answers.fileInA = await resolvedNavigation(fileInA)
  answers.aAsFile = await resolvedNavigation(
    await gfscResourceView({ resourceId: A_ID, name: 'Reports', version: 1, bytes: 3 })
  )
  answers.bForA = await resolvedNavigation(folderB, A)
  answers.unavailable = await unavailableNavigation(A)

  // The children the agent creates inside A arrive on A's folder key.
  const source = await new GfsWatchEventSource().start([gfsWatchKey('dir', A)!])
  try {
    aDirChanged = (await source.changed([gfsWatchKey('dir', A)!])).find(
      event => event.type === 'changed'
    )!
  } finally {
    await source.stop()
  }
})

type PendingCall = { uri: string; resolve: (answer: NavigationResolution) => void }
let calls: PendingCall[]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  calls = []
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        resolveForNavigation: (uri: string) =>
          new Promise<NavigationResolution>(resolve => {
            calls.push({ uri, resolve })
          }),
      },
    } as unknown as Window['clerum'],
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function settle(call: PendingCall | undefined, answer: NavigationResolution) {
  if (!call) throw new Error('no such resolve call')
  await act(async () => {
    call.resolve(answer)
  })
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function filesInput(uri: string, kind: 'file' | 'directory'): TabReferenceSuggestionInput {
  return {
    activeTab: activeWorkspaceTab(
      openFilesTab(createEmptyWorkspaceTabsState(), { id: 'files-1', path: uri })
    ),
    navItem: DESKTOP_ROUTES.files,
    filesResolvedLocation: { gfsUri: uri, kind },
    authorityScope: SCOPE,
    drawerVisible: true,
  }
}

const onFolder = (uri: string) => filesInput(uri, 'directory')

function mount(input: TabReferenceSuggestionInput) {
  return renderHook((props: TabReferenceSuggestionInput) => useTabReferenceSuggestion(props), {
    initialProps: input,
  })
}

/** The folder reference the composer would hold for the same gfsc view. */
function folderReferenceOf(view: ResolvedGfsResource) {
  return {
    id: `global-folder:${view.drive}:${view.resourceId}`,
    type: 'global_folder',
    resourceId: view.resourceId,
    drive: view.drive,
    gfsUri: view.gfsUri,
    label: view.name,
  }
}

describe('useTabReferenceSuggestion — folders', () => {
  it('offers the folder Files is open on as a folder reference', async () => {
    const hook = mount(onFolder(A))
    expect(calls.map(call => call.uri)).toEqual([A])
    await settle(calls[0], answers.folderA)
    expect(hook.result.current.candidate).toEqual(folderReferenceOf(folderA))
  })

  it('S-F1: navigating from folder A to folder B drops A and offers B', async () => {
    const hook = mount(onFolder(A))
    hook.rerender(onFolder(B))
    expect(calls.map(call => call.uri)).toEqual([A, B])
    await settle(calls[1], answers.folderB)
    await settle(calls[0], answers.folderA)
    expect(hook.result.current.candidate).toEqual(folderReferenceOf(folderB))
  })

  it('S-F3: a folder that cannot be resolved is retried and then offered as nothing', async () => {
    const hook = mount(onFolder(A))
    await settle(calls[0], answers.unavailable)
    await advance(FIRST_RETRY_MS)
    await settle(calls[1], answers.unavailable)
    await advance(SECOND_RETRY_MS)
    await settle(calls[2], answers.unavailable)
    await advance(SECOND_RETRY_MS * 2)
    expect(calls).toHaveLength(3)
    expect(hook.result.current.candidate).toBeNull()
  })

  it('S-F3: a cached folder that is deleted and revisited is retried, then gone', async () => {
    const hook = mount(onFolder(A))
    await settle(calls[0], answers.folderA)
    expect(hook.result.current.candidate).toEqual(folderReferenceOf(folderA))
    // Leave for B and come back: the one cached entry now holds B.
    hook.rerender(onFolder(B))
    await settle(calls[1], answers.folderB)
    hook.rerender(onFolder(A))
    await settle(calls[2], answers.unavailable)
    await advance(FIRST_RETRY_MS)
    await settle(calls[3], answers.unavailable)
    await advance(SECOND_RETRY_MS)
    await settle(calls[4], answers.unavailable)
    expect(calls).toHaveLength(5)
    expect(hook.result.current.candidate).toBeNull()
  })

  it('S-F4: moving from a folder to a file inside it drops the folder and offers the file', async () => {
    const hook = mount(onFolder(A))
    hook.rerender(filesInput(FILE, 'file'))
    expect(calls.map(call => call.uri)).toEqual([A, FILE])
    await settle(calls[0], answers.folderA)
    expect(hook.result.current.candidate).toBeNull()
    await settle(calls[1], answers.fileInA)
    expect(hook.result.current.candidate).toMatchObject({ type: 'global_file', gfsUri: FILE })
  })

  it('S-F4: a cached folder is not offered once Files moves to a file inside it', async () => {
    const hook = mount(onFolder(A))
    await settle(calls[0], answers.folderA)
    hook.rerender(filesInput(FILE, 'file'))
    expect(hook.result.current.candidate).toBeNull()
  })

  it('S-F5: changes inside the folder ask nothing again', async () => {
    const hook = mount(onFolder(A))
    await settle(calls[0], answers.folderA)
    act(() => {
      for (const uri of fileUrisOfWatchEvent(aDirChanged)) hook.result.current.invalidate(uri)
    })
    // Even a change reported for the folder itself leaves its key alone.
    act(() => hook.result.current.invalidate(A))
    await advance(SECOND_RETRY_MS * 2)
    expect(calls).toHaveLength(1)
    expect(hook.result.current.candidate).toEqual(folderReferenceOf(folderA))
  })

  it('Q2: a file open in Files is offered as the file, never as its folder', async () => {
    const hook = mount(filesInput(FILE, 'file'))
    expect(calls.map(call => call.uri)).toEqual([FILE])
    await settle(calls[0], answers.fileInA)
    expect(hook.result.current.candidate?.type).toBe('global_file')
    expect(hook.result.current.candidate?.gfsUri).not.toBe(A)
  })

  it('offers nothing, without retrying, when gfsc says the folder is a file', async () => {
    const hook = mount(onFolder(A))
    await settle(calls[0], answers.aAsFile)
    await advance(SECOND_RETRY_MS * 2)
    expect(calls).toHaveLength(1)
    expect(hook.result.current.candidate).toBeNull()
  })

  // Hardening: the producer resolves a URI to the resource it names.
  it('hardening: does not offer a folder resolved for another URI', async () => {
    const hook = mount(onFolder(A))
    await settle(calls[0], answers.bForA)
    await advance(SECOND_RETRY_MS * 2)
    expect(calls).toHaveLength(1)
    expect(hook.result.current.candidate).toBeNull()
  })
})
