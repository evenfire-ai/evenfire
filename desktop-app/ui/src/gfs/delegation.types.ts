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
  onGrant: (subjectKey: string, bits: string[]) => Promise<void>
  onCreateShare?: (subjectKey: string) => Promise<void>
}
