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
