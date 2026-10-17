import { normalizeGfsResourceUri, parseGfsResourceDeepLink } from '@clerum/desktop-app-links'

/** Accept only a canonical HTTP(S) origin returned by the trusted Desktop main process. */
export function normalizeProfileOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const apiUrl = new URL(value)
    if (!['http:', 'https:'].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password) {
      return null
    }
    if (apiUrl.pathname !== '/' || apiUrl.search || apiUrl.hash || apiUrl.origin !== value) {
      return null
    }
    return apiUrl.origin
  } catch {
    return null
  }
}

function parseConfiguredProfileLink(rawUrl: string, profileOrigin: string | null): string | null {
  if (!profileOrigin) return null
  try {
    const normalizedOrigin = normalizeProfileOrigin(profileOrigin)
    if (!normalizedOrigin) return null
    const trustedOrigin = new URL(normalizedOrigin)
    const url = new URL(rawUrl)
    if (
      !['http:', 'https:'].includes(trustedOrigin.protocol) ||
      url.origin !== trustedOrigin.origin ||
      url.pathname !== '/open/files' ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].some(key => key !== 'uri') ||
      url.searchParams.getAll('uri').length !== 1
    ) {
      return null
    }
    return normalizeGfsResourceUri(url.searchParams.get('uri') ?? '')
  } catch {
    return null
  }
}

/** Accept an exact canonical URI or one of the two supported GFS link forms. */
export function parseGfsResourceLink(
  rawValue: string,
  profileOrigin: string | null = null
): string | null {
  const value = rawValue.trim()
  const canonicalUri = normalizeGfsResourceUri(value)
  if (canonicalUri) return canonicalUri
  const desktopLink = parseGfsResourceDeepLink(value)
  if (desktopLink) return desktopLink.uri
  return parseConfiguredProfileLink(value, profileOrigin)
}
