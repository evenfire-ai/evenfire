export function getAgentDisplayName(agentName: string): string {
  const trimmed = String(agentName || '').trim()
  if (!trimmed) return ''
  const segments = trimmed.split('/').filter(Boolean)
  if (segments.length === 0) return trimmed
  return segments[segments.length - 1]
}
