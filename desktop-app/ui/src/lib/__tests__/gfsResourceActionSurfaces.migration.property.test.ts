/**
 * MIGRATION TEST — delete it once the "hidden → greyed out" change of the
 * EvenDrive resource menu is merged. From then on the permanent shape and
 * monotonicity properties (gfsResourceActionSurfaces.property.test.ts) guard
 * the menu.
 *
 * It proves the migration against the menu model as it was right before the
 * change. `__fixtures__/__migration__/` holds that model, copied verbatim with
 * `git show 42e2e54fc:desktop-app/ui/src/lib/<file>` (no file was edited; the
 * copies import only each other, React and the sidebar icons). For every raw
 * surface state, on each of the four surfaces:
 *  1. the enabled actions are exactly the ones enabled before;
 *  2. an action hidden before only for lack of a permission is now offered,
 *     disabled;
 *  3. an action hidden before because it did not apply stays hidden;
 *  4. running an enabled action reaches its handler, running a disabled one
 *     does not.
 * "Hidden for lack of a permission" is read off the old model itself: hidden
 * with the state's bits, shown once every bit is granted.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { GfsResourceAction } from '@lib/gfsResourceActions'
import * as frozenSurfaces from './__fixtures__/__migration__/gfsResourceActionSurfaces'
import * as frozenActions from './__fixtures__/__migration__/gfsResourceActions'
import * as frozenGate from './__fixtures__/__migration__/gfsResourceMenuPermissionGate'
import * as frozenAvailability from './__fixtures__/__migration__/gfsRowActionAvailability'
import {
  type SurfaceRun,
  enabledIds,
  liveCurrent,
  liveFilesRow,
  livePreview,
  liveSidebarRow,
  offeredIds,
  rowAvailability,
} from './__fixtures__/gfsResourceActionSurfacePipelines'
import {
  type CurrentState,
  type FilesRowState,
  type PreviewState,
  type SidebarRowState,
  currentGates,
  currentStateArb,
  filesRowStateArb,
  handlerSpies,
  previewGates,
  previewStateArb,
  sidebarRowStateArb,
  withFullCurrentPermission,
  withFullPreviewPermission,
  withFullRowPermission,
  withFullSidebarPermission,
} from './__fixtures__/gfsResourceActionSurfaceStates'

const MIGRATION_DIR = resolve(__dirname, '__fixtures__/__migration__')
const NUM_RUNS = 3000
const URI = 'gfs://drive/resource'

type FrozenAction = { id: string; disabled: boolean }

function frozenGated(
  actions: FrozenAction[],
  status: frozenGate.GfsResourceMenuPermissionGateStatus | undefined
): FrozenAction[] {
  return actions.map(action =>
    frozenGate.withPermissionGate(action, action.id as frozenActions.GfsResourceActionId, status)
  )
}

function frozenFilesRow(state: FilesRowState): FrozenAction[] {
  return frozenGated(
    frozenActions.buildGfsResourceActions(
      frozenSurfaces.filesRowActionOptions({
        kind: state.kind,
        uri: URI,
        readable: state.readable,
        previewable: state.previewable,
        availability: rowAvailability(frozenAvailability.gfsRowActionAvailability, state),
        mutating: state.mutating,
        handlers: handlerSpies(),
      })
    ),
    undefined
  )
}

function frozenSidebarRow(state: SidebarRowState): FrozenAction[] {
  return frozenGated(
    frozenActions.buildGfsResourceActions(
      frozenSurfaces.sidebarRowActionOptions({
        kind: state.kind,
        uri: URI,
        readable: state.readable,
        previewable: state.previewable,
        parentResourceId: state.parentResourceId,
        bits: state.bits,
        availability: rowAvailability(frozenAvailability.gfsRowActionAvailability, state),
        hostAvailable: state.hostAvailable,
        mutating: state.mutating,
        handlers: handlerSpies(),
      })
    ),
    state.bits
  )
}

function frozenCurrent(state: CurrentState): FrozenAction[] {
  const gates = currentGates(state)
  return frozenGated(
    frozenActions.buildGfsResourceActions(
      frozenSurfaces.filesCurrentResourceActionOptions({
        kind: state.kind,
        uri: URI,
        canWrite: state.canWrite,
        canManage: state.canManage,
        canDelete: state.canDelete,
        canMove: gates.canMove,
        previewable: gates.previewable,
        mutating: state.mutating,
        refreshing: state.refreshing,
        handlers: handlerSpies(),
      })
    ),
    undefined
  )
}

function frozenPreview(state: PreviewState): FrozenAction[] {
  const gates = previewGates(state)
  const handlers = handlerSpies()
  return frozenGated(
    frozenActions.buildGfsResourceActions(
      frozenSurfaces.filePreviewActionOptions({
        uri: URI,
        accessBlocked: state.accessBlocked,
        copyContentSupported: state.copyContentSupported,
        copyContentReady: state.copyContentReady,
        canShare: gates.canShare,
        canRename: gates.canRename,
        canMove: gates.canMove,
        canDownload: gates.canDownload,
        canDelete: gates.canDelete,
        mutating: state.mutating,
        refreshing: state.refreshing,
        handlers: {
          ...handlers,
          'open-route': state.hasOpenRoute ? handlers['open-route'] : undefined,
        },
      })
    ),
    undefined
  )
}

const sorted = (ids: readonly string[]) => [...ids].sort()

function expectMigrated(
  live: SurfaceRun,
  before: FrozenAction[],
  beforeWithEveryBit: FrozenAction[]
) {
  const { actions, handlers } = live
  // 1. Enabled exactly where it was enabled before.
  expect(sorted(enabledIds(actions))).toEqual(
    sorted(before.filter(action => !action.disabled).map(action => action.id))
  )
  // 2 + 3. Offered exactly where it applied before: everything the old model
  // showed once every bit was granted, and nothing else.
  expect(sorted(offeredIds(actions))).toEqual(sorted(beforeWithEveryBit.map(action => action.id)))
  const hiddenForPermission = beforeWithEveryBit
    .map(action => action.id)
    .filter(id => !before.some(action => action.id === id))
  for (const id of hiddenForPermission) {
    expect(actions.find(action => action.id === id)?.disabled).toBe(true)
  }
  // 4. Only an enabled action reaches its handler.
  for (const action of actions) {
    action.run()
    expect(handlers[action.id]).toHaveBeenCalledTimes(action.disabled ? 0 : 1)
  }
}

function expectNoCopyRoute(actions: readonly GfsResourceAction[]) {
  expect(offeredIds(actions)).not.toContain('copy-route')
}

describe('EvenDrive resource menu migration: hidden by permission → greyed out', () => {
  it('Files rows', () => {
    fc.assert(
      fc.property(filesRowStateArb, state => {
        const live = liveFilesRow(state)
        expectNoCopyRoute(live.actions)
        expectMigrated(live, frozenFilesRow(state), frozenFilesRow(withFullRowPermission(state)))
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('sidebar tree rows', () => {
    fc.assert(
      fc.property(sidebarRowStateArb, state => {
        expectMigrated(
          liveSidebarRow(state),
          frozenSidebarRow(state),
          frozenSidebarRow(withFullSidebarPermission(state))
        )
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('the resource open in Files', () => {
    fc.assert(
      fc.property(currentStateArb, state => {
        expectMigrated(
          liveCurrent(state),
          frozenCurrent(state),
          frozenCurrent(withFullCurrentPermission(state))
        )
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('the file preview tab', () => {
    fc.assert(
      fc.property(previewStateArb, state => {
        expectMigrated(
          livePreview(state),
          frozenPreview(state),
          frozenPreview(withFullPreviewPermission(state))
        )
      }),
      { numRuns: NUM_RUNS }
    )
  })
})

describe('the frozen pre-migration model', () => {
  // Pinned so the reference cannot drift: a hand edit would let the test
  // compare the new code with a model nobody shipped.
  const FROZEN_SHA256: Record<string, string> = {
    'gfsMovePermissions.ts': '1deb2e328b9d614b2e77e1e3531e28095c78df5583d29701d548a0c367198986',
    'gfsResourceActionSurfaces.ts':
      '553c9ea7ac5aed6055b9bb8340b82afc69c25603d621497346949698ffba2651',
    'gfsResourceActions.tsx': '28e2b62f9d54c86fd89d343c57587c54819a8e1ced2e6b149a41382cb5c20cb3',
    'gfsResourceMenuPermissionGate.ts':
      'dea8dffc84dc515cbb63e336cc984205b61a645f302dc6762d5b1d6eef084843',
    'gfsRowActionAvailability.ts':
      '0d5516e0f5e9b3efa609e0d258bf1dccff08b9b2d6a27d0e70f12c9804f772bc',
    'gfsRowActionAvailability.types.ts':
      '18ca885463cd95c33dbb885c4ebe8284f4146a91b852aa483265abc6833ba6fa',
  }

  it('is byte-for-byte the copied files', () => {
    const files = readdirSync(MIGRATION_DIR).sort()
    expect(files).toEqual(Object.keys(FROZEN_SHA256).sort())
    for (const file of files) {
      const digest = createHash('sha256')
        .update(readFileSync(resolve(MIGRATION_DIR, file)))
        .digest('hex')
      expect({ file, digest }).toEqual({ file, digest: FROZEN_SHA256[file] })
    }
  })

  it('imports nothing from the live tree but React and the sidebar icons', () => {
    const allowedPackages = new Set(['react', '@components/SidebarNav/icons'])
    const files = readdirSync(MIGRATION_DIR)
    const localModules = new Set(files.map(file => `./${file.replace(/\.tsx?$/, '')}`))
    for (const file of files) {
      const source = readFileSync(resolve(MIGRATION_DIR, file), 'utf8')
      const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1] ?? '')
      for (const specifier of specifiers) {
        const allowed = localModules.has(specifier) || allowedPackages.has(specifier)
        expect({ file, specifier, allowed }).toEqual({ file, specifier, allowed: true })
      }
    }
  })
})
