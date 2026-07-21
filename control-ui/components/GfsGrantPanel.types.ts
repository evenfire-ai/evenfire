import type { GfsBulkGrantSubjectInput, GfsGrantListItem, GfsShareListItem } from '@lib/api'

export type GfsGrantSubjectType =
  | 'user'
  | 'team'
  | 'operator'
  | 'firstPartyAgent'
  | 'workflowPlugin'

export type GfsGrantMode = 'subjects' | 'operator'

export type GfsBulkSubjectInput = GfsBulkGrantSubjectInput

export type GfsGrantSubjectOption = {
  value: string
  id: string
  label: string
  description?: string
  badge: string
  subject: GfsBulkSubjectInput
}

export type GfsGrantResource = {
  resourceId: string
  name: string
  gfsUri: string
  kind?: string
}

export interface GfsGrantPanelProps {
  resource: GfsGrantResource
}

export type GfsExistingAccessItem =
  | ({ kind: 'grant' } & GfsGrantListItem)
  | ({ kind: 'share' } & GfsShareListItem)
