import type {
  GfsResourceActionHandler,
  GfsResourceActionOptions,
  GfsResourceKind,
} from './gfsResourceActions'
import type { GfsResourceMenuPermissionGateStatus } from './gfsResourceMenuPermissionGate'
import { gfsPendingRowActionAvailability } from './gfsRowActionAvailability'
import type { GfsRowActionAvailability } from './gfsRowActionAvailability.types'

/**
 * Each surface that offers EvenDrive resource actions decides here which of
 * its handlers reach `buildGfsResourceActions` and with which gates. The
 * surfaces compute their state (bits, readability, previewability) and pass
 * it in as plain data; nothing here reads hooks, context or stores.
 *
 * A handler is withheld only when the action does not apply to the resource
 * (its kind, its format, a missing parent, a missing action host). A missing
 * permission travels as a `can*` gate instead, so the menu keeps the same
 * shape while bits load or are refused and greys the action out.
 */

type Handler = GfsResourceActionHandler

export type FilesRowActionHandlers = {
  'copy-link': Handler
  'open-route': Handler
  'open-folder': Handler
  'new-folder': Handler
  'upload-file': Handler
  rename: Handler
  move: Handler
  share: Handler
  delete: Handler
  preview: Handler
  download: Handler
  'download-zip': Handler
}

export type FilesRowActionSurfaceInput = {
  kind: GfsResourceKind
  uri: string
  /** The listing's flag; only an explicit `false` marks the row unreadable. */
  readable: boolean | undefined
  /** Whether the file's format has a preview at all. */
  previewable: boolean
  parentResourceId: string | null | undefined
  availability: GfsRowActionAvailability
  mutating: boolean
  handlers: FilesRowActionHandlers
}

/** A row of the Files page browser. */
export function filesRowActionOptions(input: FilesRowActionSurfaceInput): GfsResourceActionOptions {
  const { availability, handlers } = input
  const isDirectory = input.kind === 'directory'
  const readable = input.readable !== false
  const canWrite = isDirectory && availability.canWrite
  return {
    kind: input.kind,
    uri: input.uri,
    handlers: {
      'copy-link': handlers['copy-link'],
      'open-route': handlers['open-route'],
      'open-folder': isDirectory ? handlers['open-folder'] : undefined,
      'new-folder': handlers['new-folder'],
      'upload-file': handlers['upload-file'],
      rename: handlers.rename,
      move: handlers.move,
      share: handlers.share,
      delete: handlers.delete,
      preview: handlers.preview,
      download: handlers.download,
      'download-zip': handlers['download-zip'],
    },
    moveApplicable: Boolean(input.parentResourceId),
    previewable: input.previewable,
    readable: input.readable,
    canOpenFolder: isDirectory,
    canRename: availability.canRename,
    canMove: availability.canMove,
    canCreateFolder: canWrite,
    canUpload: canWrite,
    canShare: availability.canManage,
    canDelete: availability.canDelete,
    canPreview: readable,
    canDownload: readable,
    canDownloadZip: readable,
    mutating: input.mutating,
  }
}

export type FilesCurrentResourceActionHandlers = {
  refresh: Handler
  'copy-link': Handler
  'open-route': Handler
  rename: Handler
  move: Handler
  'new-folder': Handler
  'upload-file': Handler
  share: Handler
  preview: Handler
  download: Handler
  'download-zip': Handler
  replace: Handler
  delete: Handler
}

export type FilesCurrentResourceActionSurfaceInput = {
  kind: GfsResourceKind
  uri: string
  canWrite: boolean
  canManage: boolean
  canDelete: boolean
  canMove: boolean
  /** The open resource is a file whose format has a preview. */
  previewable: boolean
  parentResourceId: string | null | undefined
  mutating: boolean
  refreshing: boolean
  handlers: FilesCurrentResourceActionHandlers
}

/** The resource open in the Files page (breadcrumb and file title menus). */
export function filesCurrentResourceActionOptions(
  input: FilesCurrentResourceActionSurfaceInput
): GfsResourceActionOptions {
  const { handlers } = input
  const isFile = input.kind === 'file'
  const isFolder = input.kind === 'directory'
  return {
    kind: input.kind,
    uri: input.uri,
    handlers: {
      refresh: handlers.refresh,
      'copy-link': handlers['copy-link'],
      'open-route': handlers['open-route'],
      rename: handlers.rename,
      move: handlers.move,
      'new-folder': handlers['new-folder'],
      'upload-file': handlers['upload-file'],
      share: handlers.share,
      preview: handlers.preview,
      download: handlers.download,
      'download-zip': handlers['download-zip'],
      replace: handlers.replace,
      delete: handlers.delete,
    },
    moveApplicable: Boolean(input.parentResourceId),
    previewable: input.previewable,
    canRename: input.canWrite,
    canMove: input.canMove,
    canCreateFolder: isFolder && input.canWrite,
    canUpload: isFolder && input.canWrite,
    canShare: input.canManage,
    canPreview: true,
    canDownload: isFile,
    canDownloadZip: isFolder,
    canReplace: isFile && input.canWrite,
    canDelete: input.canDelete,
    mutating: input.mutating,
    refreshing: input.refreshing,
  }
}

export type SidebarRowActionHandlers = {
  'copy-link': Handler
  'open-folder': Handler
  'new-folder': Handler
  'upload-file': Handler
  rename: Handler
  move: Handler
  share: Handler
  delete: Handler
  preview: Handler
  download: Handler
}

export type SidebarRowActionSurfaceInput = {
  kind: GfsResourceKind
  uri: string
  /** The listing's flag; only an explicit `false` marks the row unreadable. */
  readable: boolean | undefined
  /** Whether the file's format has a preview at all. */
  previewable: boolean
  parentResourceId: string | null | undefined
  bits: GfsResourceMenuPermissionGateStatus
  /** The availability the row's bits resolve to; only read once `bits` is `ok`. */
  availability: GfsRowActionAvailability
  /** Whether a GFS action host is mounted to run host-routed actions. */
  hostAvailable: boolean
  mutating: boolean
  handlers: SidebarRowActionHandlers
}

/** A row of the sidebar file explorer tree. */
export function sidebarRowActionOptions(
  input: SidebarRowActionSurfaceInput
): GfsResourceActionOptions {
  const { handlers } = input
  // Until the bits settle every bit-dependent action is listed and the menu
  // keeps it inert.
  const availability =
    input.bits === 'ok'
      ? input.availability
      : gfsPendingRowActionAvailability({ parentResourceId: input.parentResourceId })
  const isDirectory = input.kind === 'directory'
  const readable = input.readable !== false
  const canWrite = isDirectory && availability.canWrite
  const inHost = (handler: Handler) => (input.hostAvailable ? handler : undefined)
  return {
    kind: input.kind,
    uri: input.uri,
    handlers: {
      'copy-link': inHost(handlers['copy-link']),
      'open-folder': isDirectory ? handlers['open-folder'] : undefined,
      'new-folder': inHost(handlers['new-folder']),
      'upload-file': inHost(handlers['upload-file']),
      rename: inHost(handlers.rename),
      move: inHost(handlers.move),
      share: inHost(handlers.share),
      delete: inHost(handlers.delete),
      preview: handlers.preview,
      download: inHost(handlers.download),
    },
    moveApplicable: Boolean(input.parentResourceId),
    previewable: input.previewable,
    readable: input.readable,
    canOpenFolder: isDirectory,
    canRename: availability.canRename,
    canMove: availability.canMove,
    canCreateFolder: canWrite,
    canUpload: canWrite,
    canShare: availability.canManage,
    canDelete: availability.canDelete,
    canPreview: readable,
    canDownload: readable,
    mutating: input.mutating,
  }
}

export type FilePreviewActionHandlers = {
  refresh: Handler
  'copy-link': Handler
  'open-route': Handler | undefined
  'copy-content': Handler
  share: Handler
  rename: Handler
  move: Handler
  download: Handler
  delete: Handler
}

export type FilePreviewActionSurfaceInput = {
  uri: string
  /** The file is denied, unavailable or its access was revoked. */
  accessBlocked: boolean
  /**
   * The preview may resolve the file's authority: false while blocked and while
   * the session authority is pending. Implied false by `accessBlocked`.
   */
  canResolve: boolean
  /** What the preview's URI resolved to; null until it resolves. */
  resourceKind: GfsResourceKind | null
  /** The resolved file's parent folder; unknown until the file resolves. */
  parentResourceId: string | null
  /** The preview body can copy this format's content (image or markdown). */
  copyContentSupported: boolean
  copyContentReady: boolean
  canShare: boolean
  canRename: boolean
  canMove: boolean
  canDownload: boolean
  canDelete: boolean
  mutating: boolean
  refreshing: boolean
  handlers: FilePreviewActionHandlers
}

/** The file preview tab's actions menu. */
export function filePreviewActionOptions(
  input: FilePreviewActionSurfaceInput
): GfsResourceActionOptions {
  const { handlers } = input
  // The file's own actions apply only once its authority can be resolved and
  // it resolved to a file: before that, or on a folder, nothing reads its
  // bits, so they stay out of the menu rather than greyed out.
  const resolved = (handler: Handler) =>
    input.canResolve && input.resourceKind === 'file' ? handler : undefined
  return {
    kind: 'file',
    uri: input.uri,
    handlers: {
      refresh: input.accessBlocked ? undefined : handlers.refresh,
      'copy-link': handlers['copy-link'],
      'open-route': handlers['open-route'],
      'copy-content':
        !input.accessBlocked && input.copyContentSupported ? handlers['copy-content'] : undefined,
      share: resolved(handlers.share),
      rename: resolved(handlers.rename),
      move: resolved(handlers.move),
      // Download is gated on the file having resolved, not on a permission.
      download: input.canDownload ? resolved(handlers.download) : undefined,
      delete: resolved(handlers.delete),
    },
    moveApplicable: Boolean(input.parentResourceId),
    // The preview tab has no Preview action of its own.
    previewable: false,
    canShare: input.canShare,
    canRename: input.canRename,
    canMove: input.canMove,
    canDownload: input.canDownload,
    canDelete: input.canDelete,
    mutating: input.mutating,
    canCopyContent: input.copyContentReady,
    refreshing: input.refreshing,
  }
}
