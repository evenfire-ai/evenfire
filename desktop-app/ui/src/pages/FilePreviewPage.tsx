import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, EmptyState, StatusBanner } from '@components/Common'
import { GfsImagePreviewBody } from '@components/GfsImagePreview'
import { GfsMarkdownPreviewBody } from '@components/GfsMarkdownPreview'
import { GfsMarkdownEditor } from '@components/GfsMarkdownPreview/MarkdownAdapter'
import { GfsResourceMenu } from '@components/GfsResourceMenu'
import { GfsResourceTitlebarActions } from '@components/GfsResourceTitlebarActions'
import { GfsVideoPreviewBody } from '@components/GfsVideoPreview'
import {
  desktopQueryKeys,
  isGfsSessionAuthorityCurrent,
  isGfsSessionGeneration,
} from '@hooks/domain/queryKeys'
import { useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
import { httpErrorStatus } from '@lib/format'
import { buildGfsResourceActions, getGfsMenuActions } from '@lib/gfsResourceActions'
import { MARKDOWN_DRAFT_MAX_BYTES } from '@lib/markdownDraftOwner'
import type { MarkdownDraftBinding, MarkdownDraftOwner } from '@lib/markdownDraftOwner'
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

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
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
  pushToast,
  onOpenRoute,
  onRenameCommitted,
  pendingResourceAction,
  onPendingResourceActionHandled,
  titlebarLeadingTarget,
  markdownDraftOwner,
  markdownPrincipalOwner,
  tabId,
}: FilePreviewPageProps) {
  const queryClient = useQueryClient()
  const ctrl = useGfsBrowserController()
  const [reloadToken, setReloadToken] = useState(0)
  const [denied, setDenied] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [copyContentReady, setCopyContentReady] = useState(false)
  const [draftRecord, setDraftRecord] = useState<ReturnType<MarkdownDraftOwner['get']>>(null)
  const [scopeTransitionPending, setScopeTransitionPending] = useState(false)
  const copyContentRef = useRef<(() => Promise<boolean>) | null>(null)
  const lastHandledResourceActionIdRef = useRef<number | null>(null)
  const discardAfterReadBindingRef = useRef<MarkdownDraftBinding | null>(null)
  const lastCapabilityScopeRef = useRef<{ key: string; generation: number } | null>(null)
  const accessRevoked = ctrl.accessState === 'revoked'
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
  const markdownEligible = fileKind === 'markdown' && /\.(?:md|markdown)$/i.test(fileName)
  const draftBinding: MarkdownDraftBinding | null =
    markdownDraftOwner &&
    tabId &&
    (markdownPrincipalOwner || ctrl.principalScope) &&
    ctrl.sessionScope
      ? {
          principalOwner: markdownPrincipalOwner || ctrl.principalScope!,
          scopeKey: ctrl.sessionScope,
          tabId,
          gfsUri,
        }
      : null
  const liveResourceUriRef = useRef(gfsUri)
  liveResourceUriRef.current = gfsUri
  const liveBindingRef = useRef(draftBinding)
  liveBindingRef.current = draftBinding
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useEffect(() => {
    if (!markdownDraftOwner || !draftBinding) {
      setDraftRecord(null)
      return
    }
    const refresh = () => {
      setDraftRecord(
        markdownDraftOwner.getVisibleRecord(draftBinding) ?? markdownDraftOwner.get(draftBinding)
      )
      setScopeTransitionPending(markdownDraftOwner.hasPendingTransition())
    }
    const unsubscribe = markdownDraftOwner.subscribe(refresh)
    markdownDraftOwner.setActiveScope(
      draftBinding.principalOwner,
      draftBinding.scopeKey,
      capturedSessionGeneration
    )
    markdownDraftOwner.open(draftBinding, { sessionGeneration: capturedSessionGeneration })
    refresh()
    return unsubscribe
  }, [
    capturedSessionGeneration,
    draftBinding?.gfsUri,
    draftBinding?.principalOwner,
    draftBinding?.scopeKey,
    draftBinding?.tabId,
    markdownDraftOwner,
  ])
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

  useEffect(() => {
    if (!markdownDraftOwner || !draftBinding || previewResourceActions.resourceVersion === null)
      return
    markdownDraftOwner.observeVersion(draftBinding, previewResourceActions.resourceVersion)
  }, [
    draftBinding?.gfsUri,
    draftBinding?.principalOwner,
    draftBinding?.scopeKey,
    draftBinding?.tabId,
    markdownDraftOwner,
    previewResourceActions.resourceVersion,
  ])

  useEffect(() => {
    if (!markdownDraftOwner || !draftBinding) return
    const token = markdownDraftOwner.beginCapabilityRefresh(draftBinding)
    if (token) markdownDraftOwner.completeCapabilityRefresh(token, previewResourceActions.canWrite)
  }, [
    draftBinding?.gfsUri,
    draftBinding?.principalOwner,
    draftBinding?.scopeKey,
    draftBinding?.tabId,
    markdownDraftOwner,
    previewResourceActions.canWrite,
  ])

  useEffect(() => {
    if (!markdownEligible || !markdownDraftOwner || !draftBinding || !draftRecord) return
    const key = `${draftBinding.principalOwner}\u0000${draftBinding.scopeKey}\u0000${draftBinding.tabId}\u0000${draftBinding.gfsUri}`
    const previous = lastCapabilityScopeRef.current
    lastCapabilityScopeRef.current = { key, generation: draftRecord.scopeGeneration }
    if (
      !previous ||
      previous.key !== key ||
      previous.generation === draftRecord.scopeGeneration ||
      draftRecord.capability !== 'unknown'
    )
      return

    const token = markdownDraftOwner.beginCapabilityRefresh(draftBinding)
    if (!token) return
    void previewResourceActions.revalidateWriteCapability().then(allowed => {
      markdownDraftOwner.completeCapabilityRefresh(token, allowed)
    })
  }, [
    draftBinding?.gfsUri,
    draftBinding?.principalOwner,
    draftBinding?.scopeKey,
    draftBinding?.tabId,
    draftRecord?.capability,
    draftRecord?.scopeGeneration,
    markdownEligible,
    markdownDraftOwner,
    previewResourceActions.revalidateWriteCapability,
  ])

  const handleMarkdownSourceLoaded = useCallback(
    (content: string, version: number) => {
      if (!markdownDraftOwner || !draftBinding) return
      markdownDraftOwner.open(draftBinding, {
        savedSnapshot: { content, version },
        sessionGeneration: capturedSessionGeneration,
      })
      const token = markdownDraftOwner.beginStableRead(draftBinding)
      if (token) markdownDraftOwner.completeStableRead(token, { content, version, stable: true })
      const pendingDiscard = discardAfterReadBindingRef.current
      if (
        pendingDiscard &&
        pendingDiscard.principalOwner === draftBinding.principalOwner &&
        pendingDiscard.scopeKey === draftBinding.scopeKey &&
        pendingDiscard.tabId === draftBinding.tabId &&
        pendingDiscard.gfsUri === draftBinding.gfsUri
      ) {
        discardAfterReadBindingRef.current = null
        markdownDraftOwner.discard(draftBinding)
      }
    },
    [
      capturedSessionGeneration,
      draftBinding?.gfsUri,
      draftBinding?.principalOwner,
      draftBinding?.scopeKey,
      draftBinding?.tabId,
      markdownDraftOwner,
    ]
  )

  useEffect(() => {
    const candidate = draftRecord?.viewCandidate
    if (!candidate || !markdownDraftOwner || !draftBinding) return
    markdownDraftOwner.commitSaveView(candidate.requestId, draftBinding)
  }, [
    draftBinding?.gfsUri,
    draftBinding?.principalOwner,
    draftBinding?.scopeKey,
    draftBinding?.tabId,
    draftRecord?.readReady,
    draftRecord?.readPending,
    draftRecord?.viewCandidate?.requestId,
    markdownDraftOwner,
  ])

  const handleEditMarkdown = useCallback(() => {
    if (
      !markdownDraftOwner ||
      !draftBinding ||
      !markdownEligible ||
      !previewResourceActions.canWrite ||
      byteLength > MARKDOWN_DRAFT_MAX_BYTES
    )
      return
    markdownDraftOwner.beginEdit(draftBinding)
  }, [
    byteLength,
    draftBinding?.gfsUri,
    draftBinding?.principalOwner,
    draftBinding?.scopeKey,
    draftBinding?.tabId,
    markdownDraftOwner,
    markdownEligible,
    previewResourceActions.canWrite,
  ])

  const handleSaveMarkdown = useCallback(async () => {
    if (!markdownDraftOwner || !draftBinding || !draftRecord) return
    const request = markdownDraftOwner.reserveSave(draftBinding)
    if (!request) return
    try {
      const requestGeneration = request.expectedSessionGeneration ?? undefined
      const resource = await window.clerum.gfs.resolve(gfsUri, requestGeneration)
      const encoded = encodeUtf8Base64(request.submitted)
      const saved = await window.clerum.gfs.replaceFile(
        resource.resourceId,
        encoded,
        resource.drive,
        undefined,
        requestGeneration
      )
      markdownDraftOwner.completeSave(request, { kind: 'success', version: saved.version })
      if (
        mountedRef.current &&
        liveResourceUriRef.current === request.binding.gfsUri &&
        liveAuthorityRef.current.sessionGeneration === requestGeneration &&
        liveBindingRef.current?.principalOwner === request.binding.principalOwner &&
        liveBindingRef.current?.scopeKey === request.binding.scopeKey &&
        liveBindingRef.current?.tabId === request.binding.tabId
      ) {
        setReloadToken(value => value + 1)
        pushToast?.('Markdown saved', 'success')
      }
    } catch (error) {
      const status = httpErrorStatus(error)
      const kind =
        status && status >= 400 && status < 500 && status !== 408 ? 'failure' : 'ambiguous'
      markdownDraftOwner.completeSave(request, { kind })
      if (status === 401) {
        ctrl.handleAuthorityFailure(
          toMessage(error),
          'operation',
          capturedSessionScope,
          request.expectedSessionGeneration
        )
      } else if (status === 403) {
        const capability = markdownDraftOwner.beginCapabilityRefresh(request.binding)
        if (capability) markdownDraftOwner.completeCapabilityRefresh(capability, false)
      }
      if (
        mountedRef.current &&
        liveResourceUriRef.current === request.binding.gfsUri &&
        liveAuthorityRef.current.sessionGeneration === request.expectedSessionGeneration &&
        liveBindingRef.current?.principalOwner === request.binding.principalOwner &&
        liveBindingRef.current?.scopeKey === request.binding.scopeKey &&
        liveBindingRef.current?.tabId === request.binding.tabId
      ) {
        pushToast?.(
          kind === 'ambiguous'
            ? 'Save outcome is unknown. Your draft is retained; review it before saving again.'
            : `Could not save Markdown: ${toMessage(error)}`,
          'error'
        )
      }
    }
  }, [
    capturedSessionGeneration,
    capturedSessionScope,
    ctrl.handleAuthorityFailure,
    draftBinding?.gfsUri,
    draftBinding?.principalOwner,
    draftBinding?.scopeKey,
    draftBinding?.tabId,
    draftRecord,
    gfsUri,
    markdownDraftOwner,
    pushToast,
  ])

  const handleDiscardMarkdown = useCallback(() => {
    if (!markdownDraftOwner || !draftBinding) return
    const current = markdownDraftOwner.get(draftBinding)
    if (!current || current.pendingSave) return
    if (
      current.lastSaveOutcome === 'ambiguous' ||
      (current.savedSnapshot && current.observedVersion > current.savedSnapshot.version)
    ) {
      discardAfterReadBindingRef.current = draftBinding
      setReloadToken(value => value + 1)
      return
    }
    markdownDraftOwner.discard(draftBinding)
  }, [
    draftBinding?.gfsUri,
    draftBinding?.principalOwner,
    draftBinding?.scopeKey,
    draftBinding?.tabId,
    markdownDraftOwner,
  ])

  const visibleDraftRecord =
    draftRecord &&
    draftBinding &&
    draftRecord.binding.principalOwner === draftBinding.principalOwner &&
    draftRecord.binding.scopeKey === draftBinding.scopeKey &&
    draftRecord.binding.tabId === draftBinding.tabId &&
    draftRecord.binding.gfsUri === draftBinding.gfsUri
      ? draftRecord
      : null
  const editingMarkdown = Boolean(visibleDraftRecord?.editing)
  const editAvailable = Boolean(
    markdownEligible &&
    byteLength <= MARKDOWN_DRAFT_MAX_BYTES &&
    previewResourceActions.canWrite &&
    visibleDraftRecord?.readReady &&
    !visibleDraftRecord.readPending &&
    Boolean(visibleDraftRecord.savedSnapshot) &&
    visibleDraftRecord.observedVersion <= (visibleDraftRecord.savedSnapshot?.version ?? -1) &&
    visibleDraftRecord.capability === 'positive' &&
    !visibleDraftRecord.capabilityPending &&
    !visibleDraftRecord.sizeExceeded
  )
  const headerActions =
    editingMarkdown && visibleDraftRecord ? (
      <div className="da-gfs-markdown-edit-actions">
        <Button
          disabled={Boolean(visibleDraftRecord.pendingSave)}
          onClick={handleDiscardMarkdown}
          size="sm"
          variant="outline"
        >
          Discard
        </Button>
        <Button
          disabled={
            !visibleDraftRecord.dirty ||
            visibleDraftRecord.sizeExceeded ||
            Boolean(visibleDraftRecord.pendingSave)
          }
          loading={Boolean(visibleDraftRecord.pendingSave)}
          onClick={() => void handleSaveMarkdown()}
          size="sm"
        >
          Save
        </Button>
      </div>
    ) : null
  const markdownEditor =
    editingMarkdown && visibleDraftRecord ? (
      <>
        {visibleDraftRecord.sizeExceeded ? (
          <div className="da-gfs-markdown-size-warning" role="status">
            Markdown files can be up to 2 MiB. Shorten this draft before saving. Your current text
            is preserved.
          </div>
        ) : null}
        <GfsMarkdownEditor
          ariaLabel={`Edit Markdown source for ${fileName}`}
          onChange={value => {
            if (draftBinding) markdownDraftOwner?.type(draftBinding, value)
          }}
          value={visibleDraftRecord.draft}
        />
      </>
    ) : null

  // Each previewed resource starts from a clean per-resource verdict.
  useEffect(() => {
    setDenied(null)
  }, [capturedSessionGeneration, capturedSessionScope, ctrl.principalScope, gfsUri])

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
      if (liveResourceUriRef.current !== gfsUri) return
      if (
        !isGfsSessionAuthorityCurrent(
          capturedSessionScope,
          capturedSessionGeneration,
          liveAuthorityRef.current.sessionScope,
          liveAuthorityRef.current.sessionGeneration
        )
      )
        return
      const pendingDiscard = discardAfterReadBindingRef.current
      if (
        pendingDiscard &&
        pendingDiscard.principalOwner === draftBinding?.principalOwner &&
        pendingDiscard.scopeKey === draftBinding?.scopeKey &&
        pendingDiscard.tabId === draftBinding?.tabId &&
        pendingDiscard.gfsUri === gfsUri
      ) {
        discardAfterReadBindingRef.current = null
        if (draftBinding) markdownDraftOwner?.discard(draftBinding)
      }
      ctrl.handleAuthorityFailure(
        toMessage(error),
        'operation',
        capturedSessionScope,
        capturedSessionGeneration
      )
    },
    [
      capturedSessionGeneration,
      capturedSessionScope,
      ctrl.handleAuthorityFailure,
      draftBinding?.gfsUri,
      draftBinding?.principalOwner,
      draftBinding?.scopeKey,
      draftBinding?.tabId,
      gfsUri,
      markdownDraftOwner,
    ]
  )

  const handleRefresh = useCallback(async () => {
    const scope = capturedSessionScope
    const generation = capturedSessionGeneration
    if (refreshing || denied || unavailable || accessRevoked || !isGfsSessionGeneration(generation))
      return
    const requestId = ++refreshRequestRef.current
    setRefreshing(true)
    try {
      await window.clerum.gfs.resolve(gfsUri, generation ?? undefined)
      if (
        liveResourceUriRef.current !== gfsUri ||
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
        liveResourceUriRef.current !== gfsUri ||
        !isGfsSessionAuthorityCurrent(
          scope,
          generation,
          liveAuthorityRef.current.sessionScope,
          liveAuthorityRef.current.sessionGeneration
        )
      )
        return
      if (
        !ctrl.handleAuthorityFailure(message, 'operation', scope, generation) &&
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
    const copy = copyContentRef.current
    if (!copy) return
    const copied = await copy()
    pushToast?.(
      copied ? 'EvenDrive content copied' : 'Could not copy the EvenDrive content',
      copied ? 'success' : 'error'
    )
  }, [pushToast])

  const handleCopyContentReady = useCallback((copy: (() => Promise<boolean>) | null) => {
    copyContentRef.current = copy
    setCopyContentReady(Boolean(copy))
  }, [])

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
        (fileKind === 'image' || fileKind === 'markdown')
          ? () => void handleCopyContent()
          : undefined,
      'edit-markdown': editAvailable ? handleEditMarkdown : undefined,
      ...previewResourceActions.handlers,
    },
    canShare: previewResourceActions.canShare,
    canRename: previewResourceActions.canRename,
    canMove: previewResourceActions.canMove,
    canDownload: previewResourceActions.canDownload,
    canDelete: previewResourceActions.canDelete,
    mutating: previewResourceActions.mutating,
    canCopyContent: copyContentReady,
    canEditMarkdown: editAvailable,
    refreshing,
  })
  const menuResourceName = denied || unavailable || accessRevoked ? 'unavailable file' : fileName
  const fileActionsMenu = (
    <GfsResourceMenu actions={getGfsMenuActions(resourceActions)} resourceName={menuResourceName} />
  )
  const markdownActions = editingMarkdown ? headerActions : fileActionsMenu

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
      onPendingResourceActionHandled?.(request.id)
      return
    }
    if (!copyContentReady) return
    const action = resourceActions.find(candidate => candidate.id === request.actionId)
    if (!action || action.disabled) return
    lastHandledResourceActionIdRef.current = request.id
    action.run()
    onPendingResourceActionHandled?.(request.id)
  }, [
    accessRevoked,
    copyContentReady,
    denied,
    gfsUri,
    onPendingResourceActionHandled,
    pendingResourceAction,
    resourceActions,
    unavailable,
  ])

  const revalidateAccess = useCallback(async () => {
    if (denied || accessRevoked || !isGfsSessionGeneration(ctrl.sessionGeneration)) return
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
        liveResourceUriRef.current !== gfsUri ||
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
        liveResourceUriRef.current !== gfsUri ||
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
      if (ctrl.handleAuthorityFailure(message, 'operation', capturedScope, capturedGeneration))
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
  const bodyKey = `${capturedSessionScope ?? ''}:${capturedSessionGeneration ?? ''}:${gfsUri}:${reloadToken}:${reloadVersion ?? 0}`

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
          {scopeTransitionPending ? (
            <EmptyState
              title="Changing workspace"
              body="Refreshing file access for the selected team."
            />
          ) : denied || unavailable || accessRevoked ? (
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
                  expectedSessionGeneration={capturedSessionGeneration ?? undefined}
                  onDownloadError={handleDownloadError}
                  onCopyContentReady={handleCopyContentReady}
                  onSourceLoaded={handleMarkdownSourceLoaded}
                  editor={markdownEditor}
                  titleActions={markdownActions}
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
