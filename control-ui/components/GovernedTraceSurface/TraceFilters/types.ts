import type { TraceExplorationState } from '@lib/governedTraceFilters'

export type TraceFilterOption = {
  label: string
  value: string
}

export type TraceFilterFieldDefinition = {
  key: string
  label: string
  placeholder?: string
  type: 'text' | 'enum' | 'operator' | 'user'
  options?: readonly TraceFilterOption[]
}

export type TraceColumnFilterDefinition = {
  id: string
  label: string
  fields: readonly TraceFilterFieldDefinition[]
}

export type TraceFiltersProps = {
  definitions: readonly TraceColumnFilterDefinition[]
  invalidRange: string | null
  onChange: (next: TraceExplorationState) => void
  onClose: () => void
  onOpenAll: () => void
  openFilterId: string | null
  state: TraceExplorationState
}

export type TraceFilterHeaderLabelProps = {
  activeCount: number
  label: string
  onOpen: () => void
}
