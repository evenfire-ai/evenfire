import type { GfsBrowserChild } from '@hooks/domain/useGfsBrowserController'
import type { Tone } from '@/uiTypes'

export type GfsDriveResource = GfsBrowserChild & {
  sources?: string[]
  permissions?: string[]
  coversDescendants?: boolean
}

export type GfsPreviewResource = Pick<GfsDriveResource, 'bytes' | 'gfsUri' | 'name'> &
  ({ kind: 'image'; mimeType: string } | { kind: 'markdown' })

export interface FilesPageProps {
  /** App-level toast dispatcher for success feedback (desktop-app/ui rule). */
  pushToast?: (message: string, tone: Tone) => void
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
