export const SANDBOX_UI_DEEP_LINK_HOST = 'app'
export const SANDBOX_UI_DEEP_LINK_PROTOCOL = 'evenfire:'

const MAX_APP_SEGMENT_LENGTH = 253
const MAX_APP_ROUTE_LENGTH = 4096
const MAX_TEAM_ID_LENGTH = 255
const APP_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
const TEAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

export type SandboxUiDeepLinkTarget = {
  appRef: string
  path: string
  teamId?: string
}

export type SandboxUiDeepLinkEnvelope = SandboxUiDeepLinkTarget & {
  id: number
}

type SandboxUiDeepLinkParts = {
  recipeNs: string
  recipeName: string
  path: string
  teamId?: string
}

type SandboxUiViewRouteInput = {
  currentUrl: string
  rpcProxyOrigin: string
  recipeNs: string
  recipeName: string
}

function isValidAppSegment(value: string): boolean {
  return (
    value.length > 0 && value.length <= MAX_APP_SEGMENT_LENGTH && APP_SEGMENT_PATTERN.test(value)
  )
}

function normalizeTeamId(rawTeamId: string | undefined): string | null {
  const teamId = String(rawTeamId || '').trim()
  if (!teamId) return ''
  if (teamId.length > MAX_TEAM_ID_LENGTH || !TEAM_ID_PATTERN.test(teamId)) return null
  return teamId
}

export function normalizeSandboxUiRoute(rawPath: string): string | null {
  const path = String(rawPath || '').trim()
  if (
    !path ||
    path.length > MAX_APP_ROUTE_LENGTH ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\')
  ) {
    return null
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) return null
  return path
}

export function buildSandboxUiDeepLink(parts: SandboxUiDeepLinkParts): string {
  const recipeNs = String(parts.recipeNs || '').trim()
  const recipeName = String(parts.recipeName || '').trim()
  const path = normalizeSandboxUiRoute(parts.path)
  const teamId = normalizeTeamId(parts.teamId)
  if (!isValidAppSegment(recipeNs) || !isValidAppSegment(recipeName) || !path || teamId === null) {
    throw new Error('Cannot create a deep link for this app route')
  }

  const url = new URL(
    `${SANDBOX_UI_DEEP_LINK_PROTOCOL}//${SANDBOX_UI_DEEP_LINK_HOST}/` +
      `${encodeURIComponent(recipeNs)}/${encodeURIComponent(recipeName)}`
  )
  url.searchParams.set('path', path)
  if (teamId) url.searchParams.set('team', teamId)
  return url.toString()
}

export function parseSandboxUiDeepLink(rawUrl: string): SandboxUiDeepLinkTarget | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (
    parsed.protocol !== SANDBOX_UI_DEEP_LINK_PROTOCOL ||
    parsed.hostname !== SANDBOX_UI_DEEP_LINK_HOST
  ) {
    return null
  }

  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length !== 2) return null
  let recipeNs: string
  let recipeName: string
  try {
    recipeNs = decodeURIComponent(segments[0] || '')
    recipeName = decodeURIComponent(segments[1] || '')
  } catch {
    return null
  }
  if (!isValidAppSegment(recipeNs) || !isValidAppSegment(recipeName)) return null

  const path = normalizeSandboxUiRoute(parsed.searchParams.get('path') || '/')
  if (!path) return null
  const teamId = normalizeTeamId(parsed.searchParams.get('team') || undefined)
  if (teamId === null) return null
  return {
    appRef: `${recipeNs}/${recipeName}`,
    path,
    ...(teamId ? { teamId } : {}),
  }
}

export function extractSandboxUiViewRoute(input: SandboxUiViewRouteInput): string | null {
  let current: URL
  let proxy: URL
  try {
    current = new URL(input.currentUrl)
    proxy = new URL(input.rpcProxyOrigin)
  } catch {
    return null
  }
  if (current.origin !== proxy.origin) return null

  const prefix =
    `/api/v1/sandbox-ui/${encodeURIComponent(input.recipeNs)}/` +
    `${encodeURIComponent(input.recipeName)}/view`
  if (current.pathname !== prefix && !current.pathname.startsWith(`${prefix}/`)) return null

  const pathname = current.pathname.slice(prefix.length) || '/'
  return normalizeSandboxUiRoute(`${pathname}${current.search}${current.hash}`)
}
