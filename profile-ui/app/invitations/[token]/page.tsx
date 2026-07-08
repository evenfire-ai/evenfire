import { EXTERNAL_REST_API_INTERNAL_URL } from '@constants/serverApi'
import { resolveInvitationToken } from '@lib/invitations'
import type { InvitationPreview } from '@/app/types/api'
import { InvitationClient } from './InvitationClient'
import type { InvitationPageProps } from './types'

export const dynamic = 'force-dynamic'

async function loadInvitationPreview(
  invitationToken: string
): Promise<{ invitation: InvitationPreview | null; error: string }> {
  if (!invitationToken) {
    return { invitation: null, error: 'Invitation link is required.' }
  }

  try {
    const res = await fetch(
      `${EXTERNAL_REST_API_INTERNAL_URL}/api/v1/invitations/token/${encodeURIComponent(
        invitationToken
      )}`,
      {
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      }
    )

    if (!res.ok) {
      if (res.status === 400) return { invitation: null, error: 'Invalid invitation.' }
      if (res.status === 404) return { invitation: null, error: 'Invitation not found.' }
      if (res.status === 410) return { invitation: null, error: 'Invitation has expired.' }
      return { invitation: null, error: 'Failed to load invitation.' }
    }

    return { invitation: (await res.json()) as InvitationPreview, error: '' }
  } catch {
    return { invitation: null, error: 'Failed to load invitation.' }
  }
}

export default async function InvitationPage({ params, searchParams }: InvitationPageProps) {
  const resolvedParams = await params
  const resolvedSearchParams = searchParams ? await searchParams : {}
  const invitationToken = resolveInvitationToken(String(resolvedParams?.token || ''))
  const { invitation, error } = await loadInvitationPreview(invitationToken)
  const actionError = String(resolvedSearchParams?.error || '')

  return (
    <InvitationClient
      invitationToken={invitationToken}
      initialInvitation={invitation}
      initialError={actionError || error}
    />
  )
}
