import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { isEditorGfsPermissions, planGfsInheritedRoleChange } from '@clerum/gfs-interaction-policy'
import { Button, IconButton, StatusBanner } from '@components/Common'
import { GfsFileIcon } from '@components/GfsFileIcon'
import { IconClose, IconContexts } from '@components/SidebarNav/icons'
import { GFS_DRIVE_MAIN } from '@constants/gfsBrowser'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useGfsResourceAccess } from '@hooks/domain/useGfsResourceAccess'
import { describeGfsGrantError } from '@lib/gfsGrantErrors'
import { GfsGrantList } from '@/gfs/GfsGrantList'
import type { GfsAccessRole } from '@/gfs/GfsGrantList'
import type { GfsMergedAccessRow } from '@/gfs/GfsGrantList/types'
import { GfsInheritedAccessDialog } from '@/gfs/GfsInheritedAccessDialog'
import {
  type GfsAgentSubjectOption,
  GfsDelegationPanel,
  type GfsDelegationSubjectOption,
  type GfsGrantListItem,
} from '@/gfs/delegation'
import type { GfsInheritedAccessSource, GfsInheritedCoverageState } from '@/gfs/delegation.types'
import type { Tone } from '@/uiTypes'
import type { TeamDirectoryResult } from '../../../src/types'
import type { GfsManageAccessDialogProps, MyAgentEntry } from './manageAccessDialog.types'
import { bindGfsActionGuards } from './resourceActionRunners'

/** Maps a permission set onto the Share dialog's two roles (Editor > Read). */
function roleForAccessPermissions(permissions: string[]): GfsAccessRole {
  return permissions.some(permission => ['write', 'delete', 'manage_acl'].includes(permission))
    ? 'editor'
    : 'read'
}
/** The permission set a role stands for: hosts cap at read/write. */
function rolePermissionRequest(subjectType: string, role: GfsAccessRole): string[] {
  if (subjectType === 'host') return role === 'editor' ? ['read', 'write'] : ['read']
  return role === 'editor' ? ['read', 'write', 'delete', 'manage_acl', 'share'] : ['read', 'share']
}

/** ["a", "b", "c"] → "a, b and c" — folder names for honest outcome toasts. */
function joinFolderNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

const INHERITED_DERIVATION_NOTICE =
  'Inherited access could not be loaded. Members with access from a parent folder may be missing.'
// R1-H3 coverage notices (permissions.md T1 / inherited-permissions spec §7):
// a privacy boundary and an ACL-limited ancestor are normal states, not load
// failures, so they must not wear the failure notice above — and vice versa.
const INHERITED_READ_BOUNDARY_NOTICE = 'There may be access from parent folders you cannot see.'
const INHERITED_READ_BOUNDARY_HINT =
  'Some folders above this one are not visible to you. People may still have access through them, but we cannot show who.'
const INHERITED_ACL_LIMITED_NOTICE =
  'Sharing details on some parent folders are not visible to you.'

/**
 * A role promise is only as good as the coverage it was made under: when the
 * inherited walk did not complete, an ancestor the user cannot see may still
 * grant a stronger role. The success copy then states what was NOT verified
 * instead of promising an effective role the client never proved.
 *
 * The Desktop's role copy carries no trailing period, so the qualifier
 * brings its own.
 */
function inheritedCoverageCaveat(coverage: GfsInheritedCoverageState | null): string {
  if (coverage === 'complete') return ''
  if (coverage === 'read-boundary') {
    return '. Access through parent folders you cannot see was not verified.'
  }
  if (coverage === 'acl-limited') {
    return '. Access through some parent folders was not verified because their sharing details are not visible to you.'
  }
  return '. Inherited access could not be verified, so access through parent folders you cannot see may still be stronger.'
}

/**
 * Folders whose SHARING entries still grant Editor after a downgrade (R1-M5):
 * a role change rewrites the folder's GRANT row only, so a share row survives
 * it and the member keeps Editor through it. The confirmation discloses these
 * BEFORE the user approves; the post-change toast repeats the disclosure.
 */
function collectResidualEditorFolderNames(
  sources: readonly GfsInheritedAccessSource[],
  directShares: readonly { permissions: string[] }[],
  directName: string
): string[] {
  return [
    ...new Set([
      ...sources
        .filter(source =>
          source.shareEntries.some(entry => isEditorGfsPermissions(entry.permissions))
        )
        .map(source => source.name),
      ...(directShares.some(share => isEditorGfsPermissions(share.permissions))
        ? [directName]
        : []),
    ]),
  ]
}

function delegationSubjectOptions(
  directory: TeamDirectoryResult | undefined
): GfsDelegationSubjectOption[] {
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

function agentSubjectOptions(agents: MyAgentEntry[] | undefined): GfsAgentSubjectOption[] {
  if (!agents) return []
  const options = new Map<string, GfsAgentSubjectOption>()
  for (const agent of agents) {
    // Only agents with a canonical host gfsSubject are grantable targets.
    if (agent.gfsSubject?.type !== 'host' || !agent.gfsSubject.id) continue
    options.set(agent.gfsSubject.id, { id: agent.gfsSubject.id, name: agent.name })
  }
  return [...options.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function pickErrorMessage(error: unknown): string | null {
  if (!error) return null
  return error instanceof Error ? error.message : String(error)
}

function mergeErrorMessages(...errors: unknown[]): string | null {
  const messages = errors.map(pickErrorMessage).filter((value): value is string => Boolean(value))
  return messages.length > 0 ? messages.join(' · ') : null
}

/**
 * Share dialog for one explicit resource: who has access (direct, shared and
 * inherited from parent folders) and the grant, role and removal writes. It
 * reads and writes the target it was opened with, never a browser location.
 */
export function GfsManageAccessDialog({
  target,
  isCurrent,
  deps,
  pushToast,
  onClose,
}: GfsManageAccessDialogProps) {
  const access = useGfsResourceAccess(target, deps.gate, {
    handleAuthorityFailure: deps.handleAuthorityFailure,
  })
  const { affordances, affordancesError, loadingAffordances, revalidateAffordances } = access
  const isFolder = target.kind === 'directory'
  const [shareDetailsOpen, setShareDetailsOpen] = useState(false)
  const [updatingAccessRole, setUpdatingAccessRole] = useState(false)
  // Pending parent-folder confirmation (role change or removal) for a member
  // whose file access is inherited from ancestor folders. change-role carries
  // the split plan's affected grant-backed folders (R1-M5: each rewritten
  // with its OWN scope flag; share rows never touched), each with the bits
  // the pre-flight validated on that folder itself, plus the share-only
  // editor sources (residual access) and any unknown-scope folders skipped
  // rather than written with a defaulted scope.
  const [parentUpdate, setParentUpdate] = useState<
    | {
        row: GfsMergedAccessRow
        label: string
        mode: 'change-role'
        nextRole: GfsAccessRole
        updates: Array<{ source: GfsInheritedAccessSource; bits: string[] }>
        residualSources: GfsInheritedAccessSource[]
        skippedFolderNames: string[]
        /** Folders whose sharing entries still grant Editor after the change. */
        residualEditorFolderNames: string[]
      }
    | { row: GfsMergedAccessRow; label: string; mode: 'remove' }
    | null
  >(null)

  // A write that has not started must not start once the dialog is gone: the
  // user dismissed the target it was about.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const isCurrentRef = useRef(isCurrent)
  isCurrentRef.current = isCurrent
  const bindGuards = () => {
    const session = {
      readAccessState: deps.readAccessState,
      publishedGeneration: deps.publishedGeneration,
    }
    const action = bindGfsActionGuards({
      ...session,
      isCurrent: () => mountedRef.current && isCurrentRef.current(),
    })
    // The outcome of a write that already ran is still worth reporting after
    // the dialog closes, but never into another session: by the time the
    // write settles, main may run another team the renderer has not published.
    const outcome = action && bindGfsActionGuards(session)
    if (!action || !outcome) return null
    const presentOutcome = async (message: string, tone: Tone) => {
      if (!pushToast || !(await outcome.admitEffect())) return
      pushToast(message, tone)
    }
    return { ...action, presentOutcome }
  }

  // Opening Share on a target re-reads its authority once; later renders must
  // not keep re-reading it.
  const revalidateAffordancesRef = useRef(revalidateAffordances)
  revalidateAffordancesRef.current = revalidateAffordances
  useEffect(() => {
    void revalidateAffordancesRef.current()
  }, [target.resourceId])

  const teamDirectoryQuery = useQuery({
    queryKey: desktopQueryKeys.teamsDirectory,
    queryFn: () => window.clerum.team.directory(),
    enabled: Boolean(affordances?.canDelegate),
  })
  const delegationSubjects = useMemo(
    () => delegationSubjectOptions(teamDirectoryQuery.data),
    [teamDirectoryQuery.data]
  )
  // MY agents (with canonical gfsSubject) feed both the agent grant section
  // and grant-list label resolution.
  const myAgentsQuery = useQuery({
    queryKey: desktopQueryKeys.myAgents,
    queryFn: () => window.clerum.agents.listMine(),
  })
  const agentSubjects = useMemo(() => agentSubjectOptions(myAgentsQuery.data), [myAgentsQuery.data])
  // Unified grant-subject list: people + teams (team directory) and the caller's
  // own agents (canonical host subjects). Agents are badge-labelled and capped to
  // read/write inside GfsDelegationPanel when present in the selection.
  const grantSubjectOptions = useMemo<GfsDelegationSubjectOption[]>(
    () => [
      ...delegationSubjects,
      ...agentSubjects.map(agent => ({
        type: 'host' as const,
        id: agent.id,
        label: agent.name,
        description: 'Agent',
        badge: 'Agent',
      })),
    ],
    [agentSubjects, delegationSubjects]
  )
  const grantsError = useMemo(
    () => (access.grantsError ? describeGfsGrantError(access.grantsError) : null),
    [access.grantsError]
  )
  const sharesError = useMemo(
    () => (access.sharesError ? describeGfsGrantError(access.sharesError) : null),
    [access.sharesError]
  )
  // A failed list is not an empty one: it is shown as an error with a way to
  // read it again. A quiet manage_acl_required verdict is a state, not a failure.
  const listLoadFailed = grantsError?.severity === 'error' || sharesError?.severity === 'error'
  // An incomplete inherited derivation becomes a quiet notice: an empty derived
  // list alone would silently read as "no one else has access" (R1-M3). R1-H3:
  // rows folded before a walk stop are still rendered — the notice only
  // discloses what is missing, choosing accurate copy per coverage state.
  const inheritedAccessNotice = access.inheritedAccessError
    ? INHERITED_DERIVATION_NOTICE
    : access.inheritedCoverage === 'read-boundary'
      ? INHERITED_READ_BOUNDARY_NOTICE
      : access.inheritedCoverage === 'acl-limited'
        ? INHERITED_ACL_LIMITED_NOTICE
        : access.inheritedCoverage === 'unavailable'
          ? INHERITED_DERIVATION_NOTICE
          : null
  const inheritedAccessNoticeHint =
    !access.inheritedAccessError && access.inheritedCoverage === 'read-boundary'
      ? INHERITED_READ_BOUNDARY_HINT
      : null

  // The parent-folder confirmation is the top-most dialog: Escape cancels it
  // alone and leaves the Share dialog open.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const parentUpdateOpen = parentUpdate !== null
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (parentUpdateOpen) setParentUpdate(null)
      else onCloseRef.current()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [parentUpdateOpen])

  // One atomic bulk grant for every selected subject — the server grants all or
  // none (a `subjects_invalid` rejects the whole request), so there is no
  // partial-success outcome. People, teams, and agents share a single picker;
  // agents are capped to read/write inside the panel. Inherit is honored for
  // directories (default ON) and forced false for files.
  const handleGrant = async (
    subjectKeys: string[],
    bits: string[],
    inherit: boolean,
    isDraftCurrent: () => boolean
  ) => {
    const guards = bindGuards()
    if (
      !guards ||
      !(await deps.freshPermissions(target.resourceId, target.name, ['manage_acl'], bits)) ||
      !isDraftCurrent() ||
      !(await guards.admitEffect())
    ) {
      return
    }
    try {
      await access.grant(target, subjectKeys, bits, inherit)
    } catch (grantError) {
      if (deps.failClosed(grantError)) return
      throw grantError
    }
    if (isDraftCurrent()) {
      await guards.presentOutcome(
        `Access granted to ${subjectKeys.length} ${subjectKeys.length === 1 ? 'subject' : 'subjects'}`,
        'success'
      )
    }
    // The grant PUT returns no ids — list-after-write is the revoke-id source.
    await access.refreshGrants()
  }

  const handleRevokeGrant = async (grantId: string, label: string) => {
    const guards = bindGuards()
    if (
      !guards ||
      !(await deps.freshPermissions(target.resourceId, target.name, ['manage_acl'])) ||
      !(await guards.admitEffect())
    ) {
      return
    }
    try {
      await access.revokeGrant(target, grantId)
    } catch (revokeError) {
      if (deps.failClosed(revokeError)) return
      await guards.presentOutcome(describeGfsGrantError(revokeError).message, 'error')
      return
    }
    await guards.presentOutcome(`Access revoked for ${label}`, 'success')
  }

  const handleRevokeShare = async (shareId: string, label: string) => {
    const guards = bindGuards()
    if (
      !guards ||
      !(await deps.freshPermissions(target.resourceId, target.name, ['manage_acl'])) ||
      !(await guards.admitEffect())
    ) {
      return
    }
    try {
      await access.revokeShare(target, shareId)
    } catch (revokeError) {
      if (deps.failClosed(revokeError)) return
      await guards.presentOutcome(describeGfsGrantError(revokeError).message, 'error')
      return
    }
    await guards.presentOutcome(`Shared access revoked for ${label}`, 'success')
  }

  const handleAccessRoleChange = async (
    item: GfsGrantListItem,
    label: string,
    role: GfsAccessRole
  ) => {
    const guards = bindGuards()
    if (!guards) return
    const freshAuthority = await deps.fetchAuthority(target.resourceId, target.name)
    if (!freshAuthority) return
    if (!freshAuthority.held?.includes('manage_acl')) {
      pushToast?.(`You do not have manage access to ${target.name}.`, 'error')
      return
    }
    const bits = rolePermissionRequest(item.subject.type, role).filter(bit =>
      freshAuthority.grantableBits.includes(bit)
    )
    const subjectKey = item.subject.id
      ? `${item.subject.type}:${item.subject.id}`
      : item.subject.type
    setUpdatingAccessRole(true)
    try {
      if (!(await guards.admitEffect())) return
      await access.grant(target, [subjectKey], bits, item.inherit)
      await guards.presentOutcome(
        `${label} is now ${role === 'editor' ? 'an Editor' : 'Read-only'}${inheritedCoverageCaveat(
          access.inheritedCoverage
        )}`,
        'success'
      )
      await Promise.all([access.refreshGrants(), access.refreshShares()])
    } catch (roleError) {
      if (deps.failClosed(roleError)) return
      await guards.presentOutcome(describeGfsGrantError(roleError).message, 'error')
    } finally {
      setUpdatingAccessRole(false)
    }
  }

  // A merged row whose access comes from parent folders: any edit (upgrade,
  // downgrade, or removal — no exceptions) is confirmed against the affected
  // folders before anything is sent. Cancel reverts the dropdown untouched.
  const handleInheritedRoleChange = async (
    row: GfsMergedAccessRow,
    label: string,
    role: GfsAccessRole
  ) => {
    const inherited = row.inherited
    if (!inherited) return
    const subject = inherited.subject
    // N1: the dropdown displays the MERGED effective role (direct ⊔
    // inherited). Re-selecting the already-displayed role is a no-op —
    // comparing it against the inherited-only floor instead would open the
    // parent-update modal and escalate the parent folder for a non-change.
    if (role === roleForAccessPermissions(row.permissions)) return
    // R1-M5 split plan: grant-backed folders are rewritten with their OWN
    // scope flag; share-only sources are never converted into grants or
    // deleted (residual access survives and is disclosed). Folders whose own
    // scope flag is unknown are never written with a defaulted scope.
    const plan = planGfsInheritedRoleChange(inherited, role === 'editor')
    const writable = plan.grantSources.filter(source => typeof source.grantInherit === 'boolean')
    const skippedFolderNames = plan.grantSources
      .filter(source => typeof source.grantInherit !== 'boolean')
      .map(source => source.name)
    if (writable.length === 0) {
      if (row.grant) {
        // Direct-grant-only alignment keeps the existing confirmation path.
        setParentUpdate({
          row,
          label,
          mode: 'change-role',
          nextRole: role,
          updates: [],
          residualSources: plan.shareOnlySources,
          skippedFolderNames,
          residualEditorFolderNames:
            role === 'read'
              ? collectResidualEditorFolderNames(plan.shareOnlySources, row.shares, target.name)
              : [],
        })
        return
      }
      if (skippedFolderNames.length > 0) {
        pushToast?.(
          `Sharing details on ${joinFolderNames(skippedFolderNames)} could not be verified; existing access was kept.`,
          'error'
        )
        return
      }
      // Nothing writable anywhere: explain the surviving share access.
      if (plan.shareOnlySources.length > 0 || row.shares.length > 0) {
        pushToast?.(
          `${label} still has ${roleForAccessPermissions(row.permissions) === 'editor' ? 'Editor' : 'Read-only'} access from sharing entries that can't be edited here.`,
          'info'
        )
      }
      return
    }
    // Pre-flight: every affected folder's grant is judged by THAT folder's
    // own grantable bits, never by the open file's affordances (which may be
    // missing or narrower). A role a folder cannot grant fails loudly here —
    // the confirmation never opens with a promise it cannot keep.
    const updates: Array<{ source: GfsInheritedAccessSource; bits: string[] }> = []
    for (const source of writable) {
      let folderAffordances: { canDelegate: boolean; grantableBits: string[] }
      try {
        folderAffordances = await window.clerum.gfs.affordances(source.resourceId, GFS_DRIVE_MAIN)
      } catch (affordancesError) {
        if (deps.failClosed(affordancesError)) return
        pushToast?.(describeGfsGrantError(affordancesError).message, 'error')
        return
      }
      const bits = rolePermissionRequest(subject.type, role).filter(bit =>
        folderAffordances.grantableBits.includes(bit)
      )
      const expressesRole =
        role === 'editor' ? bits.includes('read') && bits.includes('write') : bits.includes('read')
      if (!folderAffordances.canDelegate || !expressesRole) {
        pushToast?.(
          `Your access on ${source.name} does not allow making ${label} ${role === 'editor' ? 'an Editor' : 'Read-only'}.`,
          'error'
        )
        return
      }
      updates.push({ source, bits })
    }
    setParentUpdate({
      row,
      label,
      mode: 'change-role',
      nextRole: role,
      updates,
      residualSources: plan.shareOnlySources,
      skippedFolderNames,
      // The surviving Editor shares are disclosed IN the confirmation, before
      // the user approves a role that will not remove them.
      residualEditorFolderNames:
        role === 'read'
          ? collectResidualEditorFolderNames(
              [...plan.shareOnlySources, ...writable],
              row.shares,
              target.name
            )
          : [],
    })
  }

  const handleInheritedRemove = (row: GfsMergedAccessRow, label: string) => {
    setParentUpdate({ row, label, mode: 'remove' })
  }

  const confirmParentUpdate = async () => {
    const request = parentUpdate
    const inherited = request?.row.inherited
    if (!request || !inherited) {
      setParentUpdate(null)
      return
    }
    const sources = inherited.sources
    const [firstSource] = sources
    const subject = inherited.subject
    const subjectKey = subject.id ? `${subject.type}:${subject.id}` : subject.type
    const label = request.label
    setParentUpdate(null)
    setUpdatingAccessRole(true)
    // Partial-failure honesty (R1-H1): the confirm issues several sequential
    // calls; the first failure stops the run, refreshes both lists so the
    // dialog shows the TRUE partial state, and the toast says exactly how far
    // the change got. Full success is never claimed on partial completion.
    const failPartially = async (updateError: unknown, summary: string) => {
      if (deps.failClosed(updateError)) return
      pushToast?.(`${summary} (${describeGfsGrantError(updateError).message})`, 'error')
      await Promise.all([
        access.refreshGrants(),
        access.refreshInheritedAccess(),
        access.refreshShares(),
      ])
    }
    try {
      if (request.mode === 'remove') {
        let removed = 0
        for (const source of sources) {
          try {
            if (source.grantId) await access.revokeGrant(target, source.grantId)
            for (const shareId of source.shareIds) await access.revokeShare(target, shareId)
            removed += 1
          } catch (updateError) {
            await failPartially(
              updateError,
              `Removed from ${removed} of ${sources.length} folders — ${source.name} still grants access`
            )
            return
          }
        }
        // The file's own direct rows are aligned with the removal.
        if (request.row.grant || request.row.shares.length > 0) {
          try {
            if (request.row.grant) await access.revokeGrant(target, request.row.grant.id)
            for (const share of request.row.shares) await access.revokeShare(target, share.id)
          } catch (updateError) {
            await failPartially(
              updateError,
              `Removed from ${sources.length} of ${sources.length} folders — direct access on ${target.name} could not be removed`
            )
            return
          }
        }
        pushToast?.(
          sources.length === 1
            ? `Access removed on ${firstSource?.name ?? target.name} and everything inside it`
            : `Access removed on ${sources.length} folders and everything inside them`,
          'success'
        )
        await Promise.all([
          access.refreshGrants(),
          access.refreshInheritedAccess(),
          access.refreshShares(),
        ])
        return
      }
      const updates = request.updates
      const affectedNames = updates.map(update => update.source.name)
      let updated = 0
      for (const { source, bits } of updates) {
        try {
          // Each affected folder's grant is updated with the bits the
          // pre-flight validated on that folder, preserving the GRANT ROW'S
          // OWN scope flag (R1-M5 — the pre-flight guaranteed a known
          // boolean). The folder's share rows are never touched by a role
          // change; they survive as residual access and are disclosed below.
          await window.clerum.gfs.grant(
            source.resourceId,
            [subjectKey],
            bits,
            GFS_DRIVE_MAIN,
            source.grantInherit === true
          )
          updated += 1
        } catch (updateError) {
          await failPartially(
            updateError,
            `Updated ${updated} of ${updates.length} folders — ${source.name} still grants access`
          )
          return
        }
      }
      const partialMessages: string[] = []
      if (request.skippedFolderNames.length > 0) {
        partialMessages.push(
          `Updated ${updated} of ${updates.length + request.skippedFolderNames.length} folders. Sharing details on ${joinFolderNames(request.skippedFolderNames)} could not be verified; existing access was kept.`
        )
      }
      // The file's own direct GRANT is aligned so it cannot mask the
      // confirmed role (R1-M5: a share-only direct row never gains a grant,
      // direct shares survive role edits, and unknown/empty direct authority
      // keeps the direct grant with an honest partial copy).
      if (request.row.grant) {
        try {
          const fileBits = rolePermissionRequest(subject.type, request.nextRole).filter(bit =>
            access.affordances?.grantableBits.includes(bit)
          )
          const expressesRole =
            fileBits.includes('read') && (request.nextRole === 'read' || fileBits.includes('write'))
          if (expressesRole) {
            await access.grant(target, [subjectKey], fileBits, request.row.grant.inherit)
          } else {
            // N2 (R1-M5): an empty bit set means the file's affordances are
            // unavailable (or grant nothing) — keep the direct grant AND its
            // shares and say so; removing rights on an authority guess was
            // the defect.
            partialMessages.push(
              `Updated ${updated} of ${updates.length} folders — direct access on ${target.name} could not be fully aligned`
            )
          }
        } catch (updateError) {
          await failPartially(
            updateError,
            `Updated ${updates.length} of ${updates.length} folders — direct access on ${target.name} could not be fully aligned`
          )
          return
        }
      }
      // Residual honesty (R1-M5): a downgrade never claims effective
      // Read-only while a surviving share entry still grants Editor.
      const residualNames =
        request.nextRole === 'read'
          ? collectResidualEditorFolderNames(
              [...request.residualSources, ...updates.map(update => update.source)],
              request.row.shares,
              target.name
            )
          : []
      const residualMessage =
        residualNames.length > 0
          ? `Sharing entries on ${joinFolderNames(residualNames)} still grant Editor access.`
          : ''
      if (partialMessages.length > 0) {
        pushToast?.([...partialMessages, residualMessage].filter(Boolean).join(' '), 'error')
      } else if (residualMessage) {
        pushToast?.(
          `Changed grant access to ${request.nextRole === 'editor' ? 'Editor' : 'Read-only'} on ${affectedNames.length > 0 ? joinFolderNames(affectedNames) : target.name}. ${residualMessage}`,
          'info'
        )
      } else {
        pushToast?.(
          affectedNames.length > 0
            ? `${label} is now ${request.nextRole === 'editor' ? 'an Editor' : 'Read-only'} on ${joinFolderNames(affectedNames)} and everything inside ${affectedNames.length > 1 ? 'them' : 'it'}${inheritedCoverageCaveat(access.inheritedCoverage)}`
            : `${label} is now ${request.nextRole === 'editor' ? 'an Editor' : 'Read-only'} on ${target.name}${inheritedCoverageCaveat(access.inheritedCoverage)}`,
          'success'
        )
      }
      await Promise.all([
        access.refreshGrants(),
        access.refreshInheritedAccess(),
        access.refreshShares(),
      ])
    } finally {
      setUpdatingAccessRole(false)
    }
  }

  return (
    <>
      <div
        className="da-gfs-manage-modal"
        role="presentation"
        onMouseDown={event => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        <section
          className="da-gfs-manage-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={`Share ${isFolder ? 'folder' : 'file'} ${target.name}`}
        >
          <header className="da-gfs-manage-dialog__header">
            <span
              className={`da-gfs-manage-dialog__icon${isFolder ? ' da-gfs-manage-dialog__icon--folder' : ''}`}
              aria-hidden="true"
            >
              {isFolder ? <IconContexts /> : <GfsFileIcon name={target.name} />}
            </span>
            <span className="da-gfs-manage-dialog__heading">
              <h3>Share “{target.name}”</h3>
            </span>
            <span className="da-gfs-manage-dialog__top-actions">
              <IconButton
                autoFocus
                label="Close share dialog"
                onClick={onClose}
                size="sm"
                variant="ghost"
              >
                <IconClose />
              </IconButton>
            </span>
          </header>

          <div className="da-gfs-manage-dialog__body">
            <section className="da-gfs-manage-section da-gfs-manage-section--access">
              <div className="da-gfs-manage-section__header">
                <div>
                  <h4>Add people, teams, agents, or workflows</h4>
                </div>
              </div>
              {affordancesError ? <StatusBanner tone="error" text={affordancesError} /> : null}
              {affordances ? (
                <GfsDelegationPanel
                  affordances={affordances}
                  permissionPending={loadingAffordances}
                  permissionCheckPending={loadingAffordances}
                  permissionCheckFailed={Boolean(affordancesError)}
                  subjectOptions={grantSubjectOptions}
                  subjectOptionsLoading={teamDirectoryQuery.isFetching || myAgentsQuery.isFetching}
                  subjectOptionsError={mergeErrorMessages(
                    teamDirectoryQuery.error,
                    myAgentsQuery.error
                  )}
                  isDirectory={isFolder}
                  onGrant={handleGrant}
                  onDetailViewChange={setShareDetailsOpen}
                />
              ) : loadingAffordances ? (
                <p className="muted" role="status">
                  Refreshing permissions…
                </p>
              ) : null}
            </section>

            {!shareDetailsOpen ? (
              <section className="da-gfs-manage-section da-gfs-manage-section--grants">
                <div className="da-gfs-manage-section__header">
                  <div>
                    <h4>People with access</h4>
                  </div>
                  {listLoadFailed ? (
                    <Button
                      loading={access.loadingGrants || access.loadingShares}
                      onClick={() => void access.retry()}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Retry
                    </Button>
                  ) : null}
                </div>
                <GfsGrantList
                  agents={agentSubjects}
                  derivationNotice={inheritedAccessNotice}
                  derivationNoticeHint={inheritedAccessNoticeHint}
                  error={grantsError}
                  inheritedItems={access.inheritedAccess}
                  items={access.grants}
                  loading={
                    access.loadingGrants || access.loadingShares || access.loadingInheritedAccess
                  }
                  // FILES AND FOLDERS merge inherited rows (the reported
                  // folder bug); the dialog itself only opens with a target.
                  mergeInherited
                  onChangeInheritedRole={handleInheritedRoleChange}
                  onChangeRole={affordances?.canDelegate ? handleAccessRoleChange : undefined}
                  onRemoveInherited={handleInheritedRemove}
                  onRevoke={(item, label) => void handleRevokeGrant(item.id, label)}
                  onRevokeShare={(item, label) => void handleRevokeShare(item.id, label)}
                  revoking={access.revoking}
                  revokingShare={access.revokingShare}
                  shareError={sharesError}
                  shares={access.shares}
                  subjects={delegationSubjects}
                  updatingRole={updatingAccessRole}
                />
              </section>
            ) : null}
          </div>
        </section>
      </div>

      <GfsInheritedAccessDialog
        busy={updatingAccessRole}
        request={
          parentUpdate?.row.inherited
            ? {
                mode: parentUpdate.mode,
                memberLabel: parentUpdate.label,
                fileName: target.name,
                // Removal touches every contributing folder; a role change
                // touches only the R1-H1 plan's affected folders.
                folders:
                  parentUpdate.mode === 'remove'
                    ? parentUpdate.row.inherited.sources.map(source => ({
                        resourceId: source.resourceId,
                        name: source.name,
                        currentRole: roleForAccessPermissions(source.permissions),
                      }))
                    : parentUpdate.updates.map(update => ({
                        resourceId: update.source.resourceId,
                        name: update.source.name,
                        currentRole: roleForAccessPermissions(update.source.permissions),
                      })),
                fileCurrentRole: roleForAccessPermissions(parentUpdate.row.permissions),
                nextRole: parentUpdate.mode === 'change-role' ? parentUpdate.nextRole : undefined,
                // The surviving Editor shares are disclosed BEFORE the user
                // approves: the effective role this dialog shows is not the
                // whole truth, and only the post-change toast used to say so.
                ...(parentUpdate.mode === 'change-role' &&
                parentUpdate.residualEditorFolderNames.length > 0
                  ? { residualEditorFolderNames: parentUpdate.residualEditorFolderNames }
                  : {}),
              }
            : null
        }
        onCancel={() => setParentUpdate(null)}
        onConfirm={() => void confirmParentUpdate()}
      />
    </>
  )
}
