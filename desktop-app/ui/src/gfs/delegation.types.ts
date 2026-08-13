export interface DelegationAffordances {
  canDelegate: boolean
  grantableBits: string[]
  canCreateShare: boolean
}

export type GfsDelegationSubjectType = 'user' | 'team' | 'host'

export interface GfsDelegationSubjectOption {
  type: GfsDelegationSubjectType
  id: string
  label: string
  description?: string
  /** Display label for the subject kind (e.g. "Agent"); falls back to `type`. */
  badge?: string
}

export interface GfsDelegationPanelProps {
  affordances: DelegationAffordances
  subjectOptions: GfsDelegationSubjectOption[]
  subjectOptionsLoading?: boolean
  subjectOptionsError?: string | null
  /** Directories offer the "Include contents" toggle (default ON); files always send inherit=false. */
  isDirectory: boolean
  onGrant: (subjectKeys: string[], bits: string[], inherit: boolean) => Promise<void>
  onCreateShare?: (subjectKeys: string[]) => Promise<void>
}

/**
 * One of MY agents, offered as a delegation target. `id` is the canonical
 * managed-host subject id (`1st:<namespace>/<name>`) from
 * `window.clerum.agents.listMine()`; the grant subject key is `host:` + id.
 */
export interface GfsAgentSubjectOption {
  id: string
  /** Agent identifier (`metadata.name`) — used for keys and stable sorting. */
  name: string
  /** Visible name (Agent CRD `spec.host`); rendered to the user when present. */
  displayName?: string
}

/**
 * A row from `window.clerum.gfs.listGrants()` — the admin-GET item shape
 * surfaced on the user plane. `id` powers revoke (the grant PUT response
 * carries no ids, so this list is the only revoke-id source).
 */
export interface GfsGrantListItem {
  id: string
  drive: string
  resourceId: string
  subject: { type: string; id?: string }
  permissions: string[]
  inherit: boolean
}
