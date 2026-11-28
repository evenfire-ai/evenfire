/**
 * Shape and monotonicity of the EvenDrive resource menu on each surface that
 * builds it, run through the real pipeline (surface options →
 * `buildGfsResourceActions` → the menu's permission gate).
 *
 * Shape: what applies to a resource (its kind, listing, format, parent,
 * resolvable authority, action host) fixes which actions are offered and in
 * which order. Permission bits, the listing's read flag and an in-flight
 * change only enable or disable them, so a surface that hides an action for
 * lack of a permission or of read access fails here.
 *
 * Monotonicity: losing a permission never enables nor reveals an action, and
 * an enabled action always holds the permission it needs.
 *
 * Scope: rows (Files and sidebar) start from raw bits and run the real
 * availability derivation. The resource open in Files and the preview tab
 * start from their `can*` gates, derived here the way FilesPage and
 * `useFilePreviewResourceActions` derive them; for those two surfaces the
 * properties check gates → enabled through the action model, not the gate
 * derivation itself.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { GfsResourceAction, GfsResourceActionId } from '@lib/gfsResourceActions'
import {
  enabledIds,
  liveCurrent,
  liveFilesRow,
  livePreview,
  liveSidebarRow,
  offeredIds,
} from './__fixtures__/gfsResourceActionSurfacePipelines'
import {
  type CurrentState,
  type FilesRowState,
  type PermissionBit,
  type PreviewState,
  type SidebarRowState,
  currentBitRemovals,
  currentBitsArb,
  currentGates,
  currentShapeArb,
  currentStateArb,
  filesRowStateArb,
  previewBitRemovals,
  previewBitsArb,
  previewGates,
  previewShapeArb,
  previewStateArb,
  rowBitRemovals,
  rowBitsArb,
  rowShapeArb,
  sidebarBitRemovals,
  sidebarRowBitsArb,
  sidebarRowShapeArb,
  sidebarRowStateArb,
} from './__fixtures__/gfsResourceActionSurfaceStates'

const NUM_RUNS = 2000

function expectMonotone(higher: GfsResourceAction[], lower: GfsResourceAction[]) {
  const higherOffered = new Set(offeredIds(higher))
  const higherEnabled = new Set(enabledIds(higher))
  for (const id of offeredIds(lower))
    expect({ id, offered: higherOffered.has(id) }).toEqual({ id, offered: true })
  for (const id of enabledIds(lower))
    expect({ id, enabled: higherEnabled.has(id) }).toEqual({ id, enabled: true })
}

/** The bit each row action needs, read straight off the raw state. */
function rowPermits(state: FilesRowState, id: GfsResourceActionId, settled = true): boolean {
  const held = (bit: PermissionBit) =>
    state.listing === 'folder'
      ? Boolean(state.rowHeld?.includes(bit))
      : state.permissions.includes(bit)
  const readable = state.readable !== false
  switch (id) {
    case 'rename':
      return settled && held('write')
    case 'new-folder':
    case 'upload-file':
      return settled && held('write')
    case 'share':
      return settled && held('manage_acl')
    case 'delete':
      return settled && held('delete')
    case 'move':
      return (
        settled &&
        Boolean(state.parentResourceId) &&
        Boolean(state.parentHeld?.includes('write') && state.parentHeld.includes('delete'))
      )
    case 'preview':
    case 'download':
    case 'download-zip':
      return readable
    default:
      return true
  }
}

function currentPermits(state: CurrentState, id: GfsResourceActionId): boolean {
  switch (id) {
    case 'rename':
    case 'new-folder':
    case 'upload-file':
    case 'replace':
      return state.canWrite
    case 'share':
      return state.canManage
    case 'delete':
      return state.canDelete
    case 'move':
      return currentGates(state).canMove
    default:
      return true
  }
}

function previewPermits(state: PreviewState, id: GfsResourceActionId): boolean {
  const gates = previewGates(state)
  switch (id) {
    case 'share':
      return gates.canShare
    case 'rename':
      return gates.canRename
    case 'delete':
      return gates.canDelete
    case 'move':
      return gates.canMove
    case 'download':
      return gates.canDownload
    default:
      return true
  }
}

describe('EvenDrive resource menu shape does not depend on permissions', () => {
  it('Files rows', () => {
    fc.assert(
      fc.property(rowShapeArb, rowBitsArb, rowBitsArb, (shape, a, b) => {
        expect(offeredIds(liveFilesRow({ ...shape, ...a }).actions)).toEqual(
          offeredIds(liveFilesRow({ ...shape, ...b }).actions)
        )
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('sidebar tree rows, including bits that are pending or failed', () => {
    fc.assert(
      fc.property(sidebarRowShapeArb, sidebarRowBitsArb, sidebarRowBitsArb, (shape, a, b) => {
        expect(offeredIds(liveSidebarRow({ ...shape, ...a }).actions)).toEqual(
          offeredIds(liveSidebarRow({ ...shape, ...b }).actions)
        )
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('the resource open in Files', () => {
    fc.assert(
      fc.property(currentShapeArb, currentBitsArb, currentBitsArb, (shape, a, b) => {
        expect(offeredIds(liveCurrent({ ...shape, ...a }).actions)).toEqual(
          offeredIds(liveCurrent({ ...shape, ...b }).actions)
        )
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('the file preview tab', () => {
    fc.assert(
      fc.property(previewShapeArb, previewBitsArb, previewBitsArb, (shape, a, b) => {
        expect(offeredIds(livePreview({ ...shape, ...a }).actions)).toEqual(
          offeredIds(livePreview({ ...shape, ...b }).actions)
        )
      }),
      { numRuns: NUM_RUNS }
    )
  })
})

describe('EvenDrive resource menu is monotone in permissions', () => {
  it('Files rows', () => {
    fc.assert(
      fc.property(filesRowStateArb, state => {
        const higher = liveFilesRow(state).actions
        for (const id of enabledIds(higher)) {
          expect({ id, permitted: rowPermits(state, id) }).toEqual({ id, permitted: true })
        }
        for (const lowered of rowBitRemovals(state)) {
          expectMonotone(higher, liveFilesRow(lowered).actions)
        }
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('sidebar tree rows', () => {
    fc.assert(
      fc.property(sidebarRowStateArb, (state: SidebarRowState) => {
        const higher = liveSidebarRow(state).actions
        for (const id of enabledIds(higher)) {
          expect({ id, permitted: rowPermits(state, id, state.bits === 'ok') }).toEqual({
            id,
            permitted: true,
          })
        }
        for (const lowered of sidebarBitRemovals(state)) {
          expectMonotone(higher, liveSidebarRow(lowered).actions)
        }
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('the resource open in Files', () => {
    fc.assert(
      fc.property(currentStateArb, state => {
        const higher = liveCurrent(state).actions
        for (const id of enabledIds(higher)) {
          expect({ id, permitted: currentPermits(state, id) }).toEqual({ id, permitted: true })
        }
        for (const lowered of currentBitRemovals(state)) {
          expectMonotone(higher, liveCurrent(lowered).actions)
        }
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('the file preview tab', () => {
    fc.assert(
      fc.property(previewStateArb, state => {
        const higher = livePreview(state).actions
        for (const id of enabledIds(higher)) {
          expect({ id, permitted: previewPermits(state, id) }).toEqual({ id, permitted: true })
        }
        for (const lowered of previewBitRemovals(state)) {
          expectMonotone(higher, livePreview(lowered).actions)
        }
      }),
      { numRuns: NUM_RUNS }
    )
  })
})
