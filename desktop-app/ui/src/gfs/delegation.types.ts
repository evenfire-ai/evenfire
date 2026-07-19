export interface DelegationAffordances {
  canDelegate: boolean
  grantableBits: string[]
  canCreateShare: boolean
}

export type GfsDelegationSubjectType = 'user' | 'team'

export interface GfsDelegationSubjectOption {
  type: GfsDelegationSubjectType
  id: string
  label: string
  description?: string
}

export interface GfsDelegationPanelProps {
  affordances: DelegationAffordances
  subjectOptions: GfsDelegationSubjectOption[]
  subjectOptionsLoading?: boolean
  subjectOptionsError?: string | null
  onGrant: (subjectKeys: string[], bits: string[]) => Promise<void>
  onCreateShare?: (subjectKeys: string[]) => Promise<void>
}
