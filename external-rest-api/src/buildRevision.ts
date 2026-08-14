// The commit this image was built from.
//
// Mid-cycle there is no single platform version to report: releaseId and
// desktopVersion are frozen at the last cut (see
// scripts/release/release-coordinates.mjs), and build-publish.yml only rebuilds
// the services whose paths changed, so a dev cluster is a mosaic of per-image
// builds. The one honest answer is per-image, which is what this is.
//
// build-publish.yml bakes the full github.sha in as BUILD_REVISION, the same
// value it already stamps as the org.opencontainers.image.revision label. The
// short form served to clients is the same 7 characters that name the image tag
// (`sha-<7>`), so what the API reports can be matched against what the cluster
// actually pulled.
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i
const SHORT_LENGTH = 7

export function normalizeBuildRevision(raw: string | undefined | null): string {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  // Non-sha values (a local build stamping "dev", a hand-set marker) pass
  // through untouched rather than being silently truncated to 7 characters.
  if (!SHA_PATTERN.test(value)) return value
  return value.slice(0, SHORT_LENGTH).toLowerCase()
}
