import { vi } from 'vitest'
import type { Mock } from 'vitest'
import fc from 'fast-check'
import type { GfsResourceActionId, GfsResourceKind } from '@lib/gfsResourceActions'
import type { GfsResourceMenuPermissionGateStatus } from '@lib/gfsResourceMenuPermissionGate'
import type { GfsRowListing } from '@lib/gfsRowActionAvailability.types'

/**
 * Raw state of each surface that builds the EvenDrive resource menu, as the
 * surface holds it before deriving any gate. Shared by the migration test and
 * the permanent shape/monotonicity properties.
 */

export const PERMISSION_BITS = ['read', 'write', 'delete', 'manage_acl'] as const
export type PermissionBit = (typeof PERMISSION_BITS)[number]

export const PARENT_ID = 'parent-1'

const bitsArb = fc.subarray([...PERMISSION_BITS])
const heldOrNullArb = fc.option(bitsArb, { nil: null })
const kindArb = fc.constantFrom<GfsResourceKind>('directory', 'file')
const readableArb = fc.constantFrom<boolean | undefined>(true, false, undefined)
const parentArb = fc.constantFrom<string | null>(PARENT_ID, null)

/** Inputs that decide which actions apply; never a permission. */
export type RowShape = {
  kind: GfsResourceKind
  previewable: boolean
  parentResourceId: string | null
  listing: GfsRowListing
}

/**
 * Permission inputs of a row: its own bits, its parent's and the listing's
 * read flag, which greys out the reads but never hides them.
 */
export type RowBits = {
  /** The listing's flag; only an explicit `false` marks the row unreadable. */
  readable: boolean | undefined
  /** The listing's bits (Shared with me roots). */
  permissions: PermissionBit[]
  /** The row's own affordances (folder children); null when not loaded. */
  rowHeld: PermissionBit[] | null
  /** The exact old parent's affordances; null when unknown or failed. */
  parentHeld: PermissionBit[] | null
  mutating: boolean
}

export type FilesRowState = RowShape & RowBits

export const rowShapeArb: fc.Arbitrary<RowShape> = fc.record({
  kind: kindArb,
  previewable: fc.boolean(),
  parentResourceId: parentArb,
  listing: fc.constantFrom<GfsRowListing>('folder', 'roots'),
})

export const rowBitsArb: fc.Arbitrary<RowBits> = fc.record({
  readable: readableArb,
  permissions: bitsArb,
  rowHeld: heldOrNullArb,
  parentHeld: heldOrNullArb,
  mutating: fc.boolean(),
})

export const filesRowStateArb: fc.Arbitrary<FilesRowState> = fc
  .tuple(rowShapeArb, rowBitsArb)
  .map(([shape, bits]) => ({ ...shape, ...bits }))

/** Every bit held and the row readable: what the row would offer at most. */
export function withFullRowPermission<S extends FilesRowState>(state: S): S {
  return {
    ...state,
    readable: true,
    permissions: [...PERMISSION_BITS],
    rowHeld: [...PERMISSION_BITS],
    parentHeld: [...PERMISSION_BITS],
  }
}

export type SidebarRowShape = RowShape & { hostAvailable: boolean }
export type SidebarRowBits = RowBits & { bits: GfsResourceMenuPermissionGateStatus }
export type SidebarRowState = SidebarRowShape & SidebarRowBits

export const sidebarRowShapeArb: fc.Arbitrary<SidebarRowShape> = fc
  .tuple(rowShapeArb, fc.boolean())
  .map(([shape, hostAvailable]) => ({ ...shape, hostAvailable }))

export const sidebarRowBitsArb: fc.Arbitrary<SidebarRowBits> = fc
  .tuple(rowBitsArb, fc.constantFrom<GfsResourceMenuPermissionGateStatus>('pending', 'ok', 'error'))
  .map(([bits, status]) => ({ ...bits, bits: status }))

export const sidebarRowStateArb: fc.Arbitrary<SidebarRowState> = fc
  .tuple(sidebarRowShapeArb, sidebarRowBitsArb)
  .map(([shape, bits]) => ({ ...shape, ...bits }))

export function withFullSidebarPermission(state: SidebarRowState): SidebarRowState {
  return { ...withFullRowPermission(state), bits: 'ok' }
}

export type CurrentShape = {
  kind: GfsResourceKind
  /** The open resource's name has a preview format. */
  previewFormat: boolean
  parentResourceId: string | null
}

export type CurrentBits = {
  canWrite: boolean
  canManage: boolean
  canDelete: boolean
  /** The exact old parent grants write and delete. */
  parentMoveBits: boolean
  mutating: boolean
  refreshing: boolean
}

export type CurrentState = CurrentShape & CurrentBits

export const currentShapeArb: fc.Arbitrary<CurrentShape> = fc.record({
  kind: kindArb,
  previewFormat: fc.boolean(),
  parentResourceId: parentArb,
})

export const currentBitsArb: fc.Arbitrary<CurrentBits> = fc.record({
  canWrite: fc.boolean(),
  canManage: fc.boolean(),
  canDelete: fc.boolean(),
  parentMoveBits: fc.boolean(),
  mutating: fc.boolean(),
  refreshing: fc.boolean(),
})

export const currentStateArb: fc.Arbitrary<CurrentState> = fc
  .tuple(currentShapeArb, currentBitsArb)
  .map(([shape, bits]) => ({ ...shape, ...bits }))

export function withFullCurrentPermission(state: CurrentState): CurrentState {
  return { ...state, canWrite: true, canManage: true, canDelete: true, parentMoveBits: true }
}

/** The Files page's current-resource gates, derived from the raw state as FilesPage does. */
export function currentGates(state: CurrentState) {
  return {
    previewable: state.kind === 'file' && state.previewFormat,
    // FilesPage only grants Move on a known parent that holds write+delete.
    canMove: Boolean(state.parentResourceId) && state.parentMoveBits,
  }
}

export type PreviewShape = {
  /** Denied, unavailable or revoked. */
  accessBlocked: boolean
  /**
   * Shape, not a bit: until the session's authority resolves, the file's own
   * actions do not apply yet and the builder withholds them.
   */
  authorityPending: boolean
  /**
   * What the preview's URI resolved to: null until it resolves (its parent is
   * known from then on). A preview tab can also be opened on a folder's URI.
   */
  resolvedKind: GfsResourceKind | null
  parentResourceId: string | null
  copyContentSupported: boolean
  hasOpenRoute: boolean
}

export type PreviewBits = {
  canDelegate: boolean
  write: boolean
  delete: boolean
  parentMoveBits: boolean
  parentReadFailed: boolean
  copyContentReady: boolean
  mutating: boolean
  refreshing: boolean
}

export type PreviewState = PreviewShape & PreviewBits

export const previewShapeArb: fc.Arbitrary<PreviewShape> = fc.record({
  accessBlocked: fc.boolean(),
  authorityPending: fc.boolean(),
  resolvedKind: fc.constantFrom<GfsResourceKind | null>('file', 'directory', null),
  parentResourceId: parentArb,
  copyContentSupported: fc.boolean(),
  hasOpenRoute: fc.boolean(),
})

export const previewBitsArb: fc.Arbitrary<PreviewBits> = fc.record({
  canDelegate: fc.boolean(),
  write: fc.boolean(),
  delete: fc.boolean(),
  parentMoveBits: fc.boolean(),
  parentReadFailed: fc.boolean(),
  copyContentReady: fc.boolean(),
  mutating: fc.boolean(),
  refreshing: fc.boolean(),
})

export const previewStateArb: fc.Arbitrary<PreviewState> = fc
  .tuple(previewShapeArb, previewBitsArb)
  .map(([shape, bits]) => ({ ...shape, ...bits }))

export function withFullPreviewPermission(state: PreviewState): PreviewState {
  return {
    ...state,
    canDelegate: true,
    write: true,
    delete: true,
    parentMoveBits: true,
    parentReadFailed: false,
  }
}

/**
 * The gates `useFilePreviewResourceActions` and `FilePreviewPage` hand to the
 * menu, rule for rule as the hook computes them. Share, Rename and Delete need
 * only `canResolve` and the bit: the hook does not check the resolved kind, so
 * affordances already cached under the resource's key (a folder's, loaded by
 * the Files browser) can grant them on a folder. Before the URI resolves the
 * hook reads under the URI's key, which nothing writes, so the app has no bits
 * there; the states still vary them, as a superset the builder must hide too.
 * Hiding them is the surface builder's job, not the gates'. Move needs a
 * resolved file with a parent whose read did not fail and that grants the
 * move bits; Download needs a resolved file.
 */
export function previewGates(state: PreviewState) {
  const canResolve = !state.accessBlocked && !state.authorityPending
  const parentResourceId = state.resolvedKind ? state.parentResourceId : null
  const resolvedFile = canResolve && state.resolvedKind === 'file'
  return {
    canResolve,
    parentResourceId,
    resourceKind: state.resolvedKind,
    canShare: canResolve && state.canDelegate,
    canRename: canResolve && state.write,
    canDelete: canResolve && state.delete,
    canMove:
      resolvedFile && Boolean(parentResourceId) && !state.parentReadFailed && state.parentMoveBits,
    canDownload: resolvedFile,
  }
}

export const ALL_ACTION_IDS: readonly GfsResourceActionId[] = [
  'refresh',
  'copy-link',
  'open-route',
  'rename',
  'move',
  'new-folder',
  'upload-file',
  'share',
  'copy-content',
  'preview',
  'download',
  'download-zip',
  'replace',
  'open-folder',
  'delete',
]

export type HandlerSpies = Record<GfsResourceActionId, Mock<() => void>>

export function handlerSpies(): HandlerSpies {
  return Object.fromEntries(ALL_ACTION_IDS.map(id => [id, vi.fn()])) as HandlerSpies
}

/** One permission input lowered: a bit dropped, a flag lost or bits no longer settled. */
export function rowBitRemovals<S extends FilesRowState>(state: S): S[] {
  const lowered: S[] = []
  for (const bit of state.permissions) {
    lowered.push({ ...state, permissions: state.permissions.filter(held => held !== bit) })
  }
  for (const bit of state.rowHeld ?? []) {
    lowered.push({ ...state, rowHeld: state.rowHeld!.filter(held => held !== bit) })
  }
  if (state.rowHeld !== null) lowered.push({ ...state, rowHeld: null })
  for (const bit of state.parentHeld ?? []) {
    lowered.push({ ...state, parentHeld: state.parentHeld!.filter(held => held !== bit) })
  }
  if (state.parentHeld !== null) lowered.push({ ...state, parentHeld: null })
  if (state.readable !== false) lowered.push({ ...state, readable: false })
  return lowered
}

export function sidebarBitRemovals(state: SidebarRowState): SidebarRowState[] {
  const lowered = rowBitRemovals(state)
  if (state.bits === 'ok') {
    lowered.push({ ...state, bits: 'pending' }, { ...state, bits: 'error' })
  }
  return lowered
}

export function currentBitRemovals(state: CurrentState): CurrentState[] {
  return (['canWrite', 'canManage', 'canDelete', 'parentMoveBits'] as const)
    .filter(key => state[key])
    .map(key => ({ ...state, [key]: false }))
}

export function previewBitRemovals(state: PreviewState): PreviewState[] {
  const lowered = (['canDelegate', 'write', 'delete', 'parentMoveBits'] as const)
    .filter(key => state[key])
    .map(key => ({ ...state, [key]: false }))
  if (!state.parentReadFailed) lowered.push({ ...state, parentReadFailed: true })
  return lowered
}
