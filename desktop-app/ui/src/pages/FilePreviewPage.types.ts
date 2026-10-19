import type { Tone } from '@/uiTypes'

export interface FilePreviewPageProps {
  /** The previewed file's gfsUri — the byte source and the tab's identity. */
  gfsUri: string
  /** The file name (the tab title), used for the preview heading and alt text. */
  fileName: string
  fileKind: 'image' | 'markdown' | 'video'
  mimeType?: string
  /** File size in bytes, for the per-kind size-guard (not the bytes). */
  byteLength: number
  /** Changes on remote invalidation so all current preview bodies remount generically. */
  reloadVersion?: number
  /** Set when an authoritative re-resolve denies access or the file is no longer previewable. */
  unavailable?: boolean
  pushToast?: (message: string, tone: Tone) => void
  onOpenRoute?: () => void
  /** Refresh the app-owned preview tab from the server after a successful rename. */
  onRenameCommitted?: (gfsUri: string) => void
  /** Native titlebar action slot supplied by the app shell. */
  titlebarLeadingTarget?: HTMLElement | null
}
