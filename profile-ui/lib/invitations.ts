export function formatRemaining(expiresAt: string, now: number): string {
  const target = new Date(expiresAt).getTime()
  if (Number.isNaN(target)) {
    return '48 hours'
  }

  const diffMs = target - now
  if (diffMs <= 0) {
    return 'expired'
  }

  const diffMinutes = Math.max(1, Math.floor(diffMs / 60000))
  const days = Math.floor(diffMinutes / (60 * 24))
  const hours = Math.floor((diffMinutes % (60 * 24)) / 60)
  const minutes = diffMinutes % 60
  const parts: string[] = []

  if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'}`)
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`)
  if (days === 0 && minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`)

  return parts.join(', ')
}

export function buildInvitationHeading(teamName: string | null | undefined): string {
  return teamName ? `Join ${teamName} team` : 'Join Evenfire'
}

export function buildInvitationTeamsLabel(
  teams: Array<{ name: string }> | undefined,
  teamName: string | null | undefined
): string {
  if (Array.isArray(teams) && teams.length > 0) {
    return teams.map(team => team.name).join(', ')
  }
  return teamName || ''
}

export function resolveInvitationToken(token: string): string {
  return token.trim()
}
