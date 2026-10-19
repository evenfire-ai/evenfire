import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { normalizeGfsResourceName } from '@clerum/gfs-interaction-policy'
import { Button, IconButton, TextInput } from '@components/Common'
import { ConfirmDialog } from '@components/ConfirmDialog'
import { IconClose, IconShare } from '@components/SidebarNav/icons'
import { GFS_DRIVE_MAIN } from '@constants/gfsBrowser'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { saveGfsFileToDisk } from '@lib/gfsDownload'
import { describeGfsGrantError, describeGfsReadError } from '@lib/gfsGrantErrors'
import { GfsGrantList } from '@/gfs/GfsGrantList'
import type { GfsAccessRole } from '@/gfs/GfsGrantList'
import {
  type GfsAgentSubjectOption,
  GfsDelegationPanel,
  type GfsDelegationSubjectOption,
} from '@/gfs/delegation'
import type { GfsGrantListItem, GfsShareListItem } from '@/gfs/delegation.types'
import { deriveGfsInheritedAccess } from '@/gfs/inheritedAccess'
import { GfsMoveDialog } from '@/gfs/moveDialog'
import type { AgentWithMcpServers, TeamDirectoryResult } from '../../../src/types'

type ResourceAffordances = Awaited<ReturnType<typeof window.clerum.gfs.affordances>>

type FilePreviewResourceActionsProps = {
  gfsUri: string
  fileName: string
  sessionScope: string
  canResolve: boolean
  onAuthorityFailure: (message: string) => boolean
  onDeleted: () => void
  pushToast?: (message: string, tone: 'success' | 'error') => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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
  canResolve,
  onAuthorityFailure,
  onDeleted,
  pushToast,
}: FilePreviewResourceActionsProps) {
  const queryClient = useQueryClient()
  const [shareOpen, setShareOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [renameName, setRenameName] = useState(fileName)
  const [mutationPending, setMutationPending] = useState(false)
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null)
  const [revokingShareId, setRevokingShareId] = useState<string | null>(null)
  const deletePendingRef = useRef(false)

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
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  })
  const affordances: ResourceAffordances | undefined = affordancesQuery.isError
    ? undefined
    : affordancesQuery.data
  const canShare = Boolean(canResolve && affordances?.canDelegate)
  const canRename = Boolean(canResolve && affordances?.held.includes('write'))
  const canDelete = Boolean(canResolve && affordances?.held.includes('delete'))

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

  useEffect(() => {
    if (resourceQuery.error) onAuthorityFailure(errorMessage(resourceQuery.error))
  }, [onAuthorityFailure, resourceQuery.error])
  useEffect(() => {
    if (affordancesQuery.error) onAuthorityFailure(errorMessage(affordancesQuery.error))
  }, [affordancesQuery.error, onAuthorityFailure])
  useEffect(() => {
    for (const error of [grantsQuery.error, sharesQuery.error, inheritedQuery.error]) {
      if (error) onAuthorityFailure(errorMessage(error))
    }
  }, [grantsQuery.error, inheritedQuery.error, onAuthorityFailure, sharesQuery.error])

  useEffect(() => {
    setShareOpen(false)
    setRenameOpen(false)
    setMoveOpen(false)
    setDeleteOpen(false)
    setRenameName(fileName)
  }, [fileName, gfsUri])

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

  const handlers = useMemo(
    () => ({
      share: () => setShareOpen(true),
      rename: () => {
        if (!canRename) return
        setRenameName(resource?.name ?? fileName)
        setRenameOpen(true)
      },
      move: () => {
        if (resource?.kind === 'file' && canResolve) setMoveOpen(true)
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
      delete: () => {
        if (canDelete) setDeleteOpen(true)
      },
    }),
    [canDelete, canRename, canResolve, fileName, gfsUri, onAuthorityFailure, pushToast, resource]
  )

  const handleRename = async () => {
    if (!resource) return
    try {
      const name = await normalizeGfsResourceName(renameName.trim())
      if (name === resource.name) {
        setRenameOpen(false)
        return
      }
      const renamed = await runMutation(
        () =>
          window.clerum.gfs
            .renameResource(resource.resourceId, name, resource.drive, resource.version)
            .then(() => undefined),
        `Renamed to ${name}`,
        'Could not rename the file'
      )
      if (renamed) setRenameOpen(false)
    } catch (error) {
      if (!onAuthorityFailure(errorMessage(error))) {
        pushToast?.(`Could not rename the file: ${describeGfsReadError(error).message}`, 'error')
      }
    }
  }

  const handleMove = async (destinationId: string, destinationName: string) => {
    if (!resource) return
    setMutationPending(true)
    try {
      await window.clerum.gfs.moveResource(
        resource.resourceId,
        destinationId,
        resource.drive,
        resource.version
      )
      await invalidateResource()
      setMoveOpen(false)
      pushToast?.(`Moved ${resource.name} to ${destinationName}`, 'success')
    } catch (error) {
      if (onAuthorityFailure(errorMessage(error))) setMoveOpen(false)
      else throw error
    } finally {
      setMutationPending(false)
    }
  }

  const handleDelete = async () => {
    if (!resource || deletePendingRef.current) return
    deletePendingRef.current = true
    const deleted = await runMutation(
      () =>
        window.clerum.gfs
          .deleteResource(resource.resourceId, resource.drive, resource.version)
          .then(() => undefined),
      `Deleted ${resource.name}`,
      'Could not delete the file'
    )
    deletePendingRef.current = false
    if (deleted) {
      setDeleteOpen(false)
      onDeleted()
    }
  }

  const handleGrant = async (subjectKeys: string[], bits: string[]) => {
    if (!resource) return
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
      {canResolve && shareOpen && resource && affordances?.canDelegate ? (
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
                  affordances={affordances}
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
                  derivationNotice={
                    inheritedQuery.error
                      ? 'Some access inherited from parent folders could not be loaded.'
                      : null
                  }
                  error={grantsQuery.error ? describeGfsGrantError(grantsQuery.error) : null}
                  inheritedItems={inheritedQuery.data ?? []}
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
          onMove={handleMove}
          onClose={() => setMoveOpen(false)}
          busy={mutationPending}
          onAuthorityFailure={onAuthorityFailure}
        />
      ) : null}
      {canResolve && deleteOpen && resource ? (
        <ConfirmDialog
          body="The file will be deleted for everyone with access."
          confirmLabel="Delete"
          onCancel={() => setDeleteOpen(false)}
          onConfirm={() => void handleDelete()}
          title={`Delete ${resource.name}?`}
          tone="danger"
        />
      ) : null}
    </>
  )

  return {
    handlers,
    dialogs,
    canShare,
    canRename,
    canMove: Boolean(resource?.kind === 'file' && canResolve),
    canDownload: Boolean(resource?.kind === 'file' && canResolve),
    canDelete,
    mutating: mutationPending,
  }
}
