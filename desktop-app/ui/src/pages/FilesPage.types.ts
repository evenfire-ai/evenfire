import type { GfsBrowserChild } from '@hooks/domain/useGfsBrowserController'
import type { GfsPreviewResource } from '@lib/gfsPreview'
import type { Tone } from '@/uiTypes'

export type GfsDriveResource = GfsBrowserChild & {
  sources?: string[]
  permissions?: string[]
  coversDescendants?: boolean
}

export interface FilesPageProps {
  /** App-level toast dispatcher for success feedback (desktop-app/ui rule). */
  pushToast?: (message: string, tone: Tone, options?: { durationMs?: number }) => void
  /** Native titlebar action slot supplied by the app shell. */
  titlebarLeadingTarget?: HTMLElement | null
  /**
   * A `gfs://` link handed over from elsewhere in the app — today, a plugin
   * asking to open a resource this page can show better than an overlay can
   * (a folder, or a file with no preview). Opened once, then cleared.
   */
  pendingGfsUri?: string | null
  onPendingGfsUriHandled?: () => void
  /** App-queued deep link whose resolve outcome controls main-process acknowledgment. */
  pendingGfsDeepLink?: { id: number; uri: string } | null
  /** Stable destination tab captured by the App navigation authority. */
  workspaceTabId?: string
  pendingGfsDeepLinkOwnerTabId?: string
  /** Live owner/session/intent fence for this queued request. */
  isPendingGfsDeepLinkCurrent?: () => boolean
  /** App-owned intent ordering for explicit navigation within this Files tab. */
  onExplicitNavigationIntent?: () => void
  onPendingGfsDeepLinkOutcome?: (
    id: number,
    outcome: 'opened' | 'terminal' | 'retryable' | 'superseded'
  ) => void
  /**
   * Reports the browser's live location so the owning files tab can persist it
   * (mini-spec 06 §3). Emits the current leaf `gfsUri` (the stable identity) and
   * the current folder's display name (the tab title) whenever the location
   * changes, including back to the virtual root (`null`, `null`). The opaque
   * `gfsUri` carries no name, hence the second argument.
   */
  onLocationChange?: (gfsUri: string | null, name: string | null) => void
  /** Monotonic signal from the app-level entity stream for live path reconciliation. */
  remoteGfsChangeEpoch?: number
  /**
   * Open (or focus) a preview tab for a previewable file (spec 18 §3.B.4). The
   * files browser no longer renders a preview modal: `openFilePreview` resolves
   * the file kind and hands the descriptor up to the tab store through this
   * callback. Absent ⇒ no preview surface is available (the file downloads).
   */
  onOpenPreview?: (preview: GfsPreviewResource) => void | boolean
  /** Guarded preview completion for the queued resource-link request. */
  onOpenPendingGfsPreview?: (
    id: number,
    preview: GfsPreviewResource,
    returnLocation: { gfsUri: string | null; name: string | null }
  ) => boolean
  /** Monotonic App request to open the existing route-entry dialog. */
  routeDialogRequestId?: number
  onRouteDialogRequestHandled?: (requestId: number) => void
}

/**
 * Structural shape of one `window.clerum.agents.listMine()` entry (the wire
 * type is `AgentWithMcpServers` in `desktop-app/src/types.ts`). Only entries
 * with a valid `host` gfsSubject are delegation targets.
 */
export interface MyAgentEntry {
  name: string
  /** Visible name (Agent CRD `spec.host`) surfaced on the wire; may be absent on older builds. */
  displayName?: string
  gfsSubject?: { type: string; id: string }
}
