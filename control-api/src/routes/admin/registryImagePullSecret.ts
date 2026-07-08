/**
 * Registry Phase 2.4-delivery — evenfire pull-secret attach classification.
 *
 * Pure, dependency-free helpers deciding whether an installed local-mode
 * McpServer image should carry the `evenfire-registry-pull` imagePullSecret.
 * The secret is provisioned onto the tenant cluster by MCC (out of this repo);
 * control-api only references it by name when the image lives on the configured
 * evenfire registry host.
 */

/**
 * Name of the dockerconfigjson Secret MCC provisions in the tenant plugin
 * namespace. Must stay in sync with the MCC install step. Never inline.
 */
export const EVENFIRE_REGISTRY_PULL_SECRET_NAME = 'evenfire-registry-pull'

/**
 * Extract the host (including any :port) from the configured registry URL.
 * The registry URL always carries a scheme, so `new URL()` is correct here.
 * Returns null when unset/whitespace/unparseable.
 */
export function registryHostFromUrl(registryUrl: string): string | null {
  if (!registryUrl || !registryUrl.trim()) return null
  try {
    return new URL(registryUrl).host || null
  } catch {
    return null
  }
}

/**
 * Parse the registry host of a BARE OCI image reference (no scheme). Splits on
 * the first `/`; the first component is a registry host only if it contains
 * `.` or `:` (mirrors Docker/OCI semantics that distinguish a host from a
 * docker-hub library/org path). Returns null when the ref has no explicit host
 * (docker-hub `org/name` or a single-segment `name[:tag]`).
 */
export function imageRefHost(image: string): string | null {
  const trimmed = (image ?? '').trim()
  if (!trimmed) return null
  const slash = trimmed.indexOf('/')
  if (slash === -1) return null
  const first = trimmed.slice(0, slash)
  return first.includes('.') || first.includes(':') ? first : null
}

/**
 * True when a built McpServer spec should carry the evenfire pull secret:
 * a local-mode entry whose image host equals the configured registry host.
 */
export function shouldAttachEvenfirePullSecret(params: {
  isLocal: boolean
  image: unknown
  registryUrl: string
}): boolean {
  if (!params.isLocal) return false
  if (typeof params.image !== 'string') return false
  const registryHost = registryHostFromUrl(params.registryUrl)
  if (!registryHost) return false
  return imageRefHost(params.image) === registryHost
}
