'use strict'

const SANDBOX_UI_DEEP_LINK_HOST = 'app'
const SANDBOX_UI_DEEP_LINK_PROTOCOL = 'evenfire:'
const CLERUM_OAUTH_PROTOCOL = 'clerum:'
const SANDBOX_UI_WEB_LINK_PATH = '/open/apps'
const GFS_RESOURCE_DEEP_LINK_HOST = 'files'
const GFS_RESOURCE_WEB_LINK_PATH = '/open/files'
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
const DESKTOP_LOGIN_PATH = '/desktop-login'
const DESKTOP_LOGIN_DEEP_LINK_HOST = 'desktop-login'
const DESKTOP_LOGIN_ERRORS = Object.freeze(['refused', 'cancelled', 'unavailable', 'failed'])
const DESKTOP_LOGIN_REFUSAL_REASONS = Object.freeze([
  'account_disabled',
  'identity_conflict',
  'account_needs_attention',
  'email_claim_missing',
  'email_unverified',
  'not_eligible',
  'no_account',
  'provider_configuration',
])
const MAX_DESKTOP_LOGIN_URL_LENGTH = 2048
// One UTF-16 code unit percent-encodes to at most 9 characters (3 UTF-8 bytes),
// so this admits every link whose environment is within the URL limit.
const MAX_DESKTOP_LOGIN_LINK_LENGTH = 256 + 9 * MAX_DESKTOP_LOGIN_URL_LENGTH
const DESKTOP_LOGIN_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const DESKTOP_LOGIN_LINK_KEYS = new Set(['state', 'code', 'environment', 'error', 'reason'])

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
    if (segment === '.' || segment === '..' || segment.trim() !== segment) return true
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
  const routePath = String(rawPath || '')
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

function normalizeGfsResourceUri(rawUri) {
  if (typeof rawUri !== 'string' || rawUri.length > 1024) return null
  const match =
    /^gfs:\/\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?)\/([0-9a-f]{32})$/i.exec(rawUri)
  if (!match) return null
  const drive = match[1]
  const rid = match[2]
  if (!drive || !rid) return null
  return `gfs://${drive}/${rid.toLowerCase()}`
}

function buildGfsResourceDeepLink(uri) {
  const canonicalUri = normalizeGfsResourceUri(uri)
  if (!canonicalUri) throw new Error('Cannot create a deep link for this resource')
  const url = new URL(`evenfire://${GFS_RESOURCE_DEEP_LINK_HOST}`)
  url.searchParams.set('uri', canonicalUri)
  return url.toString()
}

function buildGfsResourceWebLink(profileUiBaseUrl, uri) {
  const canonicalUri = normalizeGfsResourceUri(uri)
  if (!canonicalUri) throw new Error('Cannot create a deep link for this resource')
  let baseUrl
  try {
    baseUrl = new URL(profileUiBaseUrl)
  } catch {
    throw new Error('Cannot create a shareable link for this desktop environment')
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new Error('Cannot create a shareable link for this desktop environment')
  }
  if (baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash) {
    throw new Error('Cannot create a shareable link for this desktop environment')
  }
  baseUrl.pathname = GFS_RESOURCE_WEB_LINK_PATH
  baseUrl.searchParams.set('uri', canonicalUri)
  return baseUrl.toString()
}

function parseGfsResourceDeepLink(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (
    parsed.protocol !== SANDBOX_UI_DEEP_LINK_PROTOCOL ||
    parsed.hostname.toLowerCase() !== GFS_RESOURCE_DEEP_LINK_HOST ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '' ||
    parsed.hash ||
    [...parsed.searchParams.keys()].some(key => key !== 'uri') ||
    parsed.searchParams.getAll('uri').length !== 1
  ) {
    return null
  }
  const uri = normalizeGfsResourceUri(parsed.searchParams.get('uri'))
  return uri ? { uri } : null
}

function parseGfsResourceLink(rawLink) {
  if (typeof rawLink !== 'string' || rawLink.length > 4096) return null
  const value = rawLink.trim()
  const uri = normalizeGfsResourceUri(value)
  if (uri) return { uri }

  const desktopTarget = parseGfsResourceDeepLink(value)
  if (desktopTarget) return desktopTarget

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== GFS_RESOURCE_WEB_LINK_PATH ||
    parsed.hash ||
    [...parsed.searchParams.keys()].some(key => key !== 'uri') ||
    parsed.searchParams.getAll('uri').length !== 1
  ) {
    return null
  }

  const webUri = normalizeGfsResourceUri(parsed.searchParams.get('uri'))
  return webUri ? { uri: webUri } : null
}

// Desktop sign-in values cross from Desktop to Profile UI and back. Unlike the
// app links above, every parser here is strict: an unknown, extra or duplicate
// value makes the whole input invalid.

function isDesktopLoginValue(value) {
  return typeof value === 'string' && DESKTOP_LOGIN_VALUE_PATTERN.test(value)
}

function parseBoundedUrl(rawUrl, maxLength) {
  if (typeof rawUrl !== 'string' || rawUrl.length > maxLength) return null
  try {
    return new URL(rawUrl)
  } catch {
    // A string that is not a URL is an invalid value, which every caller refuses.
    return null
  }
}

// WHATWG URL reports an empty search for a bare `?` and an empty hash for a bare
// `#`, so the raw string is checked as well.
function hasNoUserInfoQueryOrFragment(rawUrl, url) {
  return (
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    !rawUrl.includes('?') &&
    !rawUrl.includes('#')
  )
}

function parseDesktopLoginSignInUrl(rawUrl) {
  const url = parseBoundedUrl(rawUrl, MAX_DESKTOP_LOGIN_URL_LENGTH)
  if (
    !url ||
    url.protocol !== 'https:' ||
    !hasNoUserInfoQueryOrFragment(rawUrl, url) ||
    url.pathname !== DESKTOP_LOGIN_PATH
  ) {
    return null
  }
  return `${url.origin}${DESKTOP_LOGIN_PATH}`
}

// The environment is the edge's public base URL, which Desktop compares with
// the environment it started from. It is returned exactly as given.
function parseDesktopLoginEnvironment(rawUrl) {
  const url = parseBoundedUrl(rawUrl, MAX_DESKTOP_LOGIN_URL_LENGTH)
  if (
    !url ||
    !['http:', 'https:'].includes(url.protocol) ||
    !hasNoUserInfoQueryOrFragment(rawUrl, url)
  ) {
    return null
  }
  return rawUrl
}

// The one refusal-reason rule, for the builder and the parser alike: a listed
// reason stays a refusal; an unlisted or missing one means `failed`, with no
// reason.
function desktopLoginRefusal(reason) {
  return typeof reason === 'string' && DESKTOP_LOGIN_REFUSAL_REASONS.includes(reason)
    ? { error: 'refused', reason }
    : { error: 'failed' }
}

function buildDesktopLoginPageUrl(signInUrl, values) {
  const canonicalSignInUrl = parseDesktopLoginSignInUrl(signInUrl)
  const { challenge, state } = values || {}
  if (!canonicalSignInUrl || !isDesktopLoginValue(challenge) || !isDesktopLoginValue(state)) {
    throw new Error('Cannot create a Desktop sign-in page URL for these values')
  }
  return `${canonicalSignInUrl}#challenge=${challenge}&state=${state}`
}

function parseDesktopLoginFragment(hash) {
  if (typeof hash !== 'string') return { valid: false, state: null }
  const values = { challenge: [], state: [] }
  let unexpectedKey = false
  for (const pair of (hash.startsWith('#') ? hash.slice(1) : hash).split('&')) {
    const separator = pair.indexOf('=')
    const key = separator === -1 ? pair : pair.slice(0, separator)
    if (key === 'challenge' || key === 'state') {
      values[key].push(separator === -1 ? null : pair.slice(separator + 1))
    } else {
      unexpectedKey = true
    }
  }
  const state =
    values.state.length === 1 && isDesktopLoginValue(values.state[0]) ? values.state[0] : null
  const challenge =
    values.challenge.length === 1 && isDesktopLoginValue(values.challenge[0])
      ? values.challenge[0]
      : null
  if (unexpectedKey || state === null || challenge === null) return { valid: false, state }
  return { valid: true, challenge, state }
}

function parseDesktopLoginPageUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null
  const hashIndex = rawUrl.indexOf('#')
  if (hashIndex === -1) return null
  const signInUrl = parseDesktopLoginSignInUrl(rawUrl.slice(0, hashIndex))
  if (!signInUrl) return null
  const fragment = parseDesktopLoginFragment(rawUrl.slice(hashIndex))
  if (!fragment.valid) return null
  return { signInUrl, challenge: fragment.challenge, state: fragment.state }
}

function desktopLoginLink(entries) {
  return (
    `${SANDBOX_UI_DEEP_LINK_PROTOCOL}//${DESKTOP_LOGIN_DEEP_LINK_HOST}?` +
    new URLSearchParams(entries).toString()
  )
}

function buildDesktopLoginCodeLink(values) {
  const { state, code, environment } = values || {}
  if (
    !isDesktopLoginValue(state) ||
    !isDesktopLoginValue(code) ||
    parseDesktopLoginEnvironment(environment) === null
  ) {
    throw new Error('Cannot create a Desktop sign-in link for these values')
  }
  return desktopLoginLink([
    ['state', state],
    ['code', code],
    ['environment', environment],
  ])
}

function buildDesktopLoginErrorLink(values) {
  const { state, error, reason } = values || {}
  if (!isDesktopLoginValue(state) || !DESKTOP_LOGIN_ERRORS.includes(error)) {
    throw new Error('Cannot create a Desktop sign-in link for these values')
  }
  // A reason belongs only to a refusal; any other error's link carries none.
  const result = error === 'refused' ? desktopLoginRefusal(reason) : { error }
  return desktopLoginLink([['state', state], ...Object.entries(result)])
}

function parseDesktopLoginLink(rawUrl) {
  const url = parseBoundedUrl(rawUrl, MAX_DESKTOP_LOGIN_LINK_LENGTH)
  if (
    !url ||
    url.protocol !== SANDBOX_UI_DEEP_LINK_PROTOCOL ||
    url.hostname !== DESKTOP_LOGIN_DEEP_LINK_HOST ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '' ||
    url.hash ||
    rawUrl.includes('#')
  ) {
    return null
  }
  const params = new Map()
  for (const [key, value] of url.searchParams) {
    if (!DESKTOP_LOGIN_LINK_KEYS.has(key) || params.has(key)) return null
    params.set(key, value)
  }
  const state = params.get('state')
  if (!isDesktopLoginValue(state)) return null

  if (params.has('code') || params.has('environment')) {
    if (params.size !== 3 || !params.has('code') || !params.has('environment')) return null
    const code = params.get('code')
    const environment = parseDesktopLoginEnvironment(params.get('environment'))
    if (!isDesktopLoginValue(code) || environment === null) return null
    return { kind: 'code', state, code, environment }
  }

  const error = params.get('error')
  if (!DESKTOP_LOGIN_ERRORS.includes(error)) return null
  if (error !== 'refused') return params.size === 2 ? { kind: 'error', state, error } : null
  return { kind: 'error', state, ...desktopLoginRefusal(params.get('reason')) }
}

module.exports = {
  CLERUM_OAUTH_PROTOCOL,
  DESKTOP_LOGIN_DEEP_LINK_HOST,
  DESKTOP_LOGIN_ERRORS,
  DESKTOP_LOGIN_PATH,
  DESKTOP_LOGIN_REFUSAL_REASONS,
  GFS_RESOURCE_DEEP_LINK_HOST,
  GFS_RESOURCE_WEB_LINK_PATH,
  SANDBOX_UI_DEEP_LINK_HOST,
  SANDBOX_UI_DEEP_LINK_PROTOCOL,
  SANDBOX_UI_WEB_LINK_PATH,
  buildDesktopLoginCodeLink,
  buildDesktopLoginErrorLink,
  buildDesktopLoginPageUrl,
  buildSandboxUiDeepLink,
  buildSandboxUiWebLink,
  buildGfsResourceDeepLink,
  buildGfsResourceWebLink,
  normalizeSandboxUiRoute,
  normalizeGfsResourceUri,
  parseDesktopLoginFragment,
  parseDesktopLoginLink,
  parseDesktopLoginPageUrl,
  parseDesktopLoginSignInUrl,
  parseGfsResourceDeepLink,
  parseGfsResourceLink,
  parseSandboxUiDeepLink,
  sandboxUiDeepLinkTargetsEqual,
}
