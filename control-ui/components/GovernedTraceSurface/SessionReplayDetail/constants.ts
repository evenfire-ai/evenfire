import type { TableHeaderColumn } from '@components/TableHeaderRow/types'

export const SESSION_RUN_COLUMNS: TableHeaderColumn[] = [
  { key: 'run', label: 'Run', minWidth: '14rem' },
  { key: 'started', label: 'First observed', minWidth: '11rem' },
  { key: 'ended', label: 'Last observed', minWidth: '11rem' },
  { key: 'outcome', label: 'Outcome', minWidth: '8rem' },
  { key: 'events', label: 'Events', minWidth: '6rem' },
]

export const SESSION_TOOL_COLUMNS: TableHeaderColumn[] = [
  { key: 'tool', label: 'Tool', minWidth: '12rem' },
  { key: 'kind', label: 'Type', minWidth: '10rem' },
  { key: 'source', label: 'Source', minWidth: '11rem' },
  { key: 'calls', label: 'Calls', minWidth: '7rem' },
  { key: 'succeeded', label: 'Succeeded', minWidth: '8rem' },
  { key: 'failed', label: 'Failed', minWidth: '7rem' },
  { key: 'first', label: 'First observed', minWidth: '11rem' },
  { key: 'last', label: 'Last observed', minWidth: '11rem' },
]
