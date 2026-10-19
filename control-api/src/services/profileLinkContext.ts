import { normalizeProfileUiBaseUrl } from '@clerum/desktop-app-links'
import { config } from '../config.js'
import { memberRegistrationServiceRequest } from '../memberRegistrationServiceClient.js'
import { getMe } from './directory/membership.js'

const PROFILE_LINK_CONTEXT_REQUEST_TIMEOUT_MS = 1000
const PROFILE_LINK_ORIGIN_CACHE_TTL_MS = 5 * 60 * 1000
const PROFILE_LINK_ORIGIN_CACHE_MAX_ENTRIES = 512

type ProfileLinkOriginCacheEntry = { profileUiBaseUrl: string; expiresAt: number }

const profileLinkOriginCache = new Map<string, ProfileLinkOriginCacheEntry>()
const profileLinkOriginLookups = new Map<string, Promise<string | null>>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolves the activation Profile origin from the authenticated directory user.
 * Callers must pass only the verified user/team claims, never message content.
 */
export async function resolveProfileUiBaseUrlForUser(
  userId: string,
  teamId: string | null
): Promise<string | null> {
  const user = await getMe(userId, teamId ?? '')
  if (!user || user.id !== userId) return null

  const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : ''
  if (!email) return null

  const configuredProfileOrigin = normalizeProfileUiBaseUrl(config.desktopProfileUiBaseUrl)
  if (!configuredProfileOrigin) return null

  const callerDomain = new URL(configuredProfileOrigin).hostname
  // MRS normalizes `domain` by requiring a dotted DNS-style host. If this
  // value would normalize to null there (for example `localhost` or IPv6),
  // it would silently fall back to the newest external registration.
  if (!callerDomain.includes('.') || !/^[a-z0-9.-]+$/i.test(callerDomain)) return null

  const lookupKey = JSON.stringify([
    userId,
    teamId,
    email,
    configuredProfileOrigin,
    config.memberRegistrationServiceBaseUrl,
    config.memberRegistrationExternalHubBaseUrl,
    config.memberRegistrationMode,
  ])
  const now = Date.now()
  const cached = profileLinkOriginCache.get(lookupKey)
  if (cached && cached.expiresAt > now) return cached.profileUiBaseUrl
  if (cached) profileLinkOriginCache.delete(lookupKey)

  const activeLookup = profileLinkOriginLookups.get(lookupKey)
  if (activeLookup) return activeLookup

  let pendingLookup: Promise<string | null>
  pendingLookup = (async () => {
    const lookup = await memberRegistrationServiceRequest<unknown>(
      'POST',
      '/invitations-flow/profile',
      {
        destinationBaseUrl: config.desktopProfileUiBaseUrl,
        // MRS scopes external-only matches to this configured Profile domain.
        body: { email, domain: callerDomain },
        timeoutMs: PROFILE_LINK_CONTEXT_REQUEST_TIMEOUT_MS,
      }
    )
    if (!isRecord(lookup) || lookup.valid !== true) return null

    const returnedEmail = typeof lookup.email === 'string' ? lookup.email.trim().toLowerCase() : ''
    if (returnedEmail !== email) return null

    const returnedOrigin =
      typeof lookup.profileUiBaseUrl === 'string'
        ? normalizeProfileUiBaseUrl(lookup.profileUiBaseUrl)
        : null
    // MRS compares external registrations by hostname, which does not bind the
    // returned scheme or port. The deployment config is the trusted origin.
    if (returnedOrigin !== configuredProfileOrigin) return null

    for (const [key, entry] of profileLinkOriginCache) {
      if (entry.expiresAt <= Date.now()) profileLinkOriginCache.delete(key)
    }
    while (profileLinkOriginCache.size >= PROFILE_LINK_ORIGIN_CACHE_MAX_ENTRIES) {
      const oldestKey = profileLinkOriginCache.keys().next().value
      if (oldestKey === undefined) break
      profileLinkOriginCache.delete(oldestKey)
    }
    profileLinkOriginCache.set(lookupKey, {
      profileUiBaseUrl: configuredProfileOrigin,
      expiresAt: Date.now() + PROFILE_LINK_ORIGIN_CACHE_TTL_MS,
    })
    return configuredProfileOrigin
  })().finally(() => {
    if (profileLinkOriginLookups.get(lookupKey) === pendingLookup) {
      profileLinkOriginLookups.delete(lookupKey)
    }
  })
  profileLinkOriginLookups.set(lookupKey, pendingLookup)

  return pendingLookup
}
