const APP_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
const TEAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const MAX_APP_SEGMENT_LENGTH = 253
const MAX_APP_ROUTE_LENGTH = 4096
const MAX_TEAM_ID_LENGTH = 255

export function buildEvenfireDesktopAppLink(parts: {
  recipeNs: string
  recipeName: string
  path: string
  teamId?: string
}): string | null {
  const recipeNs = String(parts.recipeNs || '').trim()
  const recipeName = String(parts.recipeName || '').trim()
  const path = String(parts.path || '').trim()
  const teamId = String(parts.teamId || '').trim()
  const validSegment = (value: string) =>
    value.length > 0 && value.length <= MAX_APP_SEGMENT_LENGTH && APP_SEGMENT_PATTERN.test(value)

  if (
    !validSegment(recipeNs) ||
    !validSegment(recipeName) ||
    !path ||
    path.length > MAX_APP_ROUTE_LENGTH ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    (teamId && (teamId.length > MAX_TEAM_ID_LENGTH || !TEAM_ID_PATTERN.test(teamId)))
  ) {
    return null
  }

  const url = new URL(
    `evenfire://app/${encodeURIComponent(recipeNs)}/${encodeURIComponent(recipeName)}`
  )
  url.searchParams.set('path', path)
  if (teamId) url.searchParams.set('team', teamId)
  return url.toString()
}
