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
const DOT_SEGMENT_PATTERN = /^(?:\.|%2e){1,2}$/i

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
    /[\u0000-\u001f\u007f]/.test(routePath)
  ) {
    return null
  }
  if (routePath.split('/').some(segment => DOT_SEGMENT_PATTERN.test(segment))) return null
  return routePath
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
