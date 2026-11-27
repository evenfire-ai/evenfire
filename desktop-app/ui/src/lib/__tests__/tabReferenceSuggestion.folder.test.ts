// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import {
  LOCATION_REFERENCE_MAX_COUNT,
  parseLocationReferenceV1,
} from '@clerum/gfs-interaction-policy'
import { DESKTOP_ROUTES } from '@constants/navigation'
import type { ComposerGlobalFolderReference } from '@/uiTypes'
import {
  folderView,
  suggestedFolderCandidate,
} from '../../hooks/__tests__/__fixtures__/tabReferenceSuggestionFixtures'
import { buildComposerLocationReferences } from '../composerLocationReferences'
import { gfsRidOfResourceId } from '../gfsWatchKeys'
import { deriveTabReferenceTarget } from '../tabReferenceSuggestion'
import { activeWorkspaceTab, createEmptyWorkspaceTabsState, openFilesTab } from '../workspaceTabs'
import type { WorkspaceTab } from '../workspaceTabs.types'

const FOLDER_ID = '7d1e2f3a-4b5c-4d6e-8f7a-000000000001'
const FOLDER_URI = `gfs://main/${gfsRidOfResourceId(FOLDER_ID)}`
const FILE_URI = `gfs://main/${gfsRidOfResourceId('0b9f3c1e-7a42-4d4e-9c1a-5f6e7d8c9b0a')}`

function filesTab(path: string | null): WorkspaceTab {
  return activeWorkspaceTab(openFilesTab(createEmptyWorkspaceTabsState(), { id: 'files-1', path }))!
}

function folderOn(uri: string, revision = 0) {
  return deriveTabReferenceTarget(
    filesTab(uri),
    DESKTOP_ROUTES.files,
    { gfsUri: uri, kind: 'directory' },
    revision
  )
}

// Folder references as the suggestion prefetch builds them from gfsc's view.
let reports: ComposerGlobalFolderReference
let invoices: ComposerGlobalFolderReference

beforeAll(async () => {
  reports = await suggestedFolderCandidate(await folderView(1, 'Reports'))
  invoices = await suggestedFolderCandidate(await folderView(2, 'Invoices'))
})

describe('deriveTabReferenceTarget — folders', () => {
  it('offers the folder Files is open on, with a key no observed change moves', () => {
    for (const revision of [0, 1, 7, 1_000]) {
      expect(folderOn(FOLDER_URI, revision)).toEqual({
        kind: 'folder',
        gfsUri: FOLDER_URI,
        prefetchKey: `${FOLDER_URI}#folder`,
      })
    }
  })

  it('never gives a folder the key of a file at the same URI', () => {
    const asFile = deriveTabReferenceTarget(
      filesTab(FOLDER_URI),
      DESKTOP_ROUTES.files,
      { gfsUri: FOLDER_URI, kind: 'file' },
      0
    )
    expect(asFile?.kind).toBeUndefined()
    expect(asFile?.prefetchKey).not.toBe(folderOn(FOLDER_URI)!.prefetchKey)
  })

  it('Q2: a file open in Files offers the file, never the folder that holds it', () => {
    const target = deriveTabReferenceTarget(
      filesTab(FILE_URI),
      DESKTOP_ROUTES.files,
      { gfsUri: FILE_URI, kind: 'file' },
      0
    )
    expect(target).toEqual({ gfsUri: FILE_URI, prefetchKey: `${FILE_URI}#r0` })
  })

  it('offers nothing at the Files root, while the location lags, or off the Files route', () => {
    expect(deriveTabReferenceTarget(filesTab(null), DESKTOP_ROUTES.files, null, 0)).toBeNull()
    expect(
      deriveTabReferenceTarget(
        filesTab(FOLDER_URI),
        DESKTOP_ROUTES.files,
        { gfsUri: FILE_URI, kind: 'directory' },
        0
      )
    ).toBeNull()
    expect(
      deriveTabReferenceTarget(
        filesTab(FOLDER_URI),
        DESKTOP_ROUTES.apps,
        { gfsUri: FOLDER_URI, kind: 'directory' },
        0
      )
    ).toBeNull()
  })

  it('offers nothing for a folder path without a stable rid', () => {
    const byPath = 'gfs://main/docs/reports'
    expect(folderOn(byPath)).toBeNull()
  })
})

describe('buildComposerLocationReferences', () => {
  it('builds the reference mcp-host parses back to the same folder', () => {
    const [built] = buildComposerLocationReferences([reports])
    const parsed = parseLocationReferenceV1(JSON.parse(JSON.stringify(built)))
    expect(parsed).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        id: `gfs-folder:${reports.drive}:${reports.resourceId}`,
        name: 'Reports',
        source: {
          kind: 'gfs',
          drive: reports.drive,
          resourceId: reports.resourceId,
          gfsUri: reports.gfsUri,
        },
      },
    })
  })

  it('names no folder when the composer has none', () => {
    expect(buildComposerLocationReferences([])).toEqual([])
  })

  it('refuses more folders than a message may name', () => {
    expect(LOCATION_REFERENCE_MAX_COUNT).toBe(1)
    expect(() => buildComposerLocationReferences([reports, invoices])).toThrow(
      'Only one folder per message.'
    )
  })

  it('refuses a folder whose URI does not name its drive and resource', () => {
    expect(() => buildComposerLocationReferences([{ ...reports, gfsUri: FILE_URI }])).toThrow(
      /Global folder reference is invalid \(FILE_REFERENCE_INVALID\)/
    )
  })
})
