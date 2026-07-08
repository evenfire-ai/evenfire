import { useCallback, useMemo, useState } from 'react'
import { NATIVE_TOOLS } from './constants'
import type { ApprovalToolsDraft, RowState } from './types'

const KNOWN_TOOLS = new Set(NATIVE_TOOLS.map(t => t.name))

function fromToolsMap(tools: Record<string, boolean> | undefined): ApprovalToolsDraft {
  const rows: Record<string, RowState> = {}
  const customRows: ApprovalToolsDraft['customRows'] = []

  if (tools) {
    for (const [name, value] of Object.entries(tools)) {
      const state: Exclude<RowState, 'default'> = value ? 'required' : 'skip'
      if (KNOWN_TOOLS.has(name)) {
        rows[name] = state
      } else {
        customRows.push({ name, state })
      }
    }
    customRows.sort((a, b) => a.name.localeCompare(b.name))
  }
  return { rows, customRows }
}

export interface UseApprovalToolsDraft {
  draft: ApprovalToolsDraft
  setRowState: (toolName: string, state: RowState) => void
  addCustomRow: (name: string, state: Exclude<RowState, 'default'>) => void
  removeCustomRow: (index: number) => void
  isDirty: boolean
  toToolsMap: () => Record<string, boolean>
  reset: () => void
}

export function useApprovalToolsDraft(
  initialTools: Record<string, boolean> | undefined
): UseApprovalToolsDraft {
  const initial = useMemo(() => fromToolsMap(initialTools), [initialTools])
  const [draft, setDraft] = useState<ApprovalToolsDraft>(initial)

  const setRowState = useCallback((toolName: string, state: RowState) => {
    setDraft(prev => {
      const rows = { ...prev.rows }
      if (state === 'default') {
        delete rows[toolName]
      } else {
        rows[toolName] = state
      }
      return { ...prev, rows }
    })
  }, [])

  const addCustomRow = useCallback((name: string, state: Exclude<RowState, 'default'>) => {
    setDraft(prev => {
      const next = [...prev.customRows, { name, state }]
      next.sort((a, b) => a.name.localeCompare(b.name))
      return { ...prev, customRows: next }
    })
  }, [])

  const removeCustomRow = useCallback((index: number) => {
    setDraft(prev => {
      const next = prev.customRows.filter((_, i) => i !== index)
      return { ...prev, customRows: next }
    })
  }, [])

  const isDirty = useMemo(() => {
    if (Object.keys(draft.rows).length !== Object.keys(initial.rows).length) return true
    for (const name of Object.keys(draft.rows)) {
      if (draft.rows[name] !== initial.rows[name]) return true
    }
    if (draft.customRows.length !== initial.customRows.length) return true
    for (let i = 0; i < draft.customRows.length; i++) {
      if (
        draft.customRows[i].name !== initial.customRows[i].name ||
        draft.customRows[i].state !== initial.customRows[i].state
      ) {
        return true
      }
    }
    return false
  }, [draft, initial])

  const toToolsMap = useCallback((): Record<string, boolean> => {
    const out: Record<string, boolean> = {}
    for (const [name, state] of Object.entries(draft.rows)) {
      if (state === 'required') out[name] = true
      else if (state === 'skip') out[name] = false
    }
    for (const row of draft.customRows) {
      out[row.name] = row.state === 'required'
    }
    return out
  }, [draft])

  const reset = useCallback(() => setDraft(initial), [initial])

  return { draft, setRowState, addCustomRow, removeCustomRow, isDirty, toToolsMap, reset }
}
