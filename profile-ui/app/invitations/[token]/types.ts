import type { InvitationPreview } from '@/app/types/api'

export type InvitationClientProps = {
  invitationToken: string
  initialInvitation: InvitationPreview | null
  initialError: string
}

export type InvitationPageProps = {
  params: Promise<{ token?: string }> | { token?: string }
  searchParams?: Promise<{ error?: string }> | { error?: string }
}
