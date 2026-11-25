import type { RefObject } from 'react'
import type { HostResource } from '@lib/api'
import type { EffectiveApproval } from '@lib/approvalEffective'
import type { LooseningItem } from '@lib/approvalLoosening'
import type { ToolsSaveInput, ToolsSaveOutcome } from '@lib/hostApprovalSave'
import type { CodeDefault, NativeToolMeta } from './constants'

export type RowState = 'default' | 'required' | 'skip'

/** A custom row is always set: Required or Skip. Removing it is Default. */
export type CustomRowState = Exclude<RowState, 'default'>

export type ApprovalCeiling = EffectiveApproval['modeCeiling']

/** The policy a first save writes (spec §6.6; PR A offers these two). */
export type FirstSavePolicy = NonNullable<ToolsSaveInput['firstSavePolicy']>

export interface HostApprovalSectionProps {
  /** The agent (Host) the section shows and saves. */
  host: string
  /**
   * The Host the tab shows for `host`, or null while it has none (before its
   * first load, or while a kept page moves to another agent). The section
   * takes it as described in `useApprovalToolsSection`.
   */
  stored: HostResource | null
  /** Whether that Host has no `spec.approval` of its own: a save is a first save. */
  inherited: boolean
  /** The stored ceiling, for the loosening dialog's items (spec §6.6). */
  ceiling: ApprovalCeiling
  /**
   * Told the outcome of each save that settles: `saved`, or the outcome that
   * stopped it. A `reconfirm` is not reported: the section shows the loosening
   * dialog again, and the save settles after the admin confirms (or ends,
   * unreported, if they go back). A Retry after an error is a new save. It is
   * the callback the section was rendered with when Save was pressed, so its
   * closure names the save's agent, and it is called even when the section
   * has since unmounted or shows another agent.
   */
  onSettled: (outcome: ToolsSaveOutcome) => void
  /**
   * The Save release (spec §6.4 step 10, C10, A4 L2): true while the tab's
   * newest load of this agent has not settled, applied or failed. Save stays
   * disabled while it is true; Cancel and the rows do not wait for it. A tab
   * that loads after a save sets it from inside `onSettled`, so no frame shows
   * Save enabled between the save settling and that load starting. Absent
   * means no load is pending.
   */
  loadPending?: boolean
}

/** What the section last took from its props. */
export interface ApprovalToolsStored {
  host: HostResource | null
  inherited: boolean
}

/** The stored tools when Edit was pressed: what the save is built on. */
export interface ApprovalToolsBase {
  /** `spec.approval.tools` as stored, for the save's base check; undefined when there was none. */
  tools: Record<string, unknown> | undefined
  /** Whether there was no approval block: the save is a first save. */
  inherited: boolean
}

/** The overrides the admin wants: true is Required, false is Skip, absent is Default. */
export type ApprovalToolsDraft = Record<string, boolean>

export interface ApprovalToolsSectionState {
  stored: ApprovalToolsStored
  base: ApprovalToolsBase
  draft: ApprovalToolsDraft
  editing: boolean
  /** The current edit session's token. Each Edit takes the next one. */
  editSession: number
}

export interface ApprovalToolsSection {
  state: ApprovalToolsSectionState
  /** Opens a new edit session on the stored data. */
  edit(): void
  /** Ends the edit session and drops the draft. */
  cancel(): void
  /** Ends the edit session only if `editSession` is still the current one (spec §6.4 step 10). */
  close(editSession: number): void
  setRow(name: string, state: RowState): void
  addCustom(name: string, state: CustomRowState): void
  removeCustom(name: string): void
  /** Whether the draft differs from the base on effective values (spec §6.4). */
  isDirty: boolean
}

/** One run of the save protocol, and what its outcome is checked against. */
export interface SaveRun {
  input: ToolsSaveInput
  /** The edit session the save started in. */
  editSession: number
  /** The `onSettled` of the render where Save was pressed. */
  report: (outcome: ToolsSaveOutcome) => void
}

/** The dialog the section shows: the first save's policy, then the loosening items. */
export type SectionDialog =
  | { kind: 'first_save'; editSession: number; report: SaveRun['report'] }
  | { kind: 'loosening'; items: LooseningItem[]; run: SaveRun }

/** A save's outcome as the section shows it: the outcomes that end with a message. */
export type SectionMessage = Exclude<ToolsSaveOutcome, { kind: 'saved' } | { kind: 'reconfirm' }>

export interface ShownMessage {
  outcome: SectionMessage
  /** For an error: the save Retry sends again, offered while its edit session is open. */
  retry?: SaveRun
}

export interface ReadViewProps {
  stored: ApprovalToolsStored
  ceiling: ApprovalCeiling
}

export interface ReadRowProps {
  name: string
  required: boolean
  ceiling: ApprovalCeiling
}

export interface EditViewProps {
  draft: ApprovalToolsDraft
  saving: boolean
  onSetRow: ApprovalToolsSection['setRow']
  onAddCustom: ApprovalToolsSection['addCustom']
  onRemoveCustom: ApprovalToolsSection['removeCustom']
}

export interface EditRowProps {
  tool: NativeToolMeta
  state: RowState
  disabled: boolean
  onChange: ApprovalToolsSection['setRow']
}

export interface AddCustomToolProps {
  customNames: readonly string[]
  disabled: boolean
  onAdd: ApprovalToolsSection['addCustom']
}

export interface OutcomeMessageProps {
  message: ShownMessage
  messageRef: RefObject<HTMLDivElement>
  saving: boolean
  onRetry: (run: SaveRun) => void
}

export interface FirstSaveDialogProps {
  open: boolean
  onCancel: () => void
  onSave: (policy: FirstSavePolicy) => void
}

export interface LooseningDialogProps {
  open: boolean
  items: readonly LooseningItem[]
  /** The draft being saved, to tell a removed row from one set to Skip. */
  draft: ApprovalToolsDraft
  onCancel: () => void
  onConfirm: () => void
}

/** What a loosening item's text is built from. */
export interface LooseningItemSubject {
  /** The tool's name. */
  name: string
  /** The draft no longer holds an override for it. */
  removed: boolean
  /** The tool's conditional-default text, when it has one. */
  conditions?: string
}

export type { CodeDefault, NativeToolMeta }
