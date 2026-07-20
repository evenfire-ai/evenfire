/**
 * Registry Phase 2.5 — evenfire imageRef ↔ entry-name identity check.
 *
 * For an evenfire-hosted (`registry.evenfire.ai`) local plugin, the realm
 * resolves the cross-org pull grant from the OCI path as
 * `callerHasGrant("@<org>/<name>")` (spec 2.2 / I5). So the imageRef's repo path
 * `<org>/<name>` MUST equal the entry's scoped name `@<org>/<name>`. A mismatch
 * means cross-org grant-pull is denied despite a valid grant, surfacing as a
 * silent ImagePullBackOff — we fail-fast at install/upgrade instead.
 */
import { imageRefHost, registryHostFromUrl } from './registryImagePullSecret.js'

/**
 * For an evenfire-hosted BARE image ref, return its repo path (`org/name`, with
 * the host prefix and any `:tag` / `@sha256:…` digest stripped). Returns null
 * when the ref is not hosted on the configured registry host (no check applies).
 */
export function evenfireImageRefRepoPath(image: unknown, registryUrl: string): string | null {
  if (typeof image !== 'string') return null
  const trimmed = image.trim()
  if (!trimmed) return null
  const registryHost = registryHostFromUrl(registryUrl)
  if (!registryHost || imageRefHost(trimmed) !== registryHost) return null
  const afterHost = trimmed.slice(trimmed.indexOf('/') + 1) // "org/name:tag" | "org/name@sha256:…"
  const noDigest = afterHost.split('@', 1)[0] ?? afterHost
  const lastSlash = noDigest.lastIndexOf('/')
  const lastColon = noDigest.lastIndexOf(':')
  return lastColon > lastSlash ? noDigest.slice(0, lastColon) : noDigest
}

export type ImageRefIdentityResult = { ok: true } | { ok: false; expected: string; actual: string }

/**
 * Verify an evenfire-hosted local plugin's imageRef repo path matches the entry's
 * scoped name (`@org/name`). Returns ok (no check) for: non-local entries,
 * non-evenfire images, and UNSCOPED entries (first-party/curator images live on
 * GCP-AR per spec I1, so an org path cannot be derived from a bare name).
 */
export function checkEvenfireImageRefMatchesEntry(params: {
  isLocal: boolean
  entryName: unknown
  image: unknown
  registryUrl: string
}): ImageRefIdentityResult {
  if (!params.isLocal) return { ok: true }
  const name = typeof params.entryName === 'string' ? params.entryName : ''
  if (!name.startsWith('@')) return { ok: true }
  const repoPath = evenfireImageRefRepoPath(params.image, params.registryUrl)
  if (repoPath === null) return { ok: true }
  const expected = name.slice(1)
  return repoPath === expected ? { ok: true } : { ok: false, expected, actual: repoPath }
}
