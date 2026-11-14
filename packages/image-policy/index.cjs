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

// Default allowlist when CONTROL_API_ALLOWED_IMAGE_PREFIXES /
// CONTEXT_MAPPER_ALLOWED_IMAGE_PREFIXES is unset: the vendor-neutral list that
// deploy/base ships for both variables, plus registry.evenfire.ai/, the shared
// Evenfire registry that hosts published plugin images
// (docs/how-to/publish-plugin-to-registry.md). deploy/base leaves it out, so a
// deployment that sets the variables chooses for itself. Deployments that pull
// from their own registry set the variables to their own prefixes.
// Prefixes match against the RAW image ref, so a Docker Hub image is listed in
// its short form (e.g. 'mongodb/'), which matches 'mongodb/x' but NOT the
// fully-qualified 'docker.io/mongodb/x' — add the docker.io/-qualified prefix
// too if an org publishes that form.
const DEFAULT_ALLOWED_PLUGIN_IMAGE_PREFIXES = Object.freeze([
  'ghcr.io/evenfire-ai/',
  'mongodb/',
  'mcr.microsoft.com/',
  'clerum/',
  'registry.evenfire.ai/',
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
