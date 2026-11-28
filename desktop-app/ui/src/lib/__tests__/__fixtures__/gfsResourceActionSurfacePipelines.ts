import {
  filePreviewActionOptions,
  filesCurrentResourceActionOptions,
  filesRowActionOptions,
  sidebarRowActionOptions,
} from '@lib/gfsResourceActionSurfaces'
import { buildGfsResourceActions } from '@lib/gfsResourceActions'
import type { GfsResourceAction } from '@lib/gfsResourceActions'
import { withPermissionGate } from '@lib/gfsResourceMenuPermissionGate'
import type { GfsResourceMenuPermissionGateStatus } from '@lib/gfsResourceMenuPermissionGate'
import { gfsRowActionAvailability } from '@lib/gfsRowActionAvailability'
import {
  type CurrentState,
  type FilesRowState,
  type HandlerSpies,
  type PreviewState,
  type SidebarRowState,
  currentGates,
  handlerSpies,
  previewGates,
} from './gfsResourceActionSurfaceStates'

/**
 * The live pipeline of each surface, the way its component runs it:
 * surface options → `buildGfsResourceActions` → the menu's permission gate.
 */

export type SurfaceRun = { actions: GfsResourceAction[]; handlers: HandlerSpies }

const URI = 'gfs://drive/resource'

function gated(
  actions: GfsResourceAction[],
  status: GfsResourceMenuPermissionGateStatus | undefined
): GfsResourceAction[] {
  return actions.map(action => withPermissionGate(action, action.id, status))
}

export function rowAvailability(
  availabilityOf: typeof gfsRowActionAvailability,
  state: FilesRowState
) {
  return availabilityOf({
    resource: { parentResourceId: state.parentResourceId, permissions: state.permissions },
    listing: state.listing,
    rowAffordances: state.rowHeld === null ? null : { held: state.rowHeld },
    parentAffordances: state.parentHeld === null ? null : { held: state.parentHeld },
  })
}

export function liveFilesRow(state: FilesRowState): SurfaceRun {
  const handlers = handlerSpies()
  const actions = buildGfsResourceActions(
    filesRowActionOptions({
      kind: state.kind,
      uri: URI,
      readable: state.readable,
      previewable: state.previewable,
      parentResourceId: state.parentResourceId,
      availability: rowAvailability(gfsRowActionAvailability, state),
      mutating: state.mutating,
      handlers,
    })
  )
  // Files rows pass no permission status: their availability alone gates the
  // menu, and bits that are still pending read as not held.
  return { actions: gated(actions, undefined), handlers }
}

export function liveSidebarRow(state: SidebarRowState): SurfaceRun {
  const handlers = handlerSpies()
  const actions = buildGfsResourceActions(
    sidebarRowActionOptions({
      kind: state.kind,
      uri: URI,
      readable: state.readable,
      previewable: state.previewable,
      parentResourceId: state.parentResourceId,
      availability: rowAvailability(gfsRowActionAvailability, state),
      hostAvailable: state.hostAvailable,
      mutating: state.mutating,
      handlers,
    })
  )
  return { actions: gated(actions, state.bits), handlers }
}

export function liveCurrent(state: CurrentState): SurfaceRun {
  const handlers = handlerSpies()
  const gates = currentGates(state)
  const actions = buildGfsResourceActions(
    filesCurrentResourceActionOptions({
      kind: state.kind,
      uri: URI,
      canWrite: state.canWrite,
      canManage: state.canManage,
      canDelete: state.canDelete,
      canMove: gates.canMove,
      previewable: gates.previewable,
      parentResourceId: state.parentResourceId,
      mutating: state.mutating,
      refreshing: state.refreshing,
      handlers,
    })
  )
  return { actions: gated(actions, undefined), handlers }
}

export function livePreview(state: PreviewState): SurfaceRun {
  const handlers = handlerSpies()
  const gates = previewGates(state)
  const actions = buildGfsResourceActions(
    filePreviewActionOptions({
      uri: URI,
      accessBlocked: state.accessBlocked,
      canResolve: gates.canResolve,
      resourceKind: gates.resourceKind,
      parentResourceId: gates.parentResourceId,
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
  )
  return { actions: gated(actions, undefined), handlers }
}

export const enabledIds = (actions: readonly GfsResourceAction[]) =>
  actions.filter(action => !action.disabled).map(action => action.id)

export const offeredIds = (actions: readonly GfsResourceAction[]) =>
  actions.map(action => action.id)
