'use strict'

const SHA256_IMAGE_DIGEST_RE = /@sha256:[a-f0-9]{64}$/

function hasLatestTag(image) {
  const ref = image.split('@', 1)[0] ?? image
  const lastSlash = ref.lastIndexOf('/')
  const lastColon = ref.lastIndexOf(':')
  return lastColon > lastSlash && ref.slice(lastColon + 1).toLowerCase() === 'latest'
}

function hasInvalidDigest(image) {
  const digestStart = image.lastIndexOf('@')
  if (digestStart < 0) return false
  return !SHA256_IMAGE_DIGEST_RE.test(image)
}

function hasValidSha256Digest(image) {
  return SHA256_IMAGE_DIGEST_RE.test(image)
}

function hasUnsafeImageReferenceSyntax(image) {
  if (/\s/.test(image)) return true
  const [namePart] = image.split('@', 1)
  return namePart.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
}

function matchesAllowedImagePrefix(image, rawPrefix) {
  const prefix = rawPrefix.trim()
  if (!prefix || !image.startsWith(prefix)) return false

  const next = image.charAt(prefix.length)
  if (!next) return true
  if (prefix.endsWith('/') || prefix.endsWith(':') || prefix.endsWith('@')) return true
  return next === '/' || next === ':' || next === '@'
}

// Permissive audit-mode default: current fleet hosts + example.com.
// This is the CODE FALLBACK used only when the env var is unset. It is NOT
// kept in sync with deploy/base: deploy/base is environment-generic and
// ships only the vendor-neutral subset of this list
// (ghcr.io/evenfire-ai/,mongodb/,mcr.microsoft.com/,clerum/) via
// CONTROL_API_/CONTEXT_MAPPER_ALLOWED_IMAGE_PREFIXES, since the base tree is
// shared across clusters and must not hardcode any one fleet's identity. The
// private gcp-dev/gcp-prod overlays each patch that env var to the real,
// fleet-specific Artifact Registry + example.com prefixes below —
// those overlay values are the effective ones in prod. This constant is only
// the safety-net default for local/dev-mode runs where the env var is unset.
// Prefixes match against the RAW image ref, so a Docker Hub image is listed in
// its short form (e.g. 'mongodb/'), which matches 'mongodb/x' but NOT the
// fully-qualified 'docker.io/mongodb/x' — add the docker.io/-qualified prefix
// too if an org publishes that form.
const DEFAULT_ALLOWED_PLUGIN_IMAGE_PREFIXES = Object.freeze([
  'us-central1-docker.pkg.dev/your-gcp-project/clerum/',
  'example.com/',
  'mongodb/',
  'mcr.microsoft.com/',
  'clerum/',
])

/**
 * Classify a local-mode plugin image against a trusted prefix allowlist.
 * rejectLatest is OFF by default (Phase 2.3 A5 — deferred until first-party re-pin).
 */
function classifyPluginImage(image, options) {
  const opts = options || {}
  const allowedPrefixes = Array.isArray(opts.allowedPrefixes) ? opts.allowedPrefixes : []
  const rejectLatest = opts.rejectLatest === true
  const value = typeof image === 'string' ? image.trim() : ''
  if (!value) return { ok: false, reason: 'empty' }
  if (hasUnsafeImageReferenceSyntax(value)) return { ok: false, reason: 'unsafe_syntax' }
  if (rejectLatest && hasLatestTag(value)) return { ok: false, reason: 'latest_tag' }
  if (!allowedPrefixes.some(prefix => matchesAllowedImagePrefix(value, prefix))) {
    return { ok: false, reason: 'host_not_allowed' }
  }
  return { ok: true }
}

module.exports = {
  SHA256_IMAGE_DIGEST_RE,
  hasLatestTag,
  hasInvalidDigest,
  hasValidSha256Digest,
  hasUnsafeImageReferenceSyntax,
  matchesAllowedImagePrefix,
  DEFAULT_ALLOWED_PLUGIN_IMAGE_PREFIXES,
  classifyPluginImage,
}
