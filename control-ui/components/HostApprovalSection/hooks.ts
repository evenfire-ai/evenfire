import { useCallback, useMemo, useState } from 'react'
import type { HostResource } from '@lib/api'
import { approvalBlockOf, effectiveApproval, toolsEqual } from '@lib/approvalEffective'
import type {
  ApprovalToolsBase,
  ApprovalToolsDraft,
  ApprovalToolsSection,
  ApprovalToolsSectionState,
  ApprovalToolsStored,
  CustomRowState,
  RowState,
} from './types'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A Host's name: what tells one agent's data from another's. */
function hostName(host: HostResource | null): string | null {
  const name = host?.metadata?.name
  return typeof name === 'string' && name.length > 0 ? name : null
}

/** The base a save builds on: the stored `tools` as the protocol compares them (spec §6.4 step 4). */
function baseOf(stored: ApprovalToolsStored): ApprovalToolsBase {
  if (stored.inherited) return { tools: undefined, inherited: true }
  const tools = approvalBlockOf(stored.host)?.tools
  return { tools: isPlainObject(tools) ? { ...tools } : undefined, inherited: false }
}

/**
 * The overrides a row can show, on effective values: true and false as
 * stored; absent and null are Default. A value the CRD schema refuses
 * (it types them as boolean) shows as Default on both sides of the dirty check.
 */
function draftOf(tools: Record<string, unknown> | undefined): ApprovalToolsDraft {
  return effectiveApproval({ tools }).tools
}

/** The section with no edit open on `stored`: base and draft follow it. */
function settledOn(
  stored: ApprovalToolsStored,
  editing: boolean,
  editSession: number
): ApprovalToolsSectionState {
  const base = baseOf(stored)
  return { stored, base, draft: draftOf(base.tools), editing, editSession }
}

function isDirty(state: ApprovalToolsSectionState): boolean {
  return !toolsEqual(draftOf(state.base.tools), state.draft)
}

/**
 * New data from the tab (spec §6.4): a clean section takes it as stored, base
 * and draft; a dirty one updates stored only, so the base stays what it was
 * when editing started (A4 S2). Another agent's data, or none, ends the edit
 * session: a draft never moves from one agent to another.
 */
function take(
  previous: ApprovalToolsSectionState,
  stored: ApprovalToolsStored
): ApprovalToolsSectionState {
  const name = hostName(stored.host)
  const sameHost = name !== null && name === hostName(previous.stored.host)
  if (!sameHost) return settledOn(stored, false, previous.editSession)
  if (!isDirty(previous)) return settledOn(stored, previous.editing, previous.editSession)
  return { ...previous, stored }
}

function withDraft(
  previous: ApprovalToolsSectionState,
  change: (draft: ApprovalToolsDraft) => void
): ApprovalToolsSectionState {
  if (!previous.editing) return previous
  const draft = { ...previous.draft }
  change(draft)
  return { ...previous, draft }
}

/**
 * The per-tool section's state, `{ stored, base, draft, editing }` (spec
 * §6.4): `stored` is what the section last took from its props, `base` is
 * `stored` when Edit was pressed, and `draft` is the edit. Each Edit starts a
 * new edit session with its own token; `close` ends only the session it names.
 *
 * New props are taken while rendering, so no frame shows the old data with the
 * new props.
 */
export function useApprovalToolsSection(
  stored: HostResource | null,
  inherited: boolean
): ApprovalToolsSection {
  const [state, setState] = useState<ApprovalToolsSectionState>(() =>
    settledOn({ host: stored, inherited }, false, 0)
  )
  if (state.stored.host !== stored || state.stored.inherited !== inherited) {
    setState(previous =>
      previous.stored.host === stored && previous.stored.inherited === inherited
        ? previous
        : take(previous, { host: stored, inherited })
    )
  }

  const edit = useCallback(() => {
    setState(previous => settledOn(previous.stored, true, previous.editSession + 1))
  }, [])

  const cancel = useCallback(() => {
    setState(previous =>
      previous.editing ? settledOn(previous.stored, false, previous.editSession) : previous
    )
  }, [])

  const close = useCallback((editSession: number) => {
    setState(previous =>
      previous.editing && previous.editSession === editSession
        ? settledOn(previous.stored, false, previous.editSession)
        : previous
    )
  }, [])

  const setRow = useCallback((name: string, rowState: RowState) => {
    setState(previous =>
      withDraft(previous, draft => {
        if (rowState === 'default') delete draft[name]
        else draft[name] = rowState === 'required'
      })
    )
  }, [])

  const addCustom = useCallback((name: string, rowState: CustomRowState) => {
    setState(previous =>
      withDraft(previous, draft => {
        draft[name] = rowState === 'required'
      })
    )
  }, [])

  const removeCustom = useCallback((name: string) => {
    setState(previous =>
      withDraft(previous, draft => {
        delete draft[name]
      })
    )
  }, [])

  const dirty = useMemo(() => isDirty(state), [state])

  return { state, edit, cancel, close, setRow, addCustom, removeCustom, isDirty: dirty }
}
