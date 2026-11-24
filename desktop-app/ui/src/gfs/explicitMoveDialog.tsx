import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { GFS_DRIVE_MAIN } from '@constants/gfsBrowser'
import {
  desktopQueryKeys,
  isGfsSessionAuthorityCurrent,
  isGfsSessionGeneration,
} from '@hooks/domain/queryKeys'
import { assertGfsAuthorityRetryAllowed } from '@lib/gfsAuthorityQueryPolicy'
import { hasGfsMoveSourcePermissions } from '@lib/gfsMovePermissions'
import type { GfsDragSource } from './dragSession.types'
import type {
  GfsExplicitMoveCommitDeps,
  GfsExplicitMoveCommitOptions,
  GfsExplicitMoveDialogProps,
} from './explicitMoveDialog.types'
import type { MoveCommitOutcome } from './moveCommit'
import { runGfsMoveCommit } from './moveCommitRunner'
import { GfsMoveDialog } from './moveDialog'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One move of an explicit source through the shared commit path, bound to an
 * owner's operations. The sidebar tree's drag path and the action host's Move
 * dialog dispatch through here; FilesPage calls `runGfsMoveCommit` directly.
 */
export function commitGfsExplicitMove(
  deps: GfsExplicitMoveCommitDeps,
  source: GfsDragSource,
  destination: { resourceId: string; name: string },
  {
    isCurrent,
    isPresentationCurrent,
    reportOutcomes = true,
    authoritativeSessionGeneration,
    expectedSourceSnapshot,
  }: GfsExplicitMoveCommitOptions
): Promise<MoveCommitOutcome> {
  return runGfsMoveCommit(
    {
      moveResource: (
        resourceId,
        destinationId,
        ifMatch,
        newName,
        oldParentId,
        expectedSessionGeneration
      ) =>
        deps.ops.moveResource(
          resourceId,
          destinationId,
          ifMatch,
          newName,
          oldParentId,
          source.scope,
          true,
          expectedSessionGeneration
        ),
      handleAuthorityFailure: message => deps.handleAuthorityFailure(message, source.scope),
      convergeCommittedMove: (input, receipt) =>
        deps.ops.convergeCommittedMove(input, receipt, source.scope),
      ...(reportOutcomes
        ? {
            pushToast: (message, tone) => {
              if (!isPresentationCurrent || isPresentationCurrent()) {
                deps.pushToast(message, tone)
              }
            },
          }
        : {}),
    },
    {
      source,
      destination,
      occupiedDestinationNames: deps.occupiedDestinationNames(destination.resourceId),
      ...(authoritativeSessionGeneration !== undefined
        ? { sessionGeneration: authoritativeSessionGeneration }
        : {}),
      ...(expectedSourceSnapshot ? { expectedSourceSnapshot } : {}),
      ...(isCurrent ? { isCurrent } : {}),
    }
  )
}

/**
 * The Move dialog for one explicit resource: the permission re-check and the
 * commit adapter around `GfsMoveDialog`. Its owner decides where it lives and
 * when it is still its own; the dialog never moves anything else.
 */
export function GfsExplicitMoveDialog({
  target,
  sessionScope,
  sessionGeneration,
  accessActive,
  busy,
  closeLocked = false,
  isOwnerCurrent,
  isPresentationCurrent: isOwnerPresentationCurrent,
  sourceGeneration,
  commitMove,
  handleAuthorityFailure,
  reportOutcome,
  onClose,
}: GfsExplicitMoveDialogProps) {
  const queryClient = useQueryClient()
  const [permissionStatus, setPermissionStatus] = useState<'checking' | 'failed' | null>(null)
  const liveScope = accessActive ? (sessionScope ?? 'anonymous') : null
  const liveScopeRef = useRef(liveScope)
  liveScopeRef.current = liveScope
  const liveAuthorityRef = useRef({ scope: sessionScope, generation: sessionGeneration })
  liveAuthorityRef.current = { scope: sessionScope, generation: sessionGeneration }
  const isOwnerCurrentRef = useRef(isOwnerCurrent)
  isOwnerCurrentRef.current = isOwnerCurrent
  const ownsDialog = () => isOwnerCurrentRef.current()
  const isOwnerPresentationCurrentRef = useRef(isOwnerPresentationCurrent)
  isOwnerPresentationCurrentRef.current = isOwnerPresentationCurrent
  // Mounted: a closed dialog dispatches no further attempt. Whether its
  // outcome is still shown is the owner's call, not the dialog's.
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const handleRetryPermission = async (
    destinationId: string,
    _destinationName: string,
    isDialogCurrent: () => boolean
  ) => {
    if (!ownsDialog() || !isDialogCurrent()) return
    const scope = sessionScope
    const expectedScope = scope ?? 'anonymous'
    const expectedGeneration = sessionGeneration
    const ownsRetry = () =>
      ownsDialog() &&
      liveScopeRef.current === expectedScope &&
      isGfsSessionAuthorityCurrent(
        scope,
        expectedGeneration,
        liveAuthorityRef.current.scope,
        liveAuthorityRef.current.generation
      ) &&
      isDialogCurrent()
    const drive = target.node.drive || GFS_DRIVE_MAIN
    setPermissionStatus('checking')

    try {
      if (!scope || !isGfsSessionGeneration(expectedGeneration)) {
        throw new Error('Could not verify the source folder for this move.')
      }
      const destinationKey = desktopQueryKeys.gfsAffordances(
        scope,
        destinationId,
        drive,
        expectedGeneration
      )
      assertGfsAuthorityRetryAllowed(queryClient, destinationKey)

      if (!ownsRetry()) {
        if (ownsDialog()) setPermissionStatus(null)
        return
      }
      const resolvedSource = await window.clerum.gfs.resolve(target.node.gfsUri)
      if (!ownsRetry()) {
        if (ownsDialog()) setPermissionStatus(null)
        return
      }
      if (resolvedSource.resourceId !== target.node.resourceId) {
        throw new Error('Could not verify the source folder for this move.')
      }
      const sourceParentId = resolvedSource.parentResourceId
      if (!sourceParentId) {
        throw new Error('Could not verify the source folder for this move.')
      }
      const sourceKey = desktopQueryKeys.gfsAffordances(
        scope,
        sourceParentId,
        drive,
        expectedGeneration
      )
      assertGfsAuthorityRetryAllowed(queryClient, sourceKey)
      assertGfsAuthorityRetryAllowed(queryClient, destinationKey)

      const [source, destination] = await Promise.all([
        queryClient.fetchQuery({
          queryKey: sourceKey,
          queryFn: () => window.clerum.gfs.affordances(sourceParentId, drive),
          staleTime: 0,
          retry: false,
        }),
        queryClient.fetchQuery({
          queryKey: destinationKey,
          queryFn: () => window.clerum.gfs.affordances(destinationId, drive),
          staleTime: 0,
          retry: false,
        }),
      ])
      if (!ownsRetry()) {
        if (ownsDialog()) setPermissionStatus(null)
        return
      }
      if (!hasGfsMoveSourcePermissions(source.held)) {
        throw new Error('You do not have write and delete access to the source folder.')
      }
      if (!destination.held.includes('write')) {
        throw new Error('You do not have write access to the destination folder.')
      }
      setPermissionStatus(null)
    } catch (retryError) {
      if (!ownsDialog()) return
      if (!ownsRetry()) {
        setPermissionStatus(null)
        return
      }
      if (handleAuthorityFailure(errorMessage(retryError), scope, expectedGeneration)) {
        onClose()
        return
      }
      setPermissionStatus('failed')
      throw retryError
    }
  }

  const handleMove = async (
    destinationId: string,
    destinationName: string,
    isDialogCurrent: () => boolean
  ) => {
    setPermissionStatus(null)
    if (!ownsDialog()) return
    const publishedGeneration = sessionGeneration
    const publishedScope = sessionScope
    const ownsPublishedAuthority = () =>
      isGfsSessionAuthorityCurrent(
        publishedScope,
        publishedGeneration,
        liveAuthorityRef.current.scope,
        liveAuthorityRef.current.generation
      )
    if (!ownsPublishedAuthority()) return
    const node = target.node
    const source: GfsDragSource = {
      resourceId: node.resourceId,
      gfsUri: node.gfsUri,
      drive: node.drive || GFS_DRIVE_MAIN,
      kind: node.kind === 'directory' ? 'directory' : 'file',
      name: node.name,
      ...(Number.isSafeInteger(node.version) ? { version: node.version } : {}),
      parentKnown: node.parentResourceId != null,
      parentResourceId: node.parentResourceId ?? null,
      knownAncestorIds: [],
      origin: 'sidebar',
      scope: sessionScope ?? 'anonymous',
      generation: sourceGeneration(),
    }
    const isCurrent = () =>
      ownsPublishedAuthority() &&
      mountedRef.current &&
      ownsDialog() &&
      liveScopeRef.current === source.scope &&
      isDialogCurrent()
    const isPresentationCurrent = () =>
      ownsPublishedAuthority() && isOwnerPresentationCurrentRef.current(source)
    const authoritativeSessionGeneration = await window.clerum.auth.getSessionGeneration()
    if (authoritativeSessionGeneration !== publishedGeneration || !isCurrent()) return
    const outcome = await commitMove(
      source,
      { resourceId: destinationId, name: destinationName },
      { isCurrent, isPresentationCurrent, reportOutcomes: false, authoritativeSessionGeneration }
    )
    if (outcome.status === 'gesture-lost') return
    if (outcome.status === 'session-lost') {
      if (ownsDialog()) onClose()
      return
    }
    if (!isCurrent()) {
      if (isPresentationCurrent()) await reportOutcome(outcome, source, destinationName)
      return
    }
    if (outcome.status !== 'committed' && outcome.status !== 'no-op') {
      if (
        ownsDialog() &&
        outcome.status === 'unconfirmed' &&
        outcome.retryPermissionCheck === true
      ) {
        setPermissionStatus('failed')
      }
      throw new Error(outcome.message)
    }
    await reportOutcome(outcome, source, destinationName)
    if (ownsDialog()) onClose()
  }

  return (
    <GfsMoveDialog
      busy={busy || permissionStatus === 'checking'}
      closeLocked={closeLocked}
      initialCrumbs={target.initialCrumbs}
      onClose={onClose}
      onMoveWithOwnership={handleMove}
      onRetryPermissionCheck={handleRetryPermission}
      onAuthorityFailure={handleAuthorityFailure}
      sessionScope={sessionScope ?? undefined}
      sessionGeneration={sessionGeneration}
      target={{
        resourceId: target.node.resourceId,
        name: target.node.name,
        kind: target.node.kind === 'directory' ? 'directory' : 'file',
        parentResourceId: target.node.parentResourceId ?? null,
      }}
      permissionStatus={permissionStatus}
    />
  )
}
