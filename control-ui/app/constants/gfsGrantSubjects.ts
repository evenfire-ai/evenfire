export const GFS_FIRST_PARTY_HOST_SUBJECT_ID = '1st:mcp-host/standalone'
export const GFS_FIRST_PARTY_HOST_OPTION_VALUE = `host:${GFS_FIRST_PARTY_HOST_SUBJECT_ID}`

export const GFS_GRANT_SUBJECT_TYPE_OPTIONS = [
  { value: 'user', label: 'User' },
  { value: 'team', label: 'Team' },
  { value: 'operator', label: 'Operator' },
  { value: 'firstPartyAgent', label: 'First-party agent' },
  { value: 'workflowPlugin', label: 'Workflow / plugin' },
] as const
