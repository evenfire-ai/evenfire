// Platform image-pull identity — the SINGLE source of truth for "is this image hosted on
// our own registry, and therefore covered by the platform pull credential?", shared by
// every place that decides it: control-api (McpServer install/upgrade + recipe install)
// and the WRC reconciler (pod templates + McpServer delegation).
//
// This lives in @clerum/workflow-runtime-core, not copied per service, for the same reason
// the recipe/Secret ownership rule does (see secret-ownership.ts): two services answering
// the same question from two copies is exactly how they drift. Here the drift would be
// silent and ugly — WRC would decline to attach the pull secret to a workload whose image
// control-api considers ours, producing an ImagePullBackOff with no failing request to
// attribute it to.

/**
 * Name of the dockerconfigjson Secret carrying the platform registry pull credential.
 *
 * A cross-service contract: control-api WRITES it (one per platform workload namespace),
 * WRC and control-api REFERENCE it in `imagePullSecrets`, and HCC materializes that
 * reference verbatim onto the pod. Never inline the literal.
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
 * Parse the registry host of a BARE OCI image reference (no scheme). Splits on the first
 * `/`; the first component is a registry host only if it contains `.` or `:` (mirroring
 * Docker/OCI semantics, which distinguish a host from a docker-hub library/org path).
 * Returns null when the ref has no explicit host (docker-hub `org/name`, or a
 * single-segment `name[:tag]`).
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
 * True when `image` is hosted on the configured platform registry — i.e. the kubelet will
 * need the platform pull credential to fetch it.
 *
 * Deliberately keyed on the IMAGE host matching the configured registry host, because that
 * is what the kubelet matches on when selecting an entry from a dockerconfigjson `auths`
 * map. The registry's own token-issuer hostname is independent config and must never be
 * substituted here.
 *
 * Non-string images and an unset/unparseable `registryUrl` are false: with no registry
 * configured there is no platform credential to attach.
 */
export function isPlatformRegistryImage(image: unknown, registryUrl: string): boolean {
  if (typeof image !== 'string') return false
  const registryHost = registryHostFromUrl(registryUrl)
  if (!registryHost) return false
  return imageRefHost(image) === registryHost
}
