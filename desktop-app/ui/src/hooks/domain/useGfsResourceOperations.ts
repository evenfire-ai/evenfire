import { useCallback, useRef } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { applyMoveConvergence } from '@lib/gfsEntityChangeState'
import { ancestryDependentGfsResourceIds, readGfsOpenLocations } from '@lib/gfsOpenLocations'
import {
  gfsSessionScope,
  handleGfsAuthorityFailure,
  isGfsSessionGenerationConfirmed,
} from '@lib/gfsSessionAuthority'
import {
  desktopQueryKeys,
  hasGfsSessionGeneration,
  isGfsSessionAuthorityCurrent,
  isGfsSessionGeneration,
} from './queryKeys'
import type {
  GfsCommittedOperation,
  GfsMoveConvergenceInput,
  GfsMoveMutationInput,
  GfsOperationAuthority,
  GfsOperationAuthorityFailureHandler,
  GfsResourceOperationsOptions,
} from './useGfsResourceOperations.types'

const DRIVE = 'main'

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The GFS content mutations, with no queries of their own, so any surface can
 * act on an explicit resource without mounting a browser. Every mutation
 * shares one fail-closed boundary and one post-commit refresh; a browser
 * controller composes this hook and adds its location bookkeeping through
 * `onCommitted`.
 */
export function useGfsResourceOperations(options: GfsResourceOperationsOptions = {}) {
  const queryClient = useQueryClient()
  const auth = useAuthContext()
  const sessionScope = gfsSessionScope(auth)
  const sessionGeneration = isGfsSessionGeneration(auth.sessionGeneration)
    ? auth.sessionGeneration
    : null
  const liveSessionScopeRef = useRef(sessionScope)
  liveSessionScopeRef.current = sessionScope
  const liveSessionGenerationRef = useRef(sessionGeneration)
  liveSessionGenerationRef.current = sessionGeneration
  const ownsPublishedAuthority = useCallback(
    () =>
      isGfsSessionAuthorityCurrent(
        sessionScope,
        sessionGeneration,
        liveSessionScopeRef.current,
        liveSessionGenerationRef.current
      ),
    [sessionScope, sessionGeneration]
  )

  const libraryAuthorityFailureHandler = useCallback<GfsOperationAuthorityFailureHandler>(
    (message, surface, scope, generation) =>
      handleGfsAuthorityFailure(queryClient, scope, generation, message, surface, {
        scope: liveSessionScopeRef.current,
        generation: liveSessionGenerationRef.current,
      }),
    [queryClient]
  )
  const handleAuthorityFailure = options.handleAuthorityFailure ?? libraryAuthorityFailureHandler
  const onCommitted = options.onCommitted

  const captureAuthority = (): GfsOperationAuthority => ({
    authorityScope: liveSessionScopeRef.current,
    authorityGeneration: liveSessionGenerationRef.current,
  })
  // An authority rejection (401 / typed lifecycle code) revokes the session it
  // was issued under even when the caller would only have toasted. Policy
  // verdicts (403/412) stay local.
  const failClosedOnMutationError = (error: unknown, input: GfsOperationAuthority) => {
    handleAuthorityFailure(
      toMessage(error),
      'operation',
      input.authorityScope,
      input.authorityGeneration
    )
  }

  const refreshGfs = useCallback(async () => {
    if (!ownsPublishedAuthority()) return
    await queryClient.invalidateQueries({
      queryKey: desktopQueryKeys.gfsRoot,
      // Content mutations refresh discovery and folder listings. Permission
      // affordances are refreshed explicitly when Manage opens; coupling them
      // here temporarily removes write controls between consecutive uploads.
      predicate: query =>
        query.queryKey[2] === sessionScope &&
        hasGfsSessionGeneration(query.queryKey, sessionGeneration) &&
        query.queryKey[3] !== 'affordances',
    })
  }, [queryClient, sessionScope, sessionGeneration, ownsPublishedAuthority])

  const commitThenRefresh = async (commit: GfsCommittedOperation) => {
    // A synchronous owner reaction must not delay the refresh by a microtask.
    const reaction = onCommitted?.(commit)
    if (reaction) await reaction
    await refreshGfs()
  }

  // Move refreshes through the shared convergence planner: the receipt
  // selectively invalidates the old/new parent listings and accessible roots
  // and marks the moved resource plus its known descendants' permission data
  // stale. The ancestry that decides which open dialogs inherit through the
  // moved resource comes from the shared open-location registry, because the
  // dialog showing it can live in another surface than the one that moved.
  //
  // Two entry points reach it: the mutation's success path, and the
  // transport-loss path where the PATCH landed but its response never arrived.
  const convergeCommittedMove = useCallback(
    async (
      input: GfsMoveConvergenceInput,
      receipt: { version: number },
      operationScope?: string | null
    ) => {
      if (
        input.expectedSessionGeneration !== undefined &&
        !(await isGfsSessionGenerationConfirmed(
          input.expectedSessionGeneration,
          () => liveSessionGenerationRef.current
        ))
      ) {
        return
      }
      const capturedScope = operationScope === undefined ? sessionScope : operationScope
      if (capturedScope) {
        applyMoveConvergence(
          queryClient,
          capturedScope,
          DRIVE,
          {
            resourceId: input.resourceId,
            oldParentId: input.oldParentId ?? null,
            newParentId: input.destinationId,
          },
          {
            sessionGeneration: input.expectedSessionGeneration ?? sessionGeneration,
            ancestryDependentResourceIds: ancestryDependentGfsResourceIds(
              readGfsOpenLocations(queryClient, capturedScope),
              input.resourceId
            ),
          }
        )
      } else if (capturedScope === liveSessionScopeRef.current) {
        await refreshGfs()
      }
      await onCommitted?.({
        op: 'moveResource',
        input: { ...input, operationScope: capturedScope },
        result: receipt,
      })
    },
    [onCommitted, queryClient, refreshGfs, sessionScope, sessionGeneration]
  )

  const createFolderMutation = useMutation({
    mutationFn: (input: { parentResourceId: string; name: string } & GfsOperationAuthority) =>
      window.clerum.gfs.createFolder(input.parentResourceId, input.name, DRIVE),
    onSuccess: (result, input) =>
      commitThenRefresh({
        op: 'createFolder',
        input: { parentResourceId: input.parentResourceId, name: input.name },
        result,
      }),
    onError: failClosedOnMutationError,
  })
  const createFileMutation = useMutation({
    mutationFn: (
      input: { parentResourceId: string; name: string; encodedData: string } & GfsOperationAuthority
    ) => window.clerum.gfs.createFile(input.parentResourceId, input.name, input.encodedData, DRIVE),
    onSuccess: (result, input) =>
      commitThenRefresh({
        op: 'createFile',
        input: {
          parentResourceId: input.parentResourceId,
          name: input.name,
          encodedData: input.encodedData,
        },
        result,
      }),
    onError: failClosedOnMutationError,
  })
  const createFileFromPathMutation = useMutation({
    mutationFn: (
      input: { parentResourceId: string; name: string; filePath: string } & GfsOperationAuthority
    ) =>
      window.clerum.gfs.createFileFromPath(
        input.parentResourceId,
        input.name,
        input.filePath,
        DRIVE
      ),
    onSuccess: (result, input) =>
      commitThenRefresh({
        op: 'createFileFromPath',
        input: {
          parentResourceId: input.parentResourceId,
          name: input.name,
          filePath: input.filePath,
        },
        result,
      }),
    onError: failClosedOnMutationError,
  })
  const replaceFileMutation = useMutation({
    mutationFn: (
      input: { resourceId: string; encodedData: string; ifMatch?: number } & GfsOperationAuthority
    ) => window.clerum.gfs.replaceFile(input.resourceId, input.encodedData, DRIVE, input.ifMatch),
    onSuccess: (result, input) =>
      commitThenRefresh({
        op: 'replaceFile',
        input: {
          resourceId: input.resourceId,
          encodedData: input.encodedData,
          ifMatch: input.ifMatch,
        },
        result,
      }),
    onError: failClosedOnMutationError,
  })
  const replaceFileFromPathMutation = useMutation({
    mutationFn: (
      input: { resourceId: string; filePath: string; ifMatch?: number } & GfsOperationAuthority
    ) =>
      window.clerum.gfs.replaceFileFromPath(input.resourceId, input.filePath, DRIVE, input.ifMatch),
    onSuccess: (result, input) =>
      commitThenRefresh({
        op: 'replaceFileFromPath',
        input: { resourceId: input.resourceId, filePath: input.filePath, ifMatch: input.ifMatch },
        result,
      }),
    onError: failClosedOnMutationError,
  })
  const renameResourceMutation = useMutation({
    mutationFn: (
      input: { resourceId: string; name: string; ifMatch?: number } & GfsOperationAuthority
    ) => window.clerum.gfs.renameResource(input.resourceId, input.name, DRIVE, input.ifMatch),
    onSuccess: (result, input) =>
      commitThenRefresh({
        op: 'renameResource',
        input: { resourceId: input.resourceId, name: input.name, ifMatch: input.ifMatch },
        result,
      }),
    onError: failClosedOnMutationError,
  })
  const deleteResourceMutation = useMutation({
    mutationFn: (input: { resourceId: string; ifMatch?: number } & GfsOperationAuthority) =>
      window.clerum.gfs.deleteResource(input.resourceId, DRIVE, input.ifMatch),
    onSuccess: (result, input) =>
      commitThenRefresh({
        op: 'deleteResource',
        input: { resourceId: input.resourceId, ifMatch: input.ifMatch },
        result,
      }),
    onError: failClosedOnMutationError,
  })
  const moveResourceMutation = useMutation({
    mutationFn: (input: GfsMoveMutationInput) =>
      window.clerum.gfs.moveResource(
        input.resourceId,
        input.destinationId,
        DRIVE,
        input.ifMatch,
        input.newName,
        input.expectedSessionGeneration
      ),
    onSuccess: async (receipt, input) => {
      await convergeCommittedMove(input, receipt, input.operationScope)
    },
    onError: async (error, input) => {
      if (
        !(await isGfsSessionGenerationConfirmed(
          input.expectedSessionGeneration,
          () => liveSessionGenerationRef.current
        ))
      )
        return
      if (!input.authorityHandledByCaller) {
        handleAuthorityFailure(
          toMessage(error),
          'operation',
          input.operationScope === undefined ? sessionScope : input.operationScope,
          input.expectedSessionGeneration
        )
      }
    },
  })

  return {
    refreshGfs,
    convergeCommittedMove,
    createFolder: (parentResourceId: string, name: string) =>
      createFolderMutation.mutateAsync({ parentResourceId, name, ...captureAuthority() }),
    createFile: (parentResourceId: string, name: string, encodedData: string) =>
      createFileMutation.mutateAsync({
        parentResourceId,
        name,
        encodedData,
        ...captureAuthority(),
      }),
    createFileFromPath: (parentResourceId: string, name: string, filePath: string) =>
      createFileFromPathMutation.mutateAsync({
        parentResourceId,
        name,
        filePath,
        ...captureAuthority(),
      }),
    replaceFile: (resourceId: string, encodedData: string, ifMatch?: number) =>
      replaceFileMutation.mutateAsync({ resourceId, encodedData, ifMatch, ...captureAuthority() }),
    replaceFileFromPath: (resourceId: string, filePath: string, ifMatch?: number) =>
      replaceFileFromPathMutation.mutateAsync({
        resourceId,
        filePath,
        ifMatch,
        ...captureAuthority(),
      }),
    renameResource: (resourceId: string, name: string, ifMatch?: number) =>
      renameResourceMutation.mutateAsync({ resourceId, name, ifMatch, ...captureAuthority() }),
    deleteResource: (resourceId: string, ifMatch?: number) =>
      deleteResourceMutation.mutateAsync({ resourceId, ifMatch, ...captureAuthority() }),
    moveResource: (
      resourceId: string,
      destinationId: string,
      ifMatch?: number,
      newName?: string,
      oldParentId?: string | null,
      operationScope?: string,
      authorityHandledByCaller?: boolean,
      expectedSessionGeneration?: number
    ) =>
      (async () => {
        const capturedGeneration =
          expectedSessionGeneration ?? (await window.clerum.auth.getSessionGeneration())
        return moveResourceMutation.mutateAsync({
          resourceId,
          destinationId,
          ifMatch,
          newName,
          oldParentId,
          operationScope,
          authorityHandledByCaller,
          expectedSessionGeneration: capturedGeneration,
        })
      })(),
    mutating:
      createFolderMutation.isPending ||
      createFileMutation.isPending ||
      createFileFromPathMutation.isPending ||
      replaceFileMutation.isPending ||
      replaceFileFromPathMutation.isPending ||
      renameResourceMutation.isPending ||
      moveResourceMutation.isPending ||
      deleteResourceMutation.isPending,
  }
}
