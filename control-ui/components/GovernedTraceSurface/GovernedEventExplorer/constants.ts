export const ADMINISTRATIVE_COLUMN_LAYOUT = [
  { key: 'action', label: 'Change / approval', minWidth: '13rem' },
  { key: 'operator', label: 'Operator', minWidth: '13rem' },
  { key: 'actor', label: 'Acting service / agent', minWidth: '13rem' },
  { key: 'target', label: 'Target', minWidth: '13rem' },
  { key: 'outcome', label: 'Outcome', minWidth: '8rem' },
  { key: 'occurred', label: 'Occurred', minWidth: '11rem' },
] as const

export const INFRASTRUCTURE_COLUMN_LAYOUT = [
  { key: 'workload', label: 'Workload / event', minWidth: '14rem' },
  { key: 'telemetry', label: 'Telemetry', minWidth: '12rem' },
  { key: 'source', label: 'Controller', minWidth: '12rem' },
  { key: 'scope', label: 'Scope', minWidth: '12rem' },
  { key: 'outcome', label: 'Outcome', minWidth: '8rem' },
  { key: 'occurred', label: 'Occurred', minWidth: '11rem' },
] as const
