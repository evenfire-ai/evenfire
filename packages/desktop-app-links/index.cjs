'use strict'

const SANDBOX_UI_DEEP_LINK_HOST = 'app'
const SANDBOX_UI_DEEP_LINK_PROTOCOL = 'evenfire:'
const CLERUM_OAUTH_PROTOCOL = 'clerum:'
const SANDBOX_UI_WEB_LINK_PATH = '/open/apps'
const MAX_APP_SEGMENT_LENGTH = 253
const MAX_APP_ROUTE_LENGTH = 4096
const MAX_TEAM_ID_LENGTH = 255
const APP_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
const TEAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const ROUTE_UNSAFE_CHAR_PATTERN = /[\u0000-\u001f\u007f\u2028\u2029]/
const PERCENT_ESCAPE_PATTERN = /%[0-9a-f]{2}/i
const RECURSIVE_ROUTE_ESCAPE_PATTERN =
  /%(?:25)*(?:00|0a|0d|1c|1d|1e|1f|23|2e|2f|3f|5c|7f|e2%80%a8|e2%80%a9)/i
const MAX_ROUTE_SEGMENT_DECODE_DEPTH = 6

function isValidAppSegment(value) {
  return (
    value.length > 0 && value.length <= MAX_APP_SEGMENT_LENGTH && APP_SEGMENT_PATTERN.test(value)
  )
}

function normalizeTeamId(rawTeamId) {
  const teamId = String(rawTeamId || '').trim()
  if (!teamId) return ''
  if (teamId.length > MAX_TEAM_ID_LENGTH || !TEAM_ID_PATTERN.test(teamId)) return null
  return teamId
}

function isUnsafeRouteSegment(rawSegment) {
  let segment = rawSegment
  for (let depth = 0; depth <= MAX_ROUTE_SEGMENT_DECODE_DEPTH; depth += 1) {
    if (segment === '.' || segment === '..') return true
    if (
      segment.includes('/') ||
      segment.includes('\\') ||
      segment.includes('?') ||
      segment.includes('#') ||
      ROUTE_UNSAFE_CHAR_PATTERN.test(segment)
    ) {
      return true
    }
    if (!PERCENT_ESCAPE_PATTERN.test(segment)) return false
    let decoded
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return true
    }
    if (decoded === segment) return false
    segment = decoded
  }
  return RECURSIVE_ROUTE_ESCAPE_PATTERN.test(segment)
}

function canonicalizeRouteSegment(rawSegment) {
  let segment = rawSegment
  for (let depth = 0; depth <= MAX_ROUTE_SEGMENT_DECODE_DEPTH; depth += 1) {
    if (isUnsafeRouteSegment(segment)) return null
    if (!PERCENT_ESCAPE_PATTERN.test(segment)) return segment
    let decoded
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (decoded === segment) return segment
    segment = decoded
  }
  return PERCENT_ESCAPE_PATTERN.test(segment) ? null : segment
}

function normalizeSandboxUiRoute(rawPath) {
  const routePath = String(rawPath || '').trim()
  if (!routePath) return undefined
  if (
    routePath.length > MAX_APP_ROUTE_LENGTH ||
    !routePath.startsWith('/') ||
    routePath.startsWith('//') ||
    routePath.includes('\\') ||
    routePath.includes('?') ||
    routePath.includes('#') ||
    ROUTE_UNSAFE_CHAR_PATTERN.test(routePath)
  ) {
    return null
  }
  const canonicalSegments = []
  for (const segment of routePath.split('/')) {
    const canonicalSegment = canonicalizeRouteSegment(segment)
    if (canonicalSegment === null) return null
    canonicalSegments.push(canonicalSegment)
  }
  const canonicalPath = canonicalSegments.join('/')
  if (canonicalPath.length > MAX_APP_ROUTE_LENGTH) return null
  return canonicalPath
}

function validateParts(parts) {
  const recipeNs = String(parts.recipeNs || '').trim()
  const recipeName = String(parts.recipeName || '').trim()
  const routePath = normalizeSandboxUiRoute(parts.path)
  const teamId = normalizeTeamId(parts.teamId)
  if (
    !isValidAppSegment(recipeNs) ||
    !isValidAppSegment(recipeName) ||
    routePath === null ||
    teamId === null
  ) {
    return null
  }
  return { recipeNs, recipeName, path: routePath, teamId: teamId || undefined }
}

function buildSandboxUiDeepLink(parts) {
  const valid = validateParts(parts)
  if (!valid) throw new Error('Cannot create a deep link for this app route')
  const url = new URL(
    `${SANDBOX_UI_DEEP_LINK_PROTOCOL}//${SANDBOX_UI_DEEP_LINK_HOST}/` +
      `${encodeURIComponent(valid.recipeNs)}/${encodeURIComponent(valid.recipeName)}`
  )
  if (valid.path) url.searchParams.set('path', valid.path)
  if (valid.teamId) url.searchParams.set('team', valid.teamId)
  return url.toString()
}

function buildSandboxUiWebLink(profileUiBaseUrl, parts) {
  const valid = validateParts(parts)
  if (!valid) throw new Error('Cannot create a deep link for this app route')
  let baseUrl
  try {
    baseUrl = new URL(profileUiBaseUrl)
  } catch {
    throw new Error('Cannot create a shareable link for this desktop environment')
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new Error('Cannot create a shareable link for this desktop environment')
  }
  if (baseUrl.pathname !== '/' || baseUrl.search) {
    throw new Error('Cannot create a shareable link for this desktop environment')
  }

  baseUrl.hash = ''
  baseUrl.pathname =
    `${SANDBOX_UI_WEB_LINK_PATH}/${encodeURIComponent(valid.recipeNs)}/` +
    encodeURIComponent(valid.recipeName)
  const search = new URLSearchParams()
  if (valid.path) search.set('path', valid.path)
  if (valid.teamId) search.set('team', valid.teamId)
  baseUrl.search = search.toString()
  return baseUrl.toString()
}

function parseSandboxUiDeepLink(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (
    parsed.protocol !== SANDBOX_UI_DEEP_LINK_PROTOCOL ||
    parsed.hostname.toLowerCase() !== SANDBOX_UI_DEEP_LINK_HOST ||
    parsed.port
  ) {
    return null
  }
  // The canonical app target has exactly two path segments. Reject a trailing
  // slash explicitly so producers and consumers cannot disagree on identity.
  if (parsed.pathname.endsWith('/')) return null

  const segments = parsed.pathname.split('/')
  if (segments.length !== 3 || segments[0] !== '' || !segments[1] || !segments[2]) return null
  let recipeNs
  let recipeName
  try {
    recipeNs = decodeURIComponent(segments[1] || '')
    recipeName = decodeURIComponent(segments[2] || '')
  } catch {
    return null
  }
  const valid = validateParts({
    recipeNs,
    recipeName,
    path: parsed.searchParams.get('path') || undefined,
    teamId: parsed.searchParams.get('team') || undefined,
  })
  if (!valid) return null
  return {
    appRef: `${valid.recipeNs}/${valid.recipeName}`,
    ...(valid.path ? { path: valid.path } : {}),
    ...(valid.teamId ? { teamId: valid.teamId } : {}),
  }
}

function sandboxUiDeepLinkTargetsEqual(left, right) {
  return (
    left.appRef.toLowerCase() === right.appRef.toLowerCase() &&
    (left.path || '') === (right.path || '') &&
    (left.teamId || '') === (right.teamId || '')
  )
}

module.exports = {
  CLERUM_OAUTH_PROTOCOL,
  SANDBOX_UI_DEEP_LINK_HOST,
  SANDBOX_UI_DEEP_LINK_PROTOCOL,
  SANDBOX_UI_WEB_LINK_PATH,
  buildSandboxUiDeepLink,
  buildSandboxUiWebLink,
  normalizeSandboxUiRoute,
  parseSandboxUiDeepLink,
  sandboxUiDeepLinkTargetsEqual,
}
