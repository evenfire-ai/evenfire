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
  availability: GfsRowActionAvailability
  mutating: boolean
  handlers: FilesRowActionHandlers
}

/** A row of the Files page browser. */
export function filesRowActionOptions(input: FilesRowActionSurfaceInput): GfsResourceActionOptions {
  const { availability, handlers } = input
  const isDirectory = input.kind === 'directory'
  const readable = input.readable !== false
  const canPreview = !isDirectory && readable && input.previewable
  const canDownload = !isDirectory && readable
  const canDownloadZip = isDirectory && readable
  const canWrite = isDirectory && availability.canWrite
  return {
    kind: input.kind,
    uri: input.uri,
    handlers: {
      'copy-link': handlers['copy-link'],
      'open-route': handlers['open-route'],
      'open-folder': isDirectory ? handlers['open-folder'] : undefined,
      'new-folder': canWrite ? handlers['new-folder'] : undefined,
      'upload-file': canWrite ? handlers['upload-file'] : undefined,
      rename: handlers.rename,
      move: handlers.move,
      share: handlers.share,
      delete: handlers.delete,
      preview: canPreview ? handlers.preview : undefined,
      download: canDownload ? handlers.download : undefined,
      'download-zip': canDownloadZip ? handlers['download-zip'] : undefined,
    },
    canOpenFolder: isDirectory,
    canRename: availability.canRename,
    canMove: availability.canMove,
    canCreateFolder: canWrite,
    canUpload: canWrite,
    canShare: availability.canManage,
    canDelete: availability.canDelete,
    canPreview,
    canDownload,
    canDownloadZip,
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
      preview: isFile && input.previewable ? handlers.preview : undefined,
      download: isFile ? handlers.download : undefined,
      'download-zip': isFolder ? handlers['download-zip'] : undefined,
      replace: isFile && input.canWrite ? handlers.replace : undefined,
      delete: handlers.delete,
    },
    canRename: input.canWrite,
    canMove: input.canMove,
    canCreateFolder: isFolder && input.canWrite,
    canUpload: isFolder && input.canWrite,
    canShare: input.canManage,
    canPreview: input.previewable,
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
  const canPreview = !isDirectory && readable && input.previewable
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
      preview: canPreview ? handlers.preview : undefined,
      download: inHost(handlers.download),
    },
    canOpenFolder: isDirectory,
    canRename: availability.canRename,
    canMove: availability.canMove,
    canCreateFolder: canWrite,
    canUpload: canWrite,
    canShare: availability.canManage,
    canDelete: availability.canDelete,
    canPreview,
    canDownload: !isDirectory && readable,
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
  return {
    kind: 'file',
    uri: input.uri,
    handlers: {
      refresh: input.accessBlocked ? undefined : handlers.refresh,
      'copy-link': handlers['copy-link'],
      'open-route': handlers['open-route'],
      'copy-content':
        !input.accessBlocked && input.copyContentSupported ? handlers['copy-content'] : undefined,
      share: handlers.share,
      rename: handlers.rename,
      move: handlers.move,
      download: handlers.download,
      delete: handlers.delete,
    },
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
