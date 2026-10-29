import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryKey } from '@tanstack/react-query'
import { normalizeGfsResourceName } from '@clerum/gfs-interaction-policy'
import { Button, IconButton, TextInput } from '@components/Common'
import { ConfirmDialog } from '@components/ConfirmDialog'
import { IconClose, IconShare } from '@components/SidebarNav/icons'
import { GFS_DRIVE_MAIN } from '@constants/gfsBrowser'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { httpErrorStatus } from '@lib/format'
import {
  GFS_AUTHORITY_STALE_TIME_MS,
  assertGfsAuthorityRetryAllowed,
  gfsAuthorityQueryPolicy,
} from '@lib/gfsAuthorityQueryPolicy'
import { saveGfsFileToDisk } from '@lib/gfsDownload'
import {
  describeGfsGrantError,
  describeGfsReadError,
  isGfsSessionAuthorityFailure,
} from '@lib/gfsGrantErrors'
import { hasGfsMoveSourcePermissions } from '@lib/gfsMovePermissions'
import { GfsGrantList } from '@/gfs/GfsGrantList'
import type { GfsAccessRole } from '@/gfs/GfsGrantList'
import {
  type GfsAgentSubjectOption,
  GfsDelegationPanel,
  type GfsDelegationSubjectOption,
} from '@/gfs/delegation'
import type { GfsGrantListItem, GfsShareListItem } from '@/gfs/delegation.types'
import { deriveGfsInheritedAccess } from '@/gfs/inheritedAccess'
import { commitGfsMove, toastMoveOutcome } from '@/gfs/moveCommit'
import type { MoveToast } from '@/gfs/moveCommit'
import { GfsMoveDialog } from '@/gfs/moveDialog'
import type { AgentWithMcpServers, TeamDirectoryResult } from '../../../src/types'

type ResourceAffordances = Awaited<ReturnType<typeof window.clerum.gfs.affordances>>

type FilePreviewResourceActionsProps = {
  gfsUri: string
  fileName: string
  sessionScope: string
  principalScope: string | null
  canResolve: boolean
  onAuthorityFailure: (message: string) => boolean
  onDeleted: () => void
  onRenameCommitted?: (gfsUri: string) => void
  pushToast?: MoveToast
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const INHERITED_ACCESS_ERROR_NOTICE =
  'Some access inherited from parent folders could not be loaded.'
const INHERITED_COVERAGE_UNAVAILABLE_NOTICE =
  'Inherited access could not be loaded. Members with access from a parent folder may be missing.'
const INHERITED_READ_BOUNDARY_NOTICE = 'There may be access from parent folders you cannot see.'
const INHERITED_READ_BOUNDARY_HINT =
  'Some folders above this one are not visible to you. People may still have access through them, but we cannot show who.'
const INHERITED_ACL_LIMITED_NOTICE =
  'Sharing details on some parent folders are not visible to you.'

function teamSubjectOptions(directory: TeamDirectoryResult | undefined) {
  if (!directory) return []
  const options = new Map<string, GfsDelegationSubjectOption>()
  for (const item of directory.items) {
    options.set(`team:${item.team.id}`, {
      type: 'team',
      id: item.team.id,
      label: item.team.name,
      description: item.team.role,
    })
    for (const member of item.members) {
      options.set(`user:${member.id}`, {
        type: 'user',
        id: member.id,
        label: member.name || member.email,
        description: member.email,
      })
    }
  }
  return [...options.values()].sort((left, right) =>
    `${left.type}:${left.label}`.localeCompare(`${right.type}:${right.label}`)
  )
}

function agentSubjectOptions(agents: AgentWithMcpServers[] | undefined): GfsAgentSubjectOption[] {
  if (!agents) return []
  const options = new Map<string, GfsAgentSubjectOption>()
  for (const agent of agents) {
    if (agent.gfsSubject?.type !== 'host' || !agent.gfsSubject.id) continue
    options.set(agent.gfsSubject.id, {
      id: agent.gfsSubject.id,
      name: agent.name,
      displayName: agent.displayName,
    })
  }
  return [...options.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function subjectOptions(
  teams: GfsDelegationSubjectOption[],
  agents: GfsAgentSubjectOption[]
): GfsDelegationSubjectOption[] {
  return [
    ...teams,
    ...agents.map(agent => ({
      type: 'host' as const,
      id: agent.id,
      label: agent.displayName?.trim() || agent.name,
      description: 'Agent',
      badge: 'Agent',
    })),
  ]
}

/** Resource actions for a preview tab. All mutations use the resolved canonical resource ID. */
export function useFilePreviewResourceActions({
  gfsUri,
  fileName,
  sessionScope,
  principalScope,
  canResolve,
  onAuthorityFailure,
  onDeleted,
  onRenameCommitted,
  pushToast,
}: FilePreviewResourceActionsProps) {
  const queryClient = useQueryClient()
  const [shareOpen, setShareOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [renameName, setRenameName] = useState(fileName)
  const [mutationPending, setMutationPending] = useState(false)
  const [movePermissionStatus, setMovePermissionStatus] = useState<'checking' | 'failed' | null>(
    null
  )
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null)
  const [revokingShareId, setRevokingShareId] = useState<string | null>(null)
  const deletePendingRef = useRef(false)
  const renamePendingRef = useRef(false)
  const moveRequestRef = useRef(0)
  const previewMountedRef = useRef(true)

  useEffect(() => {
    previewMountedRef.current = true
    return () => {
      previewMountedRef.current = false
      moveRequestRef.current += 1
    }
  }, [])

  const resourceQuery = useQuery({
    queryKey: [...desktopQueryKeys.gfsRoot, sessionScope, 'preview-resource', gfsUri],
    queryFn: () => window.clerum.gfs.resolve(gfsUri),
    enabled: Boolean(canResolve && sessionScope && sessionScope !== 'anonymous'),
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  })
  const resource = resourceQuery.isError ? undefined : resourceQuery.data
  const resourceId = resource?.resourceId ?? ''
  const drive = resource?.drive ?? GFS_DRIVE_MAIN
  const affordancesQuery = useQuery({
    queryKey: desktopQueryKeys.gfsAffordances(sessionScope, resourceId || gfsUri, drive),
    queryFn: () => window.clerum.gfs.affordances(resourceId, drive),
    enabled: Boolean(canResolve && resourceId && resource?.kind === 'file'),
    ...gfsAuthorityQueryPolicy,
  })
  const affordances: ResourceAffordances | undefined =
    affordancesQuery.isError &&
    [401, 403, 404].includes(httpErrorStatus(affordancesQuery.error) ?? 0)
      ? undefined
      : affordancesQuery.data
  const sourceParentId = resource?.parentResourceId ?? null
  const moveContextRef = useRef({
    gfsUri,
    sessionScope,
    principalScope,
    resourceId: resource?.resourceId ?? null,
    parentResourceId: sourceParentId,
    drive: resource?.drive ?? GFS_DRIVE_MAIN,
    version: resource?.version ?? null,
  })
  moveContextRef.current = {
    gfsUri,
    sessionScope,
    principalScope,
    resourceId: resource?.resourceId ?? null,
    parentResourceId: sourceParentId,
    drive: resource?.drive ?? GFS_DRIVE_MAIN,
    version: resource?.version ?? null,
  }
  const sourceParentAffordancesQuery = useQuery({
    queryKey: desktopQueryKeys.gfsAffordances(sessionScope, sourceParentId ?? gfsUri, drive),
    queryFn: () => window.clerum.gfs.affordances(sourceParentId!, drive),
    enabled: Boolean(canResolve && resource?.kind === 'file' && sourceParentId),
    ...gfsAuthorityQueryPolicy,
  })
  const sourceParentAffordances: ResourceAffordances | undefined =
    sourceParentAffordancesQuery.isError &&
    [401, 403, 404].includes(httpErrorStatus(sourceParentAffordancesQuery.error) ?? 0)
      ? undefined
      : sourceParentAffordancesQuery.data
  const canShare = Boolean(canResolve && affordances?.canDelegate)
  const canRename = Boolean(canResolve && affordances?.held.includes('write'))
  const canDelete = Boolean(canResolve && affordances?.held.includes('delete'))
  const canMove = Boolean(
    canResolve &&
    resource?.kind === 'file' &&
    sourceParentId &&
    !sourceParentAffordancesQuery.isError &&
    hasGfsMoveSourcePermissions(sourceParentAffordances?.held)
  )
  const sharePermissionAffordances = affordances ?? {
    canDelegate: false,
    grantableBits: [],
    canCreateShare: false,
  }
  const sharePermissionError = affordancesQuery.error
    ? describeGfsReadError(affordancesQuery.error).message
    : null
  const retryPermissionCheck = async (
    queryKey: QueryKey,
    refetch: () => Promise<{ isError: boolean; error: unknown }>
  ) => {
    try {
      assertGfsAuthorityRetryAllowed(queryClient, queryKey)
      const result = await refetch()
      if (result.isError) throw result.error
    } catch (error) {
      pushToast?.(describeGfsReadError(error).message, 'error')
    }
  }
  const permissionNotices = [
    affordancesQuery.isFetching && affordancesQuery.data
      ? {
          id: 'resource-permissions',
          message: 'Checking file permissions…',
          pending: true,
          retry: () =>
            retryPermissionCheck(
              desktopQueryKeys.gfsAffordances(sessionScope, resourceId || gfsUri, drive),
              () => affordancesQuery.refetch()
            ),
        }
      : affordancesQuery.error
        ? {
            id: 'resource-permissions',
            message: `Could not verify file permissions: ${describeGfsReadError(affordancesQuery.error).message}`,
            pending: false,
            retry: () =>
              retryPermissionCheck(
                desktopQueryKeys.gfsAffordances(sessionScope, resourceId || gfsUri, drive),
                () => affordancesQuery.refetch()
              ),
          }
        : null,
    sourceParentId
      ? sourceParentAffordancesQuery.isFetching && sourceParentAffordancesQuery.data
        ? {
            id: 'move-source-permissions',
            message: 'Checking move permissions…',
            pending: true,
            retry: () =>
              retryPermissionCheck(
                desktopQueryKeys.gfsAffordances(sessionScope, sourceParentId, drive),
                () => sourceParentAffordancesQuery.refetch()
              ),
          }
        : sourceParentAffordancesQuery.error
          ? {
              id: 'move-source-permissions',
              message: `Could not verify move permissions: ${describeGfsReadError(sourceParentAffordancesQuery.error).message}`,
              pending: false,
              retry: () =>
                retryPermissionCheck(
                  desktopQueryKeys.gfsAffordances(sessionScope, sourceParentId, drive),
                  () => sourceParentAffordancesQuery.refetch()
                ),
            }
          : null
      : null,
  ].filter((notice): notice is NonNullable<typeof notice> => notice !== null)

  const grantsQuery = useQuery({
    queryKey: desktopQueryKeys.gfsGrants(sessionScope, resourceId || gfsUri, drive),
    queryFn: () => window.clerum.gfs.listGrants(resourceId, drive),
    enabled: Boolean(canResolve && shareOpen && canShare && resourceId),
  })
  const sharesQuery = useQuery({
    queryKey: desktopQueryKeys.gfsShares(sessionScope, resourceId || gfsUri, drive),
    queryFn: () => window.clerum.gfs.listShares(resourceId, drive),
    enabled: Boolean(canResolve && shareOpen && canShare && resourceId),
  })
  const inheritedQuery = useQuery({
    queryKey: desktopQueryKeys.gfsInheritedAccess(sessionScope, resourceId || gfsUri, drive),
    queryFn: () => deriveGfsInheritedAccess(resourceId, drive),
    enabled: Boolean(canResolve && shareOpen && canShare && resourceId),
  })
  const inheritedAccessNotice = inheritedQuery.error
    ? INHERITED_ACCESS_ERROR_NOTICE
    : inheritedQuery.data?.coverage === 'read-boundary'
      ? INHERITED_READ_BOUNDARY_NOTICE
      : inheritedQuery.data?.coverage === 'acl-limited'
        ? INHERITED_ACL_LIMITED_NOTICE
        : inheritedQuery.data?.coverage === 'unavailable'
          ? INHERITED_COVERAGE_UNAVAILABLE_NOTICE
          : null
  const inheritedAccessNoticeHint =
    !inheritedQuery.error && inheritedQuery.data?.coverage === 'read-boundary'
      ? INHERITED_READ_BOUNDARY_HINT
      : null
  const teamsQuery = useQuery({
    queryKey: desktopQueryKeys.teamsDirectory,
    queryFn: () => window.clerum.team.directory(),
    enabled: Boolean(canResolve && shareOpen && canShare),
  })
  const agentsQuery = useQuery({
    queryKey: desktopQueryKeys.myAgents,
    queryFn: () => window.clerum.agents.listMine(),
    enabled: Boolean(canResolve && shareOpen && canShare),
  })

  const teams = useMemo(
    () => teamSubjectOptions(teamsQuery.data as TeamDirectoryResult | undefined),
    [teamsQuery.data]
  )
  const agents = useMemo(
    () => agentSubjectOptions(agentsQuery.data as AgentWithMcpServers[] | undefined),
    [agentsQuery.data]
  )
  const shareSubjects = useMemo(() => subjectOptions(teams, agents), [agents, teams])
  const invalidateResource = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: desktopQueryKeys.gfsRoot })
  }, [queryClient])
  const invalidateResourceForSession = useCallback(
    async (scope: string) => {
      await queryClient.invalidateQueries({
        queryKey: [...desktopQueryKeys.gfsRoot, scope],
      })
    },
    [queryClient]
  )

  useEffect(() => {
    if (resourceQuery.error) onAuthorityFailure(errorMessage(resourceQuery.error))
  }, [onAuthorityFailure, resourceQuery.error])
  useEffect(() => {
    if (affordancesQuery.error) onAuthorityFailure(errorMessage(affordancesQuery.error))
  }, [affordancesQuery.error, onAuthorityFailure])
  useEffect(() => {
    if (sourceParentAffordancesQuery.error) {
      onAuthorityFailure(errorMessage(sourceParentAffordancesQuery.error))
    }
  }, [onAuthorityFailure, sourceParentAffordancesQuery.error])
  useEffect(() => {
    for (const error of [grantsQuery.error, sharesQuery.error, inheritedQuery.error]) {
      if (error) onAuthorityFailure(errorMessage(error))
    }
  }, [grantsQuery.error, inheritedQuery.error, onAuthorityFailure, sharesQuery.error])

  useEffect(() => {
    moveRequestRef.current += 1
    setMovePermissionStatus(null)
    setMutationPending(false)
    setShareOpen(false)
    setRenameOpen(false)
    setMoveOpen(false)
    setDeleteOpen(false)
    setRenameName(fileName)
  }, [fileName, gfsUri])

  const previousMoveScopeRef = useRef(sessionScope)
  const moveRequestAtRender = moveRequestRef.current
  useEffect(() => {
    if (previousMoveScopeRef.current === sessionScope) return
    previousMoveScopeRef.current = sessionScope
    if (moveRequestRef.current !== moveRequestAtRender) return
    moveRequestRef.current += 1
    setMovePermissionStatus(null)
    setMutationPending(false)
    setMoveOpen(false)
  }, [moveRequestAtRender, sessionScope])

  useEffect(() => {
    if (canResolve) return
    setShareOpen(false)
    setRenameOpen(false)
    setMoveOpen(false)
    setDeleteOpen(false)
  }, [canResolve])

  useEffect(() => {
    if (!shareOpen && !renameOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || mutationPending) return
      setShareOpen(false)
      setRenameOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [mutationPending, renameOpen, shareOpen])

  const runMutation = useCallback(
    async (operation: () => Promise<void>, successMessage: string, failurePrefix: string) => {
      setMutationPending(true)
      try {
        await operation()
        await invalidateResource()
        pushToast?.(successMessage, 'success')
        return true
      } catch (error) {
        if (!onAuthorityFailure(errorMessage(error))) {
          pushToast?.(`${failurePrefix}: ${describeGfsReadError(error).message}`, 'error')
        }
        return false
      } finally {
        setMutationPending(false)
      }
    },
    [invalidateResource, onAuthorityFailure, pushToast]
  )

  const requireAffordancePermissions = async (
    targetResourceId: string,
    targetName: string,
    requiredBits: string[],
    refetch: () => Promise<ResourceAffordances>,
    canPerform?: (authority: ResourceAffordances) => boolean,
    deniedMessage?: string
  ) => {
    if (!sessionScope || !targetResourceId) return false
    const requestedContext = moveContextRef.current
    const queryKey = desktopQueryKeys.gfsAffordances(sessionScope, targetResourceId, drive)
    const queryState = queryClient.getQueryState(queryKey)
    const cachedAuthority = queryState?.data as ResourceAffordances | undefined
    const cachedAuthorityIsFresh = Boolean(
      queryState?.status === 'success' &&
      queryState.fetchStatus === 'idle' &&
      cachedAuthority &&
      !queryState.isInvalidated &&
      Date.now() - queryState.dataUpdatedAt < GFS_AUTHORITY_STALE_TIME_MS
    )
    let authority: ResourceAffordances | undefined
    try {
      if (cachedAuthorityIsFresh) {
        authority = cachedAuthority
      } else {
        assertGfsAuthorityRetryAllowed(queryClient, queryKey)
        authority = await refetch()
      }
    } catch (error) {
      if (!onAuthorityFailure(errorMessage(error))) {
        pushToast?.(
          `Could not verify permissions for ${targetName}: ${describeGfsReadError(error).message}`,
          'error'
        )
      }
      return false
    }

    const currentContext = moveContextRef.current
    if (
      currentContext.gfsUri !== requestedContext.gfsUri ||
      currentContext.sessionScope !== requestedContext.sessionScope ||
      currentContext.resourceId !== requestedContext.resourceId ||
      currentContext.parentResourceId !== requestedContext.parentResourceId ||
      currentContext.drive !== requestedContext.drive ||
      currentContext.version !== requestedContext.version ||
      !authority
    ) {
      return false
    }

    const missingBits = requiredBits.filter(bit => !authority.held.includes(bit))
    if (missingBits.length > 0 || (canPerform && !canPerform(authority))) {
      const labels = missingBits.map(bit => (bit === 'manage_acl' ? 'manage' : bit))
      const required = labels.length > 0 ? labels.join(' and ') : 'the required'
      pushToast?.(deniedMessage ?? `You do not have ${required} access to ${targetName}.`, 'error')
      return false
    }
    return true
  }

  const requireResourcePermissions = (
    requiredBits: string[],
    canPerform?: (a: ResourceAffordances) => boolean,
    deniedMessage?: string
  ) => {
    if (!resource) return Promise.resolve(false)
    return requireAffordancePermissions(
      resource.resourceId,
      resource.name,
      requiredBits,
      async () => {
        const result = await affordancesQuery.refetch({ cancelRefetch: false })
        if (result.isError || !result.data) {
          throw result.error ?? new Error('Could not verify file permissions.')
        }
        return result.data
      },
      canPerform,
      deniedMessage
    )
  }

  const requireMoveSourcePermissions = () => {
    if (!sourceParentId || !resource) return Promise.resolve(false)
    return requireAffordancePermissions(
      sourceParentId,
      'the source folder',
      ['write', 'delete'],
      async () => {
        const result = await sourceParentAffordancesQuery.refetch({ cancelRefetch: false })
        if (result.isError || !result.data) {
          throw result.error ?? new Error('Could not verify source folder permissions.')
        }
        return result.data
      },
      undefined,
      'You need write and delete access to the source folder to move this file.'
    )
  }

  const handlers = useMemo(
    () => ({
      share: async () => {
        if (
          !canShare ||
          !(await requireResourcePermissions(
            [],
            a => a.canDelegate,
            `You do not have permission to manage access to ${resource?.name ?? fileName}.`
          ))
        ) {
          return
        }
        setShareOpen(true)
      },
      rename: async () => {
        if (!canRename || !(await requireResourcePermissions(['write']))) return
        setRenameName(resource?.name ?? fileName)
        setRenameOpen(true)
      },
      move: async () => {
        if (resource?.kind === 'file' && canMove && (await requireMoveSourcePermissions())) {
          setMoveOpen(true)
        }
      },
      download: () => {
        if (resource?.kind !== 'file' || !canResolve) return
        void saveGfsFileToDisk(gfsUri, resource.name)
          .then(() => pushToast?.(`Downloaded ${resource.name}`, 'success'))
          .catch(error => {
            if (!onAuthorityFailure(errorMessage(error))) {
              pushToast?.(
                `Could not download the file: ${describeGfsReadError(error).message}`,
                'error'
              )
            }
          })
      },
      delete: async () => {
        if (canDelete && (await requireResourcePermissions(['delete']))) setDeleteOpen(true)
      },
    }),
    [
      canDelete,
      canMove,
      canRename,
      canShare,
      canResolve,
      fileName,
      gfsUri,
      onAuthorityFailure,
      pushToast,
      resource,
      requireMoveSourcePermissions,
      requireResourcePermissions,
    ]
  )

  const handleRename = async () => {
    if (!resource || renamePendingRef.current) return
    renamePendingRef.current = true
    setMutationPending(true)
    try {
      const name = await normalizeGfsResourceName(renameName.trim())
      if (name === resource.name) {
        setRenameOpen(false)
        return
      }
      if (!(await requireResourcePermissions(['write']))) return
      const renamed = await runMutation(
        () =>
          window.clerum.gfs
            .renameResource(resource.resourceId, name, resource.drive, resource.version)
            .then(() => undefined),
        `Renamed to ${name}`,
        'Could not rename the file'
      )
      if (renamed) {
        setRenameOpen(false)
        onRenameCommitted?.(gfsUri)
      }
    } catch (error) {
      if (!onAuthorityFailure(errorMessage(error))) {
        pushToast?.(`Could not rename the file: ${describeGfsReadError(error).message}`, 'error')
      }
    } finally {
      renamePendingRef.current = false
      setMutationPending(false)
    }
  }

  const handleMove = async (
    destinationId: string,
    destinationName: string,
    executeMove = true,
    isDialogCurrent?: () => boolean
  ) => {
    if (!resource || !sourceParentId) return
    if (isDialogCurrent && !isDialogCurrent()) return
    const requestId = ++moveRequestRef.current
    const moveContext = {
      gfsUri,
      sessionScope,
      principalScope,
      resourceId: resource.resourceId,
      parentResourceId: sourceParentId,
      drive: resource.drive,
      version: resource.version,
    }
    const sourceName = resource.name
    const isActiveMove = () => moveRequestRef.current === requestId
    const clearStaleMovePresentation = () => {
      if (!isActiveMove()) return
      setMovePermissionStatus(null)
      if (!isDialogCurrent || isDialogCurrent()) setMoveOpen(false)
    }
    let sessionGeneration: number | null = null
    const isCurrentSessionGeneration = async () => {
      if (sessionGeneration === null) return false
      try {
        return (await window.clerum.auth.getSessionGeneration()) === sessionGeneration
      } catch {
        return false
      }
    }
    // Authorization is tied to the exact source snapshot until dispatch. After
    // dispatch, a competing move may legitimately advance its parent/version;
    // only a different Preview or principal should fence this result.
    const hasCurrentMoveContext = () => {
      const current = moveContextRef.current
      return (
        current.gfsUri === moveContext.gfsUri &&
        current.sessionScope === moveContext.sessionScope &&
        current.resourceId === moveContext.resourceId &&
        current.parentResourceId === moveContext.parentResourceId &&
        current.drive === moveContext.drive &&
        current.version === moveContext.version
      )
    }
    const hasCurrentMovePresentationContext = () => {
      const current = moveContextRef.current
      return (
        current.gfsUri === moveContext.gfsUri && current.sessionScope === moveContext.sessionScope
      )
    }
    setMovePermissionStatus('checking')
    setMutationPending(true)
    let mutationDispatched = false
    let permissionsChecked = false
    try {
      const capturedSessionGeneration = await window.clerum.auth.getSessionGeneration()
      if (!Number.isSafeInteger(capturedSessionGeneration) || capturedSessionGeneration < 0) {
        throw new Error('invalid_session_generation')
      }
      sessionGeneration = capturedSessionGeneration
      assertGfsAuthorityRetryAllowed(
        queryClient,
        desktopQueryKeys.gfsAffordances(
          moveContext.sessionScope,
          moveContext.parentResourceId,
          moveContext.drive
        )
      )
      assertGfsAuthorityRetryAllowed(
        queryClient,
        desktopQueryKeys.gfsAffordances(moveContext.sessionScope, destinationId, moveContext.drive)
      )
      const sourceCheck = await sourceParentAffordancesQuery.refetch({ cancelRefetch: false })
      if (!(await isCurrentSessionGeneration())) {
        clearStaleMovePresentation()
        return
      }
      if (!isActiveMove()) return
      if (isDialogCurrent && !isDialogCurrent()) {
        setMovePermissionStatus(null)
        return
      }
      if (!hasCurrentMoveContext()) {
        throw new Error(
          'Move was not started because the workspace changed; review the destination.'
        )
      }
      if (sourceCheck.isError || !sourceCheck.data) {
        throw sourceCheck.error ?? new Error('Could not verify source folder permissions.')
      }
      if (!hasGfsMoveSourcePermissions(sourceCheck.data.held)) {
        throw new Error('You do not have write and delete access to the source folder.')
      }
      const destinationAffordances = await queryClient.fetchQuery({
        queryKey: desktopQueryKeys.gfsAffordances(
          moveContext.sessionScope,
          destinationId,
          moveContext.drive
        ),
        queryFn: () => window.clerum.gfs.affordances(destinationId, moveContext.drive),
        staleTime: 0,
        retry: false,
      })
      if (!(await isCurrentSessionGeneration())) {
        clearStaleMovePresentation()
        return
      }
      if (!isActiveMove()) return
      if (isDialogCurrent && !isDialogCurrent()) {
        setMovePermissionStatus(null)
        return
      }
      if (!hasCurrentMoveContext()) {
        throw new Error(
          'Move was not started because the workspace changed; review the destination.'
        )
      }
      if (!destinationAffordances.held.includes('write')) {
        throw new Error('You do not have write access to the destination folder.')
      }
      permissionsChecked = true
      if (!executeMove) {
        setMovePermissionStatus(null)
        return
      }
      const outcome = await commitGfsMove(
        {
          resolveSource: async sourceUri => {
            const resolved = await window.clerum.gfs.resolve(sourceUri)
            return {
              resourceId: resolved.resourceId,
              gfsUri: sourceUri,
              kind: resolved.kind === 'directory' ? 'directory' : 'file',
              name: resolved.name,
              version: resolved.version,
              parentResourceId: resolved.parentResourceId,
            }
          },
          moveResource: (resourceId, targetId, ifMatch) => {
            mutationDispatched = true
            return window.clerum.gfs.moveResource(
              resourceId,
              targetId,
              moveContext.drive,
              ifMatch,
              undefined,
              capturedSessionGeneration
            )
          },
          isSessionAuthorityFailure: error => {
            const message = errorMessage(error)
            if (moveContextRef.current.sessionScope !== moveContext.sessionScope) {
              return isGfsSessionAuthorityFailure(message, 'operation')
            }
            return onAuthorityFailure(message)
          },
          isSessionGenerationCurrent: isCurrentSessionGeneration,
          isCurrent: () =>
            previewMountedRef.current &&
            isActiveMove() &&
            hasCurrentMoveContext() &&
            (!isDialogCurrent || isDialogCurrent()),
        },
        {
          source: {
            resourceId: moveContext.resourceId,
            gfsUri: moveContext.gfsUri,
            kind: 'file',
            name: resource.name,
          },
          destination: { resourceId: destinationId, name: destinationName },
          expectedSourceSnapshot: {
            resourceId: moveContext.resourceId,
            version: moveContext.version,
            parentResourceId: moveContext.parentResourceId,
          },
          sessionGeneration: capturedSessionGeneration,
        }
      )

      if (!(await isCurrentSessionGeneration())) {
        clearStaleMovePresentation()
        return
      }
      if (outcome.status === 'committed') {
        if (
          moveContext.principalScope !== null &&
          moveContextRef.current.principalScope === moveContext.principalScope
        ) {
          try {
            await invalidateResourceForSession(moveContext.sessionScope)
          } catch {
            // A failed follow-up read cannot downgrade the confirmed Move.
          }
        }
        if (!(await isCurrentSessionGeneration())) {
          clearStaleMovePresentation()
          return
        }
        if (!previewMountedRef.current || !hasCurrentMovePresentationContext()) return
        if (isActiveMove() && (!isDialogCurrent || isDialogCurrent())) setMoveOpen(false)
        toastMoveOutcome(pushToast, outcome, sourceName, destinationName, 'file')
        return
      }

      if (outcome.status === 'session-lost') {
        if (isActiveMove() && (!isDialogCurrent || isDialogCurrent())) {
          setMoveOpen(false)
          setMovePermissionStatus(null)
        }
        return
      }
      if (outcome.status === 'gesture-lost') {
        if (
          isActiveMove() &&
          hasCurrentMovePresentationContext() &&
          (!isDialogCurrent || isDialogCurrent())
        ) {
          throw new Error(
            'This item changed while you were moving it. Review its current location and try again.'
          )
        }
        return
      }
      if (!previewMountedRef.current || !hasCurrentMovePresentationContext()) return

      if (isActiveMove() && (!isDialogCurrent || isDialogCurrent())) {
        throw new Error(outcome.message)
      }
      toastMoveOutcome(pushToast, outcome, sourceName, destinationName, 'file')
    } catch (error) {
      if (!(await isCurrentSessionGeneration())) {
        clearStaleMovePresentation()
        return
      }
      if (!mutationDispatched) {
        if (!isActiveMove()) return
        if (isDialogCurrent && !isDialogCurrent()) {
          setMovePermissionStatus(null)
          return
        }
        if (onAuthorityFailure(errorMessage(error))) {
          setMoveOpen(false)
          setMovePermissionStatus(null)
        } else {
          setMovePermissionStatus(permissionsChecked ? null : 'failed')
          throw error
        }
        return
      }
      if (!previewMountedRef.current || !hasCurrentMovePresentationContext()) return
      if (onAuthorityFailure(errorMessage(error))) {
        if (isActiveMove() && (!isDialogCurrent || isDialogCurrent())) {
          setMoveOpen(false)
          setMovePermissionStatus(null)
        }
      } else if (isActiveMove() && (!isDialogCurrent || isDialogCurrent())) {
        setMovePermissionStatus(permissionsChecked ? null : 'failed')
        throw error
      } else {
        pushToast?.(
          `Could not move ${resource.name} to ${destinationName}: ${describeGfsReadError(error).message}`,
          'error'
        )
      }
    } finally {
      if (isActiveMove()) {
        setMutationPending(false)
      }
    }
  }

  const handleDelete = async () => {
    if (!resource || deletePendingRef.current) return
    deletePendingRef.current = true
    setMutationPending(true)
    try {
      if (!(await requireResourcePermissions(['delete']))) return
      const deleted = await runMutation(
        () =>
          window.clerum.gfs
            .deleteResource(resource.resourceId, resource.drive, resource.version)
            .then(() => undefined),
        `Deleted ${resource.name}`,
        'Could not delete the file'
      )
      if (deleted) {
        setDeleteOpen(false)
        onDeleted()
      }
    } finally {
      deletePendingRef.current = false
      setMutationPending(false)
    }
  }

  const handleGrant = async (subjectKeys: string[], bits: string[]) => {
    if (
      !resource ||
      !affordances ||
      affordancesQuery.isFetching ||
      affordancesQuery.isError ||
      !affordances.canDelegate
    ) {
      return
    }
    try {
      await window.clerum.gfs.grant(resource.resourceId, subjectKeys, bits, resource.drive, false)
      await Promise.all([grantsQuery.refetch(), sharesQuery.refetch(), inheritedQuery.refetch()])
      pushToast?.(
        `Access granted to ${subjectKeys.length} ${subjectKeys.length === 1 ? 'subject' : 'subjects'}`,
        'success'
      )
    } catch (error) {
      if (!onAuthorityFailure(errorMessage(error))) {
        pushToast?.(describeGfsGrantError(error).message, 'error')
      }
      throw error
    }
  }

  const handleRevokeGrant = async (item: GfsGrantListItem, label: string) => {
    setRevokingGrantId(item.id)
    try {
      await window.clerum.gfs.revokeGrant(item.id)
      await grantsQuery.refetch()
      pushToast?.(`Access revoked for ${label}`, 'success')
    } catch (error) {
      if (!onAuthorityFailure(errorMessage(error))) {
        pushToast?.(describeGfsGrantError(error).message, 'error')
      }
    } finally {
      setRevokingGrantId(null)
    }
  }

  const handleRevokeShare = async (item: GfsShareListItem, label: string) => {
    setRevokingShareId(item.id)
    try {
      await window.clerum.gfs.revokeShare(item.id)
      await sharesQuery.refetch()
      pushToast?.(`Shared access revoked for ${label}`, 'success')
    } catch (error) {
      if (!onAuthorityFailure(errorMessage(error))) {
        pushToast?.(describeGfsGrantError(error).message, 'error')
      }
    } finally {
      setRevokingShareId(null)
    }
  }

  const handleAccessRoleChange = async (
    item: GfsGrantListItem,
    label: string,
    role: GfsAccessRole
  ) => {
    if (!resource || !affordances) return
    const host = item.subject.type === 'host'
    const requestedBits =
      role === 'editor'
        ? host
          ? ['read', 'write']
          : ['read', 'write', 'delete', 'manage_acl', 'share']
        : host
          ? ['read']
          : ['read', 'share']
    const bits = requestedBits.filter(bit => affordances.grantableBits.includes(bit))
    if (bits.length === 0) return
    const subjectKey = item.subject.id
      ? `${item.subject.type}:${item.subject.id}`
      : item.subject.type
    try {
      await window.clerum.gfs.grant(
        resource.resourceId,
        [subjectKey],
        bits,
        resource.drive,
        item.inherit
      )
      await Promise.all([grantsQuery.refetch(), sharesQuery.refetch(), inheritedQuery.refetch()])
      pushToast?.(`${label} is now ${role === 'editor' ? 'an Editor' : 'Read-only'}`, 'success')
    } catch (error) {
      if (!onAuthorityFailure(errorMessage(error))) {
        pushToast?.(describeGfsGrantError(error).message, 'error')
      }
    }
  }

  const dialogs = (
    <>
      {canResolve && shareOpen && resource ? (
        <div
          className="da-gfs-manage-modal"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget) setShareOpen(false)
          }}
        >
          <section
            className="da-gfs-manage-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`Share file ${resource.name}`}
          >
            <header className="da-gfs-manage-dialog__header">
              <span className="da-gfs-manage-dialog__icon" aria-hidden="true">
                <IconShare />
              </span>
              <span className="da-gfs-manage-dialog__heading">
                <h3>Share “{resource.name}”</h3>
              </span>
              <IconButton
                autoFocus
                label="Close share dialog"
                onClick={() => setShareOpen(false)}
                size="sm"
                variant="ghost"
              >
                <IconClose />
              </IconButton>
            </header>
            <div className="da-gfs-manage-dialog__body">
              <section className="da-gfs-manage-section da-gfs-manage-section--access">
                <div className="da-gfs-manage-section__header">
                  <div>
                    <h4>Add people, teams, or agents</h4>
                  </div>
                </div>
                <GfsDelegationPanel
                  affordances={sharePermissionAffordances}
                  permissionPending={affordancesQuery.isFetching}
                  permissionError={sharePermissionError}
                  subjectOptions={shareSubjects}
                  subjectOptionsLoading={teamsQuery.isFetching || agentsQuery.isFetching}
                  subjectOptionsError={
                    [teamsQuery.error, agentsQuery.error]
                      .filter(Boolean)
                      .map(errorMessage)
                      .join(' · ') || null
                  }
                  isDirectory={false}
                  onGrant={handleGrant}
                />
              </section>
              <section className="da-gfs-manage-section da-gfs-manage-section--grants">
                <div className="da-gfs-manage-section__header">
                  <div>
                    <h4>People with access</h4>
                  </div>
                </div>
                <GfsGrantList
                  agents={agents}
                  derivationNotice={inheritedAccessNotice}
                  derivationNoticeHint={inheritedAccessNoticeHint}
                  error={grantsQuery.error ? describeGfsGrantError(grantsQuery.error) : null}
                  inheritedItems={inheritedQuery.data?.items ?? []}
                  items={grantsQuery.data ?? []}
                  loading={
                    grantsQuery.isFetching || sharesQuery.isFetching || inheritedQuery.isFetching
                  }
                  mergeInherited
                  onChangeRole={handleAccessRoleChange}
                  onRevoke={handleRevokeGrant}
                  onRevokeShare={handleRevokeShare}
                  revoking={revokingGrantId !== null}
                  revokingShare={revokingShareId !== null}
                  shareError={sharesQuery.error ? describeGfsGrantError(sharesQuery.error) : null}
                  shares={sharesQuery.data ?? []}
                  subjects={teams}
                />
              </section>
            </div>
          </section>
        </div>
      ) : null}
      {canResolve && renameOpen && resource ? (
        <div
          className="da-gfs-manage-modal"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget && !mutationPending) setRenameOpen(false)
          }}
        >
          <form
            aria-label="Rename file"
            className="da-gfs-manage-dialog da-gfs-preview-rename"
            role="dialog"
            aria-modal="true"
            onSubmit={event => {
              event.preventDefault()
              void handleRename()
            }}
          >
            <header className="da-gfs-manage-dialog__header">
              <span className="da-gfs-manage-dialog__heading">
                <h3>Rename “{resource.name}”</h3>
              </span>
              <IconButton
                disabled={mutationPending}
                label="Close rename dialog"
                onClick={() => setRenameOpen(false)}
                size="sm"
                variant="ghost"
              >
                <IconClose />
              </IconButton>
            </header>
            <div className="da-gfs-manage-dialog__body">
              <TextInput
                aria-label="New name"
                autoFocus
                value={renameName}
                onChange={event => setRenameName(event.currentTarget.value)}
              />
              <div className="confirm-dialog-actions">
                <Button
                  disabled={mutationPending}
                  onClick={() => setRenameOpen(false)}
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button disabled={!renameName.trim()} loading={mutationPending} type="submit">
                  Save
                </Button>
              </div>
            </div>
          </form>
        </div>
      ) : null}
      {canResolve && moveOpen && resource?.kind === 'file' ? (
        <GfsMoveDialog
          target={{
            resourceId: resource.resourceId,
            name: resource.name,
            kind: 'file',
            parentResourceId: resource.parentResourceId,
          }}
          sessionScope={sessionScope}
          initialCrumbs={[]}
          onMove={(destinationId, destinationName) => handleMove(destinationId, destinationName)}
          onRetryPermissionCheck={(destinationId, destinationName, isCurrent) =>
            handleMove(destinationId, destinationName, false, isCurrent)
          }
          onClose={() => {
            moveRequestRef.current += 1
            setMovePermissionStatus(null)
            setMutationPending(false)
            setMoveOpen(false)
          }}
          busy={mutationPending}
          permissionStatus={movePermissionStatus}
          onAuthorityFailure={onAuthorityFailure}
        />
      ) : null}
      {canResolve && deleteOpen && resource ? (
        <ConfirmDialog
          body="The file will be deleted for everyone with access."
          confirmLabel="Delete"
          onCancel={() => setDeleteOpen(false)}
          onConfirm={() => handleDelete()}
          title={`Delete ${resource.name}?`}
          tone="danger"
        />
      ) : null}
    </>
  )

  return {
    handlers,
    dialogs,
    permissionNotices,
    canShare,
    canRename,
    canMove,
    canDownload: Boolean(resource?.kind === 'file' && canResolve),
    canDelete,
    mutating: mutationPending,
  }
}
