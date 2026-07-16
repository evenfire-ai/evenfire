export type GfsGrantSubjectType =
  | 'user'
  | 'team'
  | 'operator'
  | 'firstPartyAgent'
  | 'workflowPlugin'

export type GfsGrantSubjectOption = {
  value: string
  id: string
  label: string
  description?: string
  badge: string
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
