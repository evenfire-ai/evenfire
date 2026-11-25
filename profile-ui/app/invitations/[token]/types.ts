import type { InvitationPreview } from '@/app/types/api'

export type InvitationClientProps = {
  invitationToken: string
  initialInvitation: InvitationPreview | null
  initialError: string
}

export type InvitationPageProps = {
  params: Promise<{ token: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

/** The action panel the invitation page shows. */
export type InvitationPanelMode =
  | 'link-error'
  | 'password-updated'
  | 'outcome-unknown'
  | 'terminal'
  | 'used'
  | 'expired'
  | 'password-setup'
  | 'accept'
