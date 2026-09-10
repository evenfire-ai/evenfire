import type { GfsBulkGrantSubjectInput, GfsSubjectInput } from '@lib/api'

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

/**
 * One displayed access row per subject: the direct grant plus any legacy URI
 * shares for that same subject, merged. The server has no share-update
 * surface, so any role change (or revoke) consolidates the subject onto the
 * single grant — the upsert preserves effective permissions (inherit ⊔
 * includeDescendants) and the superseded share rows are deleted.
 */
export type GfsExistingAccessItem = {
  subject: GfsSubjectInput
  permissions: string[]
  inherit: boolean
  grantId: string | null
  shareIds: string[]
}
