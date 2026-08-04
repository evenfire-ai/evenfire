import type { CodeDefault, NativeToolMeta } from './constants'

export type RowState = 'default' | 'required' | 'skip'

export interface ApprovalToolsDraft {
  rows: Record<string, RowState>
  customRows: Array<{ name: string; state: Exclude<RowState, 'default'> }>
}

export interface HostApprovalSectionProps {
  initialTools: Record<string, boolean> | undefined
  onSave: (tools: Record<string, boolean>) => Promise<void>
  busy: boolean
  canWrite: boolean
  // Render the full editable tool list immediately instead of the read-only
  // summary. The section stays expanded through Save/Cancel (Cancel discards
  // the in-progress draft but keeps the list visible).
  defaultEditing?: boolean
}

export type { CodeDefault, NativeToolMeta }
