import { useCallback, useEffect, useState } from 'react'
import { GfsImagePreviewBody } from '@components/GfsImagePreview'
import { GfsMarkdownPreviewBody } from '@components/GfsMarkdownPreview'
import { GfsVideoPreviewBody } from '@components/GfsVideoPreview'
import { useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
import type { FilePreviewPageProps } from './FilePreviewPage.types'

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
 */
export function FilePreviewPage({
  gfsUri,
  fileName,
  fileKind,
  mimeType,
  byteLength,
}: FilePreviewPageProps) {
  const ctrl = useGfsBrowserController()
  const [reloadToken, setReloadToken] = useState(0)
  const accessRevoked = ctrl.accessState === 'revoked'

  // R-4: when the authority controller detects a revocation while this tab is
  // mounted, bump the reload token so the body re-fetches and fails closed
  // instead of leaving already-rendered bytes on screen.
  useEffect(() => {
    if (accessRevoked) setReloadToken(token => token + 1)
  }, [accessRevoked])

  const handleDownloadError = useCallback(
    (error: unknown) => {
      ctrl.handleAuthorityFailure(
        error instanceof Error ? error.message : String(error),
        'operation'
      )
    },
    [ctrl]
  )

  // Remounting the body on a reload bump discards any stale bytes and re-runs the
  // fetch from scratch — the simplest correct "re-dispatch the fetch" (§3.B.3).
  const bodyKey = `${gfsUri}:${reloadToken}`

  return (
    <section className="page">
      <div className="da-gfs-preview-page">
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
      </div>
    </section>
  )
}
