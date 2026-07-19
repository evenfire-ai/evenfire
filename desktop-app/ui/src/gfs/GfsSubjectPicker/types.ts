import type { GfsDelegationSubjectOption } from '@/gfs/delegation.types'

export interface GfsSubjectPickerProps {
  disabled?: boolean
  loading?: boolean
  onChange: (next: string[]) => void
  options: GfsDelegationSubjectOption[]
  value: string[]
}
