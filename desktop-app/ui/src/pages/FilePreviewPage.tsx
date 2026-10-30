import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, EmptyState, StatusBanner } from '@components/Common'
import { GfsImagePreviewBody } from '@components/GfsImagePreview'
import { GfsMarkdownPreviewBody } from '@components/GfsMarkdownPreview'
import { GfsResourceMenu } from '@components/GfsResourceMenu'
import { GfsResourceTitlebarActions } from '@components/GfsResourceTitlebarActions'
import { GfsVideoPreviewBody } from '@components/GfsVideoPreview'
import {
  desktopQueryKeys,
  isGfsSessionAuthorityCurrent,
  isGfsSessionGeneration,
} from '@hooks/domain/queryKeys'
import { useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
import { buildGfsResourceActions, getGfsMenuActions } from '@lib/gfsResourceActions'
import type { FilePreviewPageProps } from './FilePreviewPage.types'
import { useFilePreviewResourceActions } from './useFilePreviewResourceActions'

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
  sessionScope,
  isGfsPreviewSessionScopeCurrent,
  pushToast,
  onOpenRoute,
  pendingResourceAction,
  onPendingResourceActionHandled,
  onRenameCommitted,
  titlebarLeadingTarget,
}: FilePreviewPageProps) {
  const queryClient = useQueryClient()
  const ctrl = useGfsBrowserController()
  const [reloadToken, setReloadToken] = useState(0)
  const [denied, setDenied] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [copyContentReadyUri, setCopyContentReadyUri] = useState<string | null>(null)
  const copyContentRef = useRef<{ gfsUri: string; run: () => Promise<boolean> } | null>(null)
  const lastHandledResourceActionIdRef = useRef<number | null>(null)
  const accessRevoked = ctrl.accessState === 'revoked'
  const isCurrentGfsPreviewScope = useCallback(
    () =>
      !accessRevoked &&
      (sessionScope === undefined ||
        isGfsPreviewSessionScopeCurrent === undefined ||
        isGfsPreviewSessionScopeCurrent(sessionScope)),
    [accessRevoked, isGfsPreviewSessionScopeCurrent, sessionScope]
  )
  const pendingResourceActionRef = useRef(pendingResourceAction)
  pendingResourceActionRef.current =
    pendingResourceAction?.id === lastHandledResourceActionIdRef.current
      ? null
      : pendingResourceAction

  const liveAuthorityRef = useRef({
    sessionScope: ctrl.sessionScope,
    sessionGeneration: ctrl.sessionGeneration,
  })
  const refreshRequestRef = useRef(0)
  liveAuthorityRef.current = {
    sessionScope: ctrl.sessionScope,
    sessionGeneration: ctrl.sessionGeneration,
  }
  const capturedSessionScope = ctrl.sessionScope
  const capturedSessionGeneration = ctrl.sessionGeneration
  const handlePreviewAuthorityFailure = useCallback(
    (
      message: string,
      scope: string | null = capturedSessionScope,
      generation: number | null = capturedSessionGeneration
    ) => ctrl.handleAuthorityFailure(message, 'operation', scope, generation),
    [ctrl.handleAuthorityFailure, capturedSessionGeneration, capturedSessionScope]
  )

  const previewResourceActions = useFilePreviewResourceActions({
    gfsUri,
    fileName,
    sessionScope: ctrl.sessionScope,
    sessionGeneration: ctrl.sessionGeneration,
    principalScope: ctrl.principalScope,
    canResolve: !denied && !unavailable && !accessRevoked && !ctrl.authorityPending,
    onAuthorityFailure: handlePreviewAuthorityFailure,
    onDeleted: () => setDenied('The file was deleted.'),
    onRenameCommitted,
    pushToast,
  })

  useEffect(
    () => () => {
      const request = pendingResourceActionRef.current
      if (
        request &&
        request.id !== lastHandledResourceActionIdRef.current &&
        request.actionId === 'copy-content' &&
        request.targetUri === gfsUri
      ) {
        pendingResourceActionRef.current = null
        onPendingResourceActionHandled?.(request.id)
      }
    },
    [gfsUri, onPendingResourceActionHandled]
  )
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

  useEffect(() => {
    refreshRequestRef.current += 1
    setRefreshing(false)
  }, [capturedSessionGeneration, capturedSessionScope, gfsUri])

  const handleDownloadError = useCallback(
    (error: unknown) => {
      if (
        !isGfsSessionAuthorityCurrent(
          capturedSessionScope,
          capturedSessionGeneration,
          liveAuthorityRef.current.sessionScope,
          liveAuthorityRef.current.sessionGeneration
        )
      )
        return
      ctrl.handleAuthorityFailure(
        error,
        'operation',
        capturedSessionScope,
        capturedSessionGeneration
      )
    },
    [capturedSessionGeneration, capturedSessionScope, ctrl.handleAuthorityFailure]
  )

  const handleRefresh = useCallback(async () => {
    const scope = capturedSessionScope
    const generation = capturedSessionGeneration
    if (refreshing || denied || unavailable || accessRevoked || !isGfsSessionGeneration(generation))
      return
    const requestId = ++refreshRequestRef.current
    setRefreshing(true)
    try {
      await window.clerum.gfs.resolve(gfsUri)
      if (
        !isGfsSessionAuthorityCurrent(
          scope,
          generation,
          liveAuthorityRef.current.sessionScope,
          liveAuthorityRef.current.sessionGeneration
        )
      )
        return
      setDenied(null)
      setReloadToken(token => token + 1)
      pushToast?.('EvenDrive refreshed', 'success')
    } catch (error) {
      const message = toMessage(error)
      if (
        !isGfsSessionAuthorityCurrent(
          scope,
          generation,
          liveAuthorityRef.current.sessionScope,
          liveAuthorityRef.current.sessionGeneration
        )
      )
        return
      if (
        !ctrl.handleAuthorityFailure(error, 'operation', scope, generation) &&
        isPerResourceAccessDenial(message)
      ) {
        setDenied(message)
      }
      pushToast?.(`Could not refresh EvenDrive: ${message}`, 'error')
    } finally {
      if (
        refreshRequestRef.current === requestId &&
        isGfsSessionAuthorityCurrent(
          scope,
          generation,
          liveAuthorityRef.current.sessionScope,
          liveAuthorityRef.current.sessionGeneration
        )
      )
        setRefreshing(false)
    }
  }, [
    accessRevoked,
    capturedSessionGeneration,
    capturedSessionScope,
    ctrl,
    denied,
    gfsUri,
    pushToast,
    refreshing,
    unavailable,
  ])

  const handleCopyLink = useCallback(async () => {
    try {
      const result = await window.clerum.gfs.copyDeepLink?.(gfsUri)
      if (!result?.url) throw new Error('Shareable EvenDrive links are unavailable in this version')
      pushToast?.('Shareable EvenDrive link copied', 'success')
    } catch (error) {
      pushToast?.(`Could not copy the EvenDrive link: ${toMessage(error)}`, 'error')
    }
  }, [gfsUri, pushToast])

  const handleCopyRoute = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(gfsUri)
      pushToast?.('File ID copied', 'success')
    } catch (error) {
      pushToast?.(`Could not copy the file ID: ${toMessage(error)}`, 'error')
    }
  }, [gfsUri, pushToast])

  const handleCopyContent = useCallback(async () => {
    if (!isCurrentGfsPreviewScope()) return
    const copy = copyContentRef.current
    if (!copy || copy.gfsUri !== gfsUri) return
    const copied = await copy.run()
    if (!isCurrentGfsPreviewScope()) return
    pushToast?.(
      copied ? 'EvenDrive content copied' : 'Could not copy the EvenDrive content',
      copied ? 'success' : 'error'
    )
  }, [gfsUri, isCurrentGfsPreviewScope, pushToast])

  const handleCopyContentReady = useCallback(
    (copy: (() => Promise<boolean>) | null) => {
      if (!isCurrentGfsPreviewScope()) {
        copyContentRef.current = null
        setCopyContentReadyUri(null)
        return
      }
      if (copy) {
        copyContentRef.current = { gfsUri, run: copy }
        setCopyContentReadyUri(gfsUri)
        return
      }
      if (copyContentRef.current?.gfsUri === gfsUri) copyContentRef.current = null
      setCopyContentReadyUri(current => (current === gfsUri ? null : current))
    },
    [gfsUri, isCurrentGfsPreviewScope]
  )

  const copyContentReady = copyContentReadyUri === gfsUri && isCurrentGfsPreviewScope()

  const resourceActions = buildGfsResourceActions({
    kind: 'file',
    uri: gfsUri,
    handlers: {
      refresh: !denied && !unavailable && !accessRevoked ? () => void handleRefresh() : undefined,
      'copy-link': () => void handleCopyLink(),
      'copy-route': () => void handleCopyRoute(),
      'open-route': onOpenRoute,
      'copy-content':
        !denied &&
        !unavailable &&
        !accessRevoked &&
        copyContentReady &&
        (fileKind === 'image' || fileKind === 'markdown')
          ? () => void handleCopyContent()
          : undefined,
      ...previewResourceActions.handlers,
    },
    canShare: previewResourceActions.canShare,
    canRename: previewResourceActions.canRename,
    canMove: previewResourceActions.canMove,
    canDownload: previewResourceActions.canDownload,
    canDelete: previewResourceActions.canDelete,
    mutating: previewResourceActions.mutating,
    canCopyContent: copyContentReady,
    refreshing,
  })
  const menuResourceName = denied || unavailable || accessRevoked ? 'unavailable file' : fileName
  const fileActionsMenu = (
    <GfsResourceMenu actions={getGfsMenuActions(resourceActions)} resourceName={menuResourceName} />
  )

  useEffect(() => {
    const request = pendingResourceAction
    if (
      !request ||
      request.actionId !== 'copy-content' ||
      request.targetUri !== gfsUri ||
      lastHandledResourceActionIdRef.current === request.id
    ) {
      return
    }
    if (denied || unavailable || accessRevoked) {
      lastHandledResourceActionIdRef.current = request.id
      pendingResourceActionRef.current = null
      onPendingResourceActionHandled?.(request.id)
      pushToast?.('This file is no longer available for copying.', 'error')
      return
    }
    if (!copyContentReady || !isCurrentGfsPreviewScope()) return
    const action = resourceActions.find(candidate => candidate.id === request.actionId)
    if (!action || action.disabled) return
    lastHandledResourceActionIdRef.current = request.id
    pendingResourceActionRef.current = null
    onPendingResourceActionHandled?.(request.id)
    action.run(request.file)
  }, [
    accessRevoked,
    copyContentReady,
    denied,
    gfsUri,
    isCurrentGfsPreviewScope,
    onPendingResourceActionHandled,
    pendingResourceAction,
    pushToast,
    resourceActions,
    unavailable,
  ])

  const revalidateAccess = useCallback(async () => {
    if (denied || accessRevoked || !isCurrentGfsPreviewScope() || !isGfsSessionGeneration(ctrl.sessionGeneration)) return
    const capturedScope = ctrl.sessionScope
    const capturedGeneration = ctrl.sessionGeneration
    const resourceQueryKey = [
      ...desktopQueryKeys.gfsRoot,
      ctrl.sessionScope,
      'preview-resource',
      gfsUri,
      { sessionGeneration: ctrl.sessionGeneration },
    ] as const
    try {
      // Use the mounted resource query so React Query's own focus refetch and
      // this access check share one in-flight resolver request.
      await queryClient.refetchQueries(
        { queryKey: resourceQueryKey, exact: true },
        { throwOnError: true }
      )
      if (
        !isGfsSessionAuthorityCurrent(
          capturedScope,
          capturedGeneration,
          liveAuthorityRef.current.sessionScope,
          liveAuthorityRef.current.sessionGeneration
        )
      )
        return
    } catch (error) {
      const message = toMessage(error)
      if (
        !isGfsSessionAuthorityCurrent(
          capturedScope,
          capturedGeneration,
          liveAuthorityRef.current.sessionScope,
          liveAuthorityRef.current.sessionGeneration
        )
      )
        return
      // A session-authority failure revokes the shared session (H2 path); the
      // body then remounts and fails closed. A per-resource 403 is local to this
      // preview — drop its bytes here without touching the session.
      if (ctrl.handleAuthorityFailure(error, 'operation', capturedScope, capturedGeneration))
        return
      if (isPerResourceAccessDenial(message)) setDenied(message)
    }
  }, [
    accessRevoked,
    ctrl.handleAuthorityFailure,
    ctrl.sessionGeneration,
    ctrl.sessionScope,
    denied,
    gfsUri,
    queryClient,
    isCurrentGfsPreviewScope,
  ])

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
      <GfsResourceTitlebarActions
        target={titlebarLeadingTarget}
        onRefresh={
          !denied && !unavailable && !accessRevoked ? () => void handleRefresh() : undefined
        }
        refreshing={refreshing}
        onCopyLink={() => void handleCopyLink()}
        onOpenLink={onOpenRoute}
      />
      <div className="da-gfs-preview-page">
        {previewResourceActions.dialogs}
        {previewResourceActions.permissionNotices.map(notice => (
          <div key={notice.id} role={notice.pending ? 'status' : 'alert'}>
            <StatusBanner tone={notice.pending ? 'info' : 'error'} text={notice.message} />
            {!notice.pending ? (
              <Button
                onClick={() =>
                  void Promise.resolve()
                    .then(notice.retry)
                    .catch(() => undefined)
                }
                size="sm"
                variant="outline"
              >
                Retry permission check
              </Button>
            ) : null}
          </div>
        ))}
        <div className="da-gfs-preview-content">
          {denied || unavailable || accessRevoked ? (
            <>
              <div className="da-gfs-preview-unavailable-actions">{fileActionsMenu}</div>
              <EmptyState title="File unavailable" body="This item is no longer available." />
            </>
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
                  onCopyContentReady={handleCopyContentReady}
                  isScopeCurrent={isCurrentGfsPreviewScope}
                  titleActions={fileActionsMenu}
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
                  onCopyContentReady={handleCopyContentReady}
                  isScopeCurrent={isCurrentGfsPreviewScope}
                  titleActions={fileActionsMenu}
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
                  titleActions={fileActionsMenu}
                  headingLevel={2}
                />
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
