import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createGfsUploadNameReservationBook } from '@clerum/gfs-interaction-policy'
import { ConfirmDialog } from '@components/ConfirmDialog'
import { desktopQueryKeys, isGfsSessionGeneration } from '@hooks/domain/queryKeys'
import { useGfsResourceOperations } from '@hooks/domain/useGfsResourceOperations'
import { gfsActionOpeningAuthority } from '@lib/gfsActionOpeningAuthority'
import { readCachedGfsChildNames } from '@lib/gfsCachedChildNames'
import { saveGfsFileToDisk } from '@lib/gfsDownload'
import { fetchGfsAuthority, requireFreshGfsPermissions } from '@lib/gfsFreshPermissions'
import type { GfsFreshPermissionsContext } from '@lib/gfsFreshPermissions.types'
import { describeGfsReadError, isGfsSessionAuthorityFailure } from '@lib/gfsGrantErrors'
import { copyGfsDeepLink, copyGfsResourceId } from '@lib/gfsResourceClipboard'
import {
  gfsSessionScope,
  handleGfsAuthorityFailure,
  readGfsAccessState,
} from '@lib/gfsSessionAuthority'
import type { GfsAccessState } from '@lib/gfsSessionAuthority.types'
import { sanitizeAppTabTitle } from '@lib/sanitizeAppTabTitle'
import { GfsExplicitMoveDialog, commitGfsExplicitMove } from '@/gfs/explicitMoveDialog'
import type { GfsExplicitMoveCommit } from '@/gfs/explicitMoveDialog.types'
import { GfsManageAccessDialog } from '@/gfs/manageAccessDialog'
import type { GfsManageAccessDeps } from '@/gfs/manageAccessDialog.types'
import { toastMoveOutcome } from '@/gfs/moveCommit'
import { GfsNameDialog } from '@/gfs/nameDialog'
import {
  runGfsCreateFolder,
  runGfsDelete,
  runGfsRename,
  runGfsUpload,
} from '@/gfs/resourceActionRunners'
import type { GfsActionRunResult, GfsActionRunnerDeps } from '@/gfs/resourceActionRunners.types'
import { GfsActionHostContext } from './context'
import type {
  GfsActionHostContextValue,
  GfsActionHostProps,
  GfsHostActionId,
  GfsHostActionOrigin,
  GfsHostActionTarget,
  GfsHostActiveAction,
  GfsHostPendingUpload,
} from './types'

const DIALOG_ACTIONS = new Set<GfsHostActionId>(['share', 'rename', 'move', 'new-folder', 'delete'])

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function displayName(name: string): string {
  return sanitizeAppTabTitle(name) || 'Unnamed'
}

/**
 * Runs the sidebar's actions on the resource the user chose, where the user
 * is: it never navigates, never touches a Files location, and owns one action
 * at a time. Mounted at the app root so its dialogs outlive the tree that
 * opened them.
 */
export function GfsActionHost({
  children,
  pushToast,
  refreshFilesLocation,
  onActionOpenChange,
}: GfsActionHostProps) {
  const queryClient = useQueryClient()
  const auth = useAuthContext()
  const sessionScope = gfsSessionScope(auth)
  const sessionGeneration = isGfsSessionGeneration(auth.sessionGeneration)
    ? auth.sessionGeneration
    : null
  const liveRef = useRef({ scope: sessionScope, generation: sessionGeneration })
  liveRef.current = { scope: sessionScope, generation: sessionGeneration }
  const ops = useGfsResourceOperations()

  // A pure subscription to the shared access flag: the host never fetches, it
  // only closes what a revocation made stale.
  const accessStateQuery = useQuery({
    queryKey: desktopQueryKeys.gfsAccessState(sessionScope ?? 'anonymous', sessionGeneration),
    queryFn: () => 'active' as GfsAccessState,
    enabled: false,
    initialData: 'active' as GfsAccessState,
    gcTime: Infinity,
    staleTime: Infinity,
  })
  const accessState: GfsAccessState =
    !sessionScope || sessionGeneration === null ? 'revoked' : (accessStateQuery.data ?? 'active')

  // The guards read the ref; the state only renders. A gesture writes both
  // and reports to the overlay gate in the same call, so the gate never sees
  // the menu closed before the action exists.
  const activeActionRef = useRef<GfsHostActiveAction | null>(null)
  const [activeAction, setActiveAction] = useState<GfsHostActiveAction | null>(null)
  const nextTokenRef = useRef(0)
  const pendingUploadRef = useRef<GfsHostPendingUpload | null>(null)
  // Uploads run outside the active action once their file is chosen, each
  // under its own token, so another action can open while they finish.
  const liveUploadsRef = useRef(new Map<number, GfsHostActionOrigin>())
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const uploadReservationsRef = useRef(createGfsUploadNameReservationBook())
  const [dialogError, setDialogError] = useState<string | null>(null)
  const onActionOpenChangeRef = useRef(onActionOpenChange)
  onActionOpenChangeRef.current = onActionOpenChange
  const pushToastRef = useRef(pushToast)
  pushToastRef.current = pushToast
  const refreshFilesLocationRef = useRef(refreshFilesLocation)
  refreshFilesLocationRef.current = refreshFilesLocation

  const writeAction = useCallback((next: GfsHostActiveAction | null) => {
    activeActionRef.current = next
    setActiveAction(next)
    onActionOpenChangeRef.current(next !== null)
  }, [])
  const ownsToken = (token: number) => activeActionRef.current?.token === token
  const finish = (token: number) => {
    if (ownsToken(token)) writeAction(null)
  }
  // Dismissal while the mutation runs is ignored: the mutation cannot be
  // recalled, and closing would let a drag of the same resource start.
  const dismiss = (token: number) => {
    const action = activeActionRef.current
    if (!action || action.token !== token || action.phase === 'running') return
    if (pendingUploadRef.current?.token === token) pendingUploadRef.current = null
    writeAction(null)
  }
  /**
   * The one way out of `running`: back to the dialog while the action is
   * still current, closed otherwise. A revocation during the mutation found
   * the action running and left it alone, so this is where it takes effect.
   */
  const leaveRunning = (running: GfsHostActiveAction, toDialog: boolean) => {
    const current = activeActionRef.current
    if (current?.token !== running.token || current.phase !== 'running') return false
    const reopen = toDialog && isActionCurrent(running)
    writeAction(reopen ? { ...running, phase: 'dialog' } : null)
    return reopen
  }
  const enterPhase = (action: GfsHostActiveAction, phase: GfsHostActiveAction['phase']) => {
    if (!ownsToken(action.token)) return null
    const next = { ...action, phase }
    writeAction(next)
    return next
  }

  const isOriginLive = (origin: GfsHostActionOrigin) =>
    liveRef.current.scope === origin.originScope &&
    liveRef.current.generation === origin.originGen &&
    readGfsAccessState(queryClient, origin.originScope, origin.originGen) === 'active'
  const isActionCurrent = (action: GfsHostActiveAction) =>
    ownsToken(action.token) && isOriginLive(action)

  // The last word before an outcome is shown: main may already run another
  // session the renderer has not published yet.
  const mayPresentOutcome = async (action: GfsHostActionOrigin) => {
    let authoritativeGeneration: number
    try {
      authoritativeGeneration = await window.clerum.auth.getSessionGeneration()
    } catch {
      return false
    }
    return (
      authoritativeGeneration === action.originGen &&
      liveRef.current.scope === action.originScope &&
      readGfsAccessState(queryClient, action.originScope, action.originGen) === 'active'
    )
  }

  const failClosed = (message: string, scope: string | null, generation: number | null) =>
    handleGfsAuthorityFailure(queryClient, scope, generation, message, 'operation', liveRef.current)

  const freshContext = (isCurrent: () => boolean): GfsFreshPermissionsContext => ({
    queryClient,
    handleAuthorityFailure: (error, scope, generation) =>
      failClosed(toMessage(error), scope, generation) !== 'not-authority',
    pushToast: (message, tone) => pushToastRef.current(message, tone),
    isCurrent,
  })
  const freshPermissions =
    (action: GfsHostActionOrigin, isCurrent: () => boolean) =>
    (
      resourceId: string,
      resourceName: string,
      bits: readonly string[],
      grantableBits: readonly string[] = []
    ) =>
      requireFreshGfsPermissions(
        {
          scope: action.originScope,
          gen: action.originGen,
          resourceId,
          resourceName,
          drive: action.target.drive,
          bits,
          grantableBits,
        },
        freshContext(isCurrent)
      )
  const runnerDeps = (
    action: GfsHostActionOrigin,
    isCurrent: () => boolean
  ): GfsActionRunnerDeps => ({
    ops,
    freshPermissions: freshPermissions(action, isCurrent),
    readAccessState: () => readGfsAccessState(queryClient, action.originScope, action.originGen),
    publishedGeneration: () => liveRef.current.generation,
    isCurrent,
  })
  const actionRunnerDeps = (action: GfsHostActiveAction) =>
    runnerDeps(action, () => isActionCurrent(action))

  // A revocation, a session switch or a logout leaves nothing of the old
  // session open. A running mutation finishes on its own and shows nothing;
  // the phase is a dependency so the check runs again once it stops running.
  // A revocation also retires every upload in flight for good: a retry of
  // access restores the same session, and an upload must not resume in it.
  const activePhase = activeAction?.phase ?? null
  useEffect(() => {
    const isStale = (origin: GfsHostActionOrigin) =>
      accessState !== 'active' ||
      sessionScope !== origin.originScope ||
      sessionGeneration !== origin.originGen
    for (const [token, origin] of liveUploadsRef.current) {
      if (isStale(origin)) liveUploadsRef.current.delete(token)
    }
    const action = activeActionRef.current
    if (!action || action.phase === 'running' || !isStale(action)) return
    pendingUploadRef.current = null
    writeAction(null)
  }, [accessState, activePhase, sessionGeneration, sessionScope, writeAction])

  const checkOpening = async (action: GfsHostActiveAction) => {
    const authority = gfsActionOpeningAuthority(action.target, action.actionId)
    if (authority.kind === 'unverifiable') {
      pushToastRef.current(authority.message, 'error')
      finish(action.token)
      return
    }
    const allowed = await freshPermissions(action, () => isActionCurrent(action))(
      authority.resourceId,
      authority.resourceName,
      authority.bits
    )
    if (!allowed || !isActionCurrent(action)) {
      finish(action.token)
      return
    }
    enterPhase(action, 'dialog')
  }

  const download = async (origin: GfsHostActionOrigin) => {
    const { target } = origin
    try {
      // The raw name is the real on-disk filename; the toast shows the cleaned one.
      await saveGfsFileToDisk(target.gfsUri, target.name)
      if (await mayPresentOutcome(origin)) {
        pushToastRef.current(`Downloaded ${displayName(target.name)}`, 'success')
      }
    } catch (error) {
      if (failClosed(toMessage(error), origin.originScope, origin.originGen) !== 'not-authority') {
        return
      }
      if (await mayPresentOutcome(origin)) {
        pushToastRef.current(describeGfsReadError(error).message, 'error')
      }
    }
  }

  const openAction = (target: GfsHostActionTarget, actionId: GfsHostActionId) => {
    const { scope, generation } = liveRef.current
    if (!scope || generation === null) return
    // A revoked session has its own surface; an action would only fail.
    if (readGfsAccessState(queryClient, scope, generation) !== 'active') return
    if (actionId === 'copy-link') {
      void copyGfsDeepLink(target.gfsUri, pushToastRef.current)
      return
    }
    if (actionId === 'copy-route') {
      void copyGfsResourceId(target.gfsUri, target.kind, pushToastRef.current)
      return
    }
    if (actionId === 'download') {
      void download({ target, originScope: scope, originGen: generation })
      return
    }
    // One action at a time; a running one cannot be replaced, an opening one can.
    if (activeActionRef.current?.phase === 'running') return
    if (actionId !== 'upload-file' && !DIALOG_ACTIONS.has(actionId)) return
    nextTokenRef.current += 1
    const token = nextTokenRef.current
    setDialogError(null)
    if (actionId === 'upload-file') {
      const input = uploadInputRef.current
      if (!input) return
      pendingUploadRef.current = {
        token,
        folder: target,
        originScope: scope,
        originGen: generation,
      }
      writeAction({
        token,
        target,
        actionId,
        originScope: scope,
        originGen: generation,
        phase: 'picking',
      })
      // Inside the gesture: the browser opens a file picker only for one.
      input.value = ''
      input.click()
      return
    }
    const action: GfsHostActiveAction = {
      token,
      target,
      actionId,
      originScope: scope,
      originGen: generation,
      phase: 'checking',
    }
    pendingUploadRef.current = null
    writeAction(action)
    void checkOpening(action)
  }

  /**
   * Runs one submitted action and settles it. The outcome is shown only while
   * the session it ran under is still main's and still active; a failure the
   * dialog can correct keeps it open with the error.
   */
  const runSubmitted = async <T,>(
    action: GfsHostActiveAction,
    run: (running: GfsHostActiveAction) => Promise<GfsActionRunResult<T>>,
    successMessage: (value: T) => string,
    failureStaysInDialog: boolean
  ) => {
    const running = enterPhase(action, 'running')
    if (!running) return
    try {
      const result = await run(running)
      if (result.status === 'done') {
        if (isActionCurrent(running)) refreshFilesLocationRef.current()
        if (await mayPresentOutcome(running)) {
          pushToastRef.current(successMessage(result.value), 'success')
        }
        return
      }
      if (result.status !== 'failed') return
      const message = toMessage(result.error)
      // An authority rejection already failed closed in the operation itself.
      if (isGfsSessionAuthorityFailure(message, 'operation')) return
      if (!(await mayPresentOutcome(running))) return
      if (failureStaysInDialog && leaveRunning(running, true)) {
        setDialogError(message)
        return
      }
      pushToastRef.current(message, 'error')
    } finally {
      leaveRunning(running, false)
    }
  }

  const submitName = (value: string) => {
    const action = activeActionRef.current
    if (!action || action.phase !== 'dialog') return
    setDialogError(null)
    const { target } = action
    if (action.actionId === 'rename') {
      void runSubmitted(
        action,
        running =>
          runGfsRename(
            actionRunnerDeps(running),
            { resourceId: target.resourceId, name: target.name, version: target.version },
            value
          ),
        renamed => `Renamed to ${displayName(renamed.name)}`,
        true
      )
    } else if (action.actionId === 'new-folder') {
      void runSubmitted(
        action,
        running =>
          runGfsCreateFolder(
            actionRunnerDeps(running),
            { resourceId: target.resourceId, name: target.name },
            value,
            { onPermitted: () => setDialogError(null) }
          ),
        created => `Folder ${displayName(created.name)} created`,
        true
      )
    }
  }

  const confirmDelete = () => {
    const action = activeActionRef.current
    if (!action || action.actionId !== 'delete' || action.phase !== 'dialog') return undefined
    const { target } = action
    return runSubmitted(
      action,
      running =>
        runGfsDelete(actionRunnerDeps(running), {
          resourceId: target.resourceId,
          name: target.name,
          version: target.version,
        }),
      () => `Deleted ${displayName(target.name)}`,
      false
    )
  }

  const handleUploadChosen = (file: File | null) => {
    const pending = pendingUploadRef.current
    pendingUploadRef.current = null
    const action = activeActionRef.current
    // A file for a picker whose action was closed (revoked, replaced) is dropped unread.
    if (!pending || !action || action.token !== pending.token) return
    if (!file) {
      dismiss(action.token)
      return
    }
    if (!isActionCurrent(action)) {
      finish(action.token)
      return
    }
    const run: GfsHostActionOrigin = {
      target: pending.folder,
      originScope: action.originScope,
      originGen: action.originGen,
    }
    liveUploadsRef.current.set(action.token, run)
    // The file is chosen: the action no longer covers the window.
    writeAction(null)
    void runUpload(action.token, run, file)
  }

  const runUpload = async (token: number, run: GfsHostActionOrigin, file: File) => {
    const isCurrent = () => liveUploadsRef.current.has(token) && isOriginLive(run)
    const folder = run.target
    try {
      const result = await runGfsUpload(
        runnerDeps(run, isCurrent),
        { resourceId: folder.resourceId, name: folder.name },
        file,
        readCachedGfsChildNames(
          queryClient,
          run.originScope,
          run.originGen,
          folder.resourceId,
          folder.drive
        ),
        uploadReservationsRef.current
      )
      if (result.status === 'done') {
        if (isCurrent()) refreshFilesLocationRef.current()
        if (isCurrent() && (await mayPresentOutcome(run))) {
          pushToastRef.current(`Uploaded ${displayName(result.value.name)}`, 'success')
        }
        return
      }
      if (result.status !== 'failed') return
      const message = toMessage(result.error)
      if (isGfsSessionAuthorityFailure(message, 'operation')) return
      if (isCurrent() && (await mayPresentOutcome(run))) pushToastRef.current(message, 'error')
    } finally {
      liveUploadsRef.current.delete(token)
    }
  }
  const handleUploadChosenRef = useRef(handleUploadChosen)
  handleUploadChosenRef.current = handleUploadChosen
  useEffect(() => {
    const input = uploadInputRef.current
    if (!input) return
    // React has no prop for the picker's cancel event.
    const onCancel = () => handleUploadChosenRef.current(null)
    input.addEventListener('cancel', onCancel)
    return () => input.removeEventListener('cancel', onCancel)
  }, [])

  const openActionRef = useRef(openAction)
  openActionRef.current = openAction
  const openGfsAction = useCallback<GfsActionHostContextValue['openGfsAction']>(
    (target, actionId) => openActionRef.current(target, actionId),
    []
  )
  const hostMovingResourceId =
    activeAction?.actionId === 'move' && activeAction.phase === 'running'
      ? activeAction.target.resourceId
      : null
  const contextValue = useMemo<GfsActionHostContextValue>(
    () => ({ openGfsAction, hostMovingResourceId }),
    [hostMovingResourceId, openGfsAction]
  )

  const renderDialog = (action: GfsHostActiveAction) => {
    const { target, token } = action
    const busy = action.phase === 'running'
    const shownName = displayName(target.name)
    switch (action.actionId) {
      case 'rename':
        return (
          <GfsNameDialog
            busy={busy}
            description={<>Enter a new name for {shownName}.</>}
            error={dialogError}
            fieldLabel="Name"
            formLabel={`Rename ${shownName}`}
            initialValue={target.name}
            submitLabel="Save"
            title={target.kind === 'directory' ? 'Rename folder' : 'Rename file'}
            onCancel={() => dismiss(token)}
            onSubmit={submitName}
          />
        )
      case 'new-folder':
        return (
          <GfsNameDialog
            busy={busy}
            description={<>Create a new folder in {shownName}.</>}
            error={dialogError}
            fieldLabel="Folder name"
            formLabel="Create folder"
            placeholder="e.g. research-notes"
            submitLabel="Create folder"
            title="New folder"
            onCancel={() => dismiss(token)}
            onSubmit={submitName}
          />
        )
      case 'delete':
        return (
          <ConfirmDialog
            body={
              target.kind === 'directory'
                ? 'The folder and everything inside it will be deleted for everyone with access.'
                : 'The file will be deleted for everyone with access.'
            }
            confirmLabel="Delete"
            onCancel={() => dismiss(token)}
            onConfirm={confirmDelete}
            title={`Delete ${shownName}?`}
            tone="danger"
          />
        )
      case 'share':
        return (
          <GfsManageAccessDialog
            key={token}
            target={{ resourceId: target.resourceId, name: target.name, kind: target.kind }}
            isCurrent={() => isActionCurrent(action)}
            deps={manageAccessDeps(action)}
            pushToast={pushToast}
            onClose={() => dismiss(token)}
          />
        )
      case 'move':
        return (
          <GfsExplicitMoveDialog
            key={token}
            target={{ node: target, initialCrumbs: [...(target.ancestorCrumbs ?? [])] }}
            sessionScope={sessionScope}
            sessionGeneration={sessionGeneration}
            accessActive={accessState === 'active'}
            busy={busy || ops.mutating}
            isOwnerCurrent={() => ownsToken(token)}
            isPresentationCurrent={() => ownsToken(token)}
            sourceGeneration={() => token}
            commitMove={commitMove(action)}
            handleAuthorityFailure={(message, scope, generation) =>
              failClosed(message, scope, generation) !== 'not-authority'
            }
            reportOutcome={async (outcome, source, destinationName) => {
              if (await mayPresentOutcome(action)) {
                toastMoveOutcome(
                  pushToastRef.current,
                  outcome,
                  source.name,
                  destinationName,
                  source.kind
                )
              }
            }}
            onClose={() => dismiss(token)}
          />
        )
      default:
        return null
    }
  }

  const manageAccessDeps = (action: GfsHostActiveAction): GfsManageAccessDeps => ({
    gate: accessState !== 'active',
    handleAuthorityFailure: (message, surface, scope, generation) =>
      handleGfsAuthorityFailure(queryClient, scope, generation, message, surface, liveRef.current),
    // The ACL write already failed closed in its mutation; this only classifies.
    failClosed: error => isGfsSessionAuthorityFailure(toMessage(error), 'operation'),
    freshPermissions: (resourceId, resourceName, bits, grantableBits) =>
      freshPermissions(action, () => isActionCurrent(action))(
        resourceId,
        resourceName,
        bits,
        grantableBits
      ),
    fetchAuthority: (resourceId, resourceName) =>
      fetchGfsAuthority(
        {
          scope: action.originScope,
          gen: action.originGen,
          resourceId,
          resourceName,
          drive: action.target.drive,
        },
        freshContext(() => isActionCurrent(action))
      ),
    readAccessState: () => readGfsAccessState(queryClient, action.originScope, action.originGen),
    publishedGeneration: () => liveRef.current.generation,
  })

  const commitMove =
    (action: GfsHostActiveAction): GfsExplicitMoveCommit =>
    async (source, destination, options) => {
      if (!isActionCurrent(action)) return { status: 'gesture-lost' }
      const running = enterPhase(action, 'running')
      if (!running) return { status: 'gesture-lost' }
      try {
        const outcome = await commitGfsExplicitMove(
          {
            ops,
            handleAuthorityFailure: (message, scope) =>
              failClosed(message, scope, running.originGen) !== 'not-authority',
            occupiedDestinationNames: destinationId =>
              readCachedGfsChildNames(
                queryClient,
                running.originScope,
                running.originGen,
                destinationId,
                running.target.drive
              ),
            pushToast: pushToastRef.current,
          },
          source,
          destination,
          {
            ...options,
            // Revoking access keeps the generation, so main's check alone misses it.
            isCurrent: () => options.isCurrent?.() !== false && isActionCurrent(running),
          }
        )
        // The move's convergence relocates caches and open-location entries,
        // but not the crumbs a Files tab shows for the moved folder or a
        // descendant: only a re-read of that location does.
        if (outcome.status === 'committed' && isActionCurrent(running)) {
          refreshFilesLocationRef.current()
        }
        return outcome
      } finally {
        // Back to the dialog: it shows a failure in place, or closes on success.
        leaveRunning(running, true)
      }
    }

  const shownAction =
    activeAction && (activeAction.phase === 'dialog' || activeAction.phase === 'running')
      ? activeAction
      : null

  return (
    <GfsActionHostContext.Provider value={contextValue}>
      {children}
      <div className="da-gfs-action-host">
        <input
          ref={uploadInputRef}
          aria-hidden="true"
          className="visually-hidden"
          data-testid="gfs-action-host-upload-input"
          tabIndex={-1}
          type="file"
          onChange={event => handleUploadChosen(event.currentTarget.files?.[0] ?? null)}
        />
        {shownAction ? renderDialog(shownAction) : null}
      </div>
    </GfsActionHostContext.Provider>
  )
}
