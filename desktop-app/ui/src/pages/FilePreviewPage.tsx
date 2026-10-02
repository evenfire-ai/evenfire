import { useCallback, useEffect, useState } from 'react'
import { EmptyState } from '@components/Common'
import { GfsImagePreviewBody } from '@components/GfsImagePreview'
import { GfsMarkdownPreviewBody } from '@components/GfsMarkdownPreview'
import { GfsVideoPreviewBody } from '@components/GfsVideoPreview'
import { useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
import type { FilePreviewPageProps } from './FilePreviewPage.types'

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A PER-RESOURCE read denial: the previewed file was unshared, so `gfs.resolve`
 * (and any download) now 403s for THIS resource while the session stays valid.
 * It is an operation-policy verdict — distinct from a session-authority failure
 * (401 / typed lifecycle code) which `handleAuthorityFailure` routes to the
 * shared session revoke. Keyed on the status the server emits (403 / forbidden)
 * so a transient network or 5xx failure never drops an otherwise-authorized
 * preview.
 */
function isPerResourceAccessDenial(message: string): boolean {
  const normalized = message.toLowerCase()
  return /(^|\D)403(\D|$)/.test(normalized) || normalized.includes('forbidden')
}

/**
 * A previewed GFS file living in its own workspace tab (spec 18 §3.B.3). Thin by
 * design: it mounts the `Gfs*PreviewBody` matching the tab's `fileKind` (each
 * body owns its own fetch + size-guard) and wires the fail-closed behavior.
 *
 * Reload hookpoint (§3.B.3): `reloadToken` is the single lever that re-fetches
 * the body (via a `key` bump → remount). The change watcher (spec 02) is
 * deferred, so it stays INERT with respect to file changes — but it is already
 * CONNECTED to the authority signal for the R-4 security requirement (§3.B.5):
 * this tab does NOT close when access is revoked; instead the authority
 * controller's revocation re-fetches the body, which then fails closed and
 * renders the reason (no stale content survives a revoke). The body's download
 * error is also routed back through the same controller so a revoke discovered
 * at fetch time fails the session closed exactly as the modal era did.
 *
 * Per-resource revalidation (R1-H6): a persistent preview tab outlives the grant
 * that opened it. The session-authority path above handles a 401, but a
 * per-RESOURCE unshare leaves the session valid, so nothing re-checked THIS file
 * while the tab stayed focused and its bytes (plus Copy) survived. On window
 * focus — the trigger the controller's own queries revalidate on — read authority
 * is re-checked with the cheap `gfs.resolve` primitive (gfsc authorizes `read`
 * before revealing any metadata, so an unshared resource 403s WITHOUT downloading
 * its bytes). A per-resource 403 unmounts the body (its cleanup revokes the object
 * URL) and renders the denial reason; a session-authority failure still routes to
 * the shared revoke, never to this local `denied` state.
 */
export function FilePreviewPage({
  gfsUri,
  fileName,
  fileKind,
  mimeType,
  byteLength,
  reloadVersion,
  unavailable = false,
}: FilePreviewPageProps) {
  const ctrl = useGfsBrowserController()
  const [reloadToken, setReloadToken] = useState(0)
  const [denied, setDenied] = useState<string | null>(null)
  const accessRevoked = ctrl.accessState === 'revoked'

  // Each previewed resource starts from a clean per-resource verdict.
  useEffect(() => {
    setDenied(null)
  }, [gfsUri])

  useEffect(() => {
    if (unavailable) setDenied(null)
  }, [unavailable])

  // R-4: when the authority controller detects a revocation while this tab is
  // mounted, bump the reload token so the body re-fetches and fails closed
  // instead of leaving already-rendered bytes on screen.
  useEffect(() => {
    if (accessRevoked) setReloadToken(token => token + 1)
  }, [accessRevoked])

  const handleDownloadError = useCallback(
    (error: unknown) => {
      ctrl.handleAuthorityFailure(toMessage(error), 'operation')
    },
    [ctrl]
  )

  const revalidateAccess = useCallback(async () => {
    if (denied || accessRevoked) return
    try {
      await window.clerum.gfs.resolve(gfsUri)
    } catch (error) {
      const message = toMessage(error)
      // A session-authority failure revokes the shared session (H2 path); the
      // body then remounts and fails closed. A per-resource 403 is local to this
      // preview — drop its bytes here without touching the session.
      if (ctrl.handleAuthorityFailure(message, 'operation')) return
      if (isPerResourceAccessDenial(message)) setDenied(message)
    }
  }, [accessRevoked, ctrl, denied, gfsUri])

  useEffect(() => {
    const onFocus = () => {
      void revalidateAccess()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [revalidateAccess])

  // Remounting the body on a reload bump discards any stale bytes and re-runs the
  // fetch from scratch — the simplest correct "re-dispatch the fetch" (§3.B.3).
  const bodyKey = `${gfsUri}:${reloadToken}:${reloadVersion ?? 0}`

  return (
    <section className="page">
      <div className="da-gfs-preview-page">
        {denied || unavailable || accessRevoked ? (
          <EmptyState title="File unavailable" body="This item is no longer available." />
        ) : (
          <>
            {fileKind === 'image' ? (
              <GfsImagePreviewBody
                key={bodyKey}
                byteLength={byteLength}
                fileName={fileName}
                gfsUri={gfsUri}
                mimeType={mimeType ?? ''}
                onDownloadError={handleDownloadError}
                headingLevel={2}
              />
            ) : null}
            {fileKind === 'markdown' ? (
              <GfsMarkdownPreviewBody
                key={bodyKey}
                byteLength={byteLength}
                fileName={fileName}
                gfsUri={gfsUri}
                onDownloadError={handleDownloadError}
                headingLevel={2}
              />
            ) : null}
            {fileKind === 'video' ? (
              <GfsVideoPreviewBody
                key={bodyKey}
                byteLength={byteLength}
                fileName={fileName}
                gfsUri={gfsUri}
                mimeType={mimeType ?? ''}
                onDownloadError={handleDownloadError}
                headingLevel={2}
              />
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}
