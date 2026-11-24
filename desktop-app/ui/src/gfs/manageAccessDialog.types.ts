import type { GfsOperationAuthorityFailureHandler } from '@hooks/domain/useGfsResourceOperations.types'
import type { GfsFreshAuthority, GfsServerAuthority } from '@lib/gfsFreshPermissions.types'
import type { Tone } from '@/uiTypes'
import type { GfsActionGuardDeps } from './resourceActionRunners.types'

/** The resource the dialog shares: a listing row or the open location. */
export interface GfsManageAccessTarget {
  resourceId: string
  name: string
  kind: 'file' | 'directory'
}

/**
 * The owner's bindings. The dialog never decides on its own whether the
 * session may act: every read and write goes through these.
 */
export interface GfsManageAccessDeps {
  /** Withholds cached ACL rows while the owner has not re-proved the session. */
  gate: boolean
  /** Fail-closed boundary for the dialog's ACL reads and writes. */
  handleAuthorityFailure: GfsOperationAuthorityFailureHandler
  /** Classifies a caught write failure; true when the session failed closed. */
  failClosed: (error: unknown) => boolean
  /** Fresh (or freshly cached) authority; null after the toast that explains it. */
  freshPermissions: (
    resourceId: string,
    resourceName: string,
    bits: readonly string[],
    grantableBits?: readonly string[]
  ) => Promise<GfsFreshAuthority | null>
  /** Server-backed authority: reuses an affordances read at most
   *  `GFS_AUTHORITY_STALE_TIME_MS` old, never the owner's listing bits, so a
   *  role change is judged on grantable bits the server reported recently. */
  fetchAuthority: (resourceId: string, resourceName: string) => Promise<GfsServerAuthority | null>
  readAccessState: GfsActionGuardDeps['readAccessState']
  publishedGeneration: GfsActionGuardDeps['publishedGeneration']
  /** The session scope the owner runs now; read when a multi-step write binds its guards. */
  originScope: () => string | null
}

/**
 * Guards a parent-folder plan carries from the moment it is computed to the
 * end of its confirmation, so the plan is never applied under another session.
 */
export interface GfsParentUpdateGuards {
  /** The dialog is still mounted, its owner still current and the session unchanged. */
  isCurrent: () => boolean
  /** Session-only confirmation with main: ignores whether the dialog is still mounted. */
  sessionAdmit: () => Promise<boolean>
  presentOutcome: (message: string, tone: Tone) => void
  originScope: string | null
  originGen: number
}

export interface GfsManageAccessDialogProps {
  target: GfsManageAccessTarget
  /** The owner's liveness for this dialog (session scope and generation it opened under). */
  isCurrent: () => boolean
  deps: GfsManageAccessDeps
  pushToast?: (message: string, tone: Tone) => void
  onClose: () => void
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
