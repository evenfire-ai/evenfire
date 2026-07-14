import type { InviteRole } from '@lib/api'

export type { InviteRole }

export type InviteTeamOption = {
  id: string
  name: string
}

export type InviteMemberDialogProps = {
  isOpen: boolean
  embedded?: boolean
  busy: boolean
  error?: string
  name: string
  email: string
  role: InviteRole
  teamId: string
  teams: InviteTeamOption[]
  lockedTeamId?: string
  title?: string
  submitLabel?: string
  onClose: () => void
  onNameChange: (value: string) => void
  onEmailChange: (value: string) => void
  onRoleChange: (value: InviteRole) => void
  onTeamChange: (value: string) => void
  onSubmit: () => void
}
