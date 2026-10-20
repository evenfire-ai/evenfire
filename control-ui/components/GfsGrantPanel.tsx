'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RecordList, RecordListRow, RowActionMenu } from '@clerum/frontend-components'
import { planGfsInheritedRoleChange } from '@clerum/gfs-interaction-policy'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { GfsInheritedAccessDialog } from '@components/GfsInheritedAccessDialog'
import { GfsSubjectPicker } from '@components/GfsSubjectPicker'
import { SelectionDropdown } from '@components/SelectionDropdown'
import type { SelectionDropdownOption } from '@components/SelectionDropdown/types'
import {
  IconFolder,
  IconRobot,
  IconShield,
  IconUser,
  IconUsers,
  IconWorkflow,
} from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { Button, CheckboxField } from '@components/ui'
import { GFS_MAX_BULK_SUBJECTS } from '@constants/gfsGrantSubjects'
import {
  type AdminUser,
  type GfsGrantError,
  type GfsSubjectInput,
  type HostResource,
  type TeamListItem,
  type WorkflowRecipeResource,
  deleteGfsGrant,
  deleteGfsShare,
  getAdminTeams,
  getAdminUsers,
  getGfsGrants,
  getGfsShares,
  getHosts,
  getRecipes,
  putGfsGrant,
} from '@lib/api'
import type {
  GfsExistingAccessItem,
  GfsFileAccessRow,
  GfsGrantPanelProps,
  GfsInheritedAccessCoverage,
  GfsInheritedAccessItem,
  GfsInheritedAccessSource,
} from './GfsGrantPanel.types'
import { buildGfsBulkSubjectOptions, toGfsBulkSubjectInputs } from './gfsGrantSubjectOptions'
import { loadGfsInheritedAccess } from './gfsInheritedAccess'
import { isEditorPermissions } from './gfsInheritedAccessMerge'

/**
 * P4-S07 — Operator delegation panel for the Global File System. The operator
 * (Control UI / Admin-JWT plane) seeds Layer-1/2 grants on a selected resource.
 * Bulk actions accept users, teams, and canonical host subjects; the intrinsic
 * operator remains a singular request. Existing URI shares remain visible and
 * revocable, while share creation is intentionally unavailable in this UI.
 * The existing server-side authority and no-escalation policies remain
 * authoritative.
 */

const OPERATOR_VALUE = 'operator'
const DRIVE = 'main'
type AccessRole = 'read' | 'editor'
type AccessSubjectKind = 'agent' | 'context' | 'operator' | 'team' | 'user' | 'workflow'

function AccessSubjectIcon({ kind }: { kind: AccessSubjectKind }): React.JSX.Element {
  if (kind === 'agent') return <IconRobot />
  if (kind === 'context') return <IconFolder />
  if (kind === 'operator') return <IconShield />
  if (kind === 'team') return <IconUsers />
  if (kind === 'workflow') return <IconWorkflow />
  return <IconUser />
}

function rolePermissions(role: AccessRole, hostOnly: boolean): string[] {
  if (hostOnly) return role === 'editor' ? ['read', 'write'] : ['read']
  return role === 'editor' ? ['read', 'write', 'delete', 'manage_acl', 'share'] : ['read', 'share']
}

function roleForPermissions(permissions: string[]): AccessRole {
  return permissions.some(permission => ['write', 'delete', 'manage_acl'].includes(permission))
    ? 'editor'
    : 'read'
}

function hostOnlySubject(subject: { type: string }): boolean {
  return subject.type === 'host'
}

/** ["a", "b", "c"] → "a, b and c" — folder names for honest outcome toasts. */
function joinFolderNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Stable per-subject merge key. The operator variant carries no id. */
function subjectKey(subject: GfsSubjectInput): string {
  return `${subject.type}:${'id' in subject ? subject.id : ''}`
}

const OPERATOR_OPTION: SelectionDropdownOption = {
  value: OPERATOR_VALUE,
  label: 'Operator',
  description: 'Intrinsic cluster operator',
  badge: 'Operator',
}

const ROLE_OPTIONS: SelectionDropdownOption[] = [
  { value: 'read', label: 'Read' },
  { value: 'editor', label: 'Editor' },
]

/**
 * A role promise is only as good as the coverage it was made under: when the
 * inherited walk did not complete, an ancestor the operator cannot see may
 * still grant a stronger role. The success copy then states what was NOT
 * verified instead of promising an effective role the client never proved.
 *
 * The Control UI's role copy ends with a period, so the qualifier brings only
 * its own leading space.
 */
function inheritedCoverageCaveat(coverage: GfsInheritedAccessCoverage, loading: boolean): string {
  if (!loading && coverage === 'complete') return ''
  if (coverage === 'read-boundary') {
    return ' Access through parent folders you cannot see was not verified.'
  }
  if (coverage === 'acl-limited') {
    return ' Access through some parent folders was not verified because their sharing details are not visible to you.'
  }
  return ' Inherited access could not be verified, so access through parent folders you cannot see may still be stronger.'
}

export function GfsGrantPanel({ resource }: GfsGrantPanelProps): React.JSX.Element {
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [teams, setTeams] = useState<TeamListItem[]>([])
  const [hosts, setHosts] = useState<HostResource[]>([])
  const [recipes, setRecipes] = useState<WorkflowRecipeResource[]>([])
  const [directoryLoading, setDirectoryLoading] = useState(true)
  const [directoryError, setDirectoryError] = useState('')
  const [selectedValues, setSelectedValues] = useState<string[]>([])
  const [selectionError, setSelectionError] = useState('')
  const [role, setRole] = useState<AccessRole>('read')
  const [includeDescendants, setIncludeDescendants] = useState(resource.kind === 'directory')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [existingAccess, setExistingAccess] = useState<GfsExistingAccessItem[]>([])
  const [existingAccessLoading, setExistingAccessLoading] = useState(true)
  const [existingAccessError, setExistingAccessError] = useState('')
  const existingAccessRequest = useRef(0)
  const existingAccessController = useRef<AbortController | null>(null)
  // Inherited access is derived separately: it comes from ancestor folders,
  // not from this resource's direct grant/share rows. Files and folders use
  // the same retaining walk, with explicit incomplete-coverage feedback.
  const [inheritedAccess, setInheritedAccess] = useState<GfsInheritedAccessItem[]>([])
  const [inheritedAccessLoading, setInheritedAccessLoading] = useState(true)
  const [inheritedAccessCoverage, setInheritedAccessCoverage] =
    useState<GfsInheritedAccessCoverage>('complete')
  const inheritedAccessFailed = inheritedAccessCoverage !== 'complete'
  const inheritedAccessNotice =
    inheritedAccessCoverage === 'read-boundary'
      ? 'There may be access from parent folders you cannot see.'
      : inheritedAccessCoverage === 'acl-limited'
        ? 'Sharing details on some parent folders are not visible to you.'
        : 'Inherited access could not be loaded. Members with access from a parent folder may be missing.'
  // Native tooltip explaining the read-boundary notice in plain language.
  const inheritedAccessNoticeTitle =
    inheritedAccessCoverage === 'read-boundary'
      ? 'Some folders above this one are not visible to you. People may still have access through them, but we cannot show who.'
      : undefined
  const inheritedAccessRequest = useRef(0)
  const inheritedAccessController = useRef<AbortController | null>(null)
  // Pending parent-folder confirmation (role change or removal) for a member
  // whose access is inherited from ancestor folders. change-role carries the
  // affected folders from the R1-H1 plan (downgrade: every folder above the
  // target role; upgrade: the single strongest folder).
  const [parentUpdate, setParentUpdate] = useState<
    | {
        row: GfsFileAccessRow
        mode: 'change-role'
        nextRole: AccessRole
        affected: Array<{ source: GfsInheritedAccessSource; permissions: string[] }>
        /** Editor share-only sources excluded from writes (residual access). */
        residualSources: GfsInheritedAccessSource[]
        /** Grant-backed folders skipped because their own scope flag was
         * unknown — never written with a defaulted scope (R1-M5). */
        skippedFolderNames: string[]
      }
    | { row: GfsFileAccessRow; mode: 'remove' }
    | null
  >(null)
  const canIncludeDescendants = resource.kind === 'directory'

  const loadExistingAccess = useCallback(async () => {
    existingAccessController.current?.abort()
    const requestId = ++existingAccessRequest.current
    const controller = new AbortController()
    existingAccessController.current = controller
    setExistingAccessLoading(true)
    setExistingAccessError('')
    try {
      const [grantResult, shareResult] = await Promise.all([
        getGfsGrants(resource.resourceId, DRIVE, controller.signal),
        getGfsShares(resource.resourceId, DRIVE, controller.signal),
      ])
      if (requestId !== existingAccessRequest.current) return
      // Merge per subject: legacy flows could leave the same principal with
      // BOTH a grant and a URI share (rendered as duplicate rows with
      // different toggle semantics). One row per subject, permissions and
      // descendant coverage unioned, both row ids retained for revoke.
      const bySubject = new Map<string, GfsExistingAccessItem>()
      const entryFor = (subject: GfsSubjectInput): GfsExistingAccessItem => {
        const key = subjectKey(subject)
        let entry = bySubject.get(key)
        if (!entry) {
          entry = {
            subject,
            permissions: [],
            inherit: false,
            grantInherit: false,
            grantId: null,
            shareIds: [],
            shareEntries: [],
          }
          bySubject.set(key, entry)
        }
        return entry
      }
      for (const grant of grantResult.items) {
        const entry = entryFor(grant.subject)
        entry.grantId = grant.id
        entry.inherit = entry.inherit || grant.inherit
        // R1-M5: the GRANT row's own scope flag, never OR'd with share
        // coverage — a role write preserves exactly this.
        entry.grantInherit = grant.inherit
        entry.permissions = [...new Set([...entry.permissions, ...grant.permissions])]
      }
      for (const share of shareResult.items) {
        const entry = entryFor(share.subject)
        entry.shareIds.push(share.id)
        entry.inherit = entry.inherit || share.includeDescendants
        // R1-M5: each share row's own bits/scope survive the merge so role
        // edits can disclose residual access truthfully.
        entry.shareEntries.push({
          rowId: share.id,
          permissions: [...share.permissions],
          includeDescendants: share.includeDescendants,
        })
        entry.permissions = [...new Set([...entry.permissions, ...share.permissions])]
      }
      setExistingAccess([...bySubject.values()])
    } catch (caught) {
      if (requestId !== existingAccessRequest.current) return
      setExistingAccessError(
        caught instanceof Error ? caught.message : 'Failed to load existing access'
      )
    } finally {
      if (requestId === existingAccessRequest.current) {
        existingAccessController.current = null
        setExistingAccessLoading(false)
      }
    }
  }, [resource.resourceId])

  useEffect(() => {
    void loadExistingAccess()
    return () => {
      existingAccessController.current?.abort()
      existingAccessController.current = null
      existingAccessRequest.current += 1
    }
  }, [loadExistingAccess])

  const loadInheritedAccess = useCallback(async () => {
    inheritedAccessController.current?.abort()
    const requestId = ++inheritedAccessRequest.current
    setInheritedAccessCoverage('complete')
    // Inherited access is derived for FILES AND FOLDERS: a folder dialog must
    // show the identities its ancestors grant, not an empty list. The walk
    // resolves the canonical path itself when the target carries none.
    const controller = new AbortController()
    inheritedAccessController.current = controller
    setInheritedAccessLoading(true)
    try {
      const result = await loadGfsInheritedAccess(
        { path: resource.path, gfsUri: resource.gfsUri },
        DRIVE,
        controller.signal
      )
      if (requestId !== inheritedAccessRequest.current) return
      setInheritedAccess(result.items)
      setInheritedAccessCoverage(result.coverage)
    } catch {
      if (requestId !== inheritedAccessRequest.current) return
      setInheritedAccess([])
      // Session expiry and cancellation still reject through the existing
      // API/request boundary; never keep protected rows from a failed session.
      setInheritedAccessCoverage('unavailable')
    } finally {
      if (requestId === inheritedAccessRequest.current) {
        inheritedAccessController.current = null
        setInheritedAccessLoading(false)
      }
    }
  }, [resource.gfsUri, resource.path, resource.resourceId])

  useEffect(() => {
    void loadInheritedAccess()
    return () => {
      inheritedAccessController.current?.abort()
      inheritedAccessController.current = null
      inheritedAccessRequest.current += 1
    }
  }, [loadInheritedAccess])

  useEffect(() => {
    let active = true

    async function loadDirectory() {
      setDirectoryLoading(true)
      setDirectoryError('')
      try {
        const [userResult, teamResult, hostResult, recipeResult] = await Promise.allSettled([
          getAdminUsers(''),
          getAdminTeams(),
          getHosts(),
          getRecipes(),
        ])
        if (!active) return
        const failed: string[] = []
        if (userResult.status === 'fulfilled') setUsers(userResult.value.items ?? [])
        else failed.push('users')
        if (teamResult.status === 'fulfilled') setTeams(teamResult.value.items ?? [])
        else failed.push('teams')
        if (hostResult.status === 'fulfilled') setHosts(hostResult.value.items ?? [])
        else failed.push('agents')
        if (recipeResult.status === 'fulfilled') setRecipes(recipeResult.value.items ?? [])
        else failed.push('workflows')
        if (failed.length === 4) {
          setDirectoryError('Failed to load grant subjects')
        } else if (failed.length > 0) {
          setDirectoryError(`Some grant subjects could not be loaded: ${failed.join(', ')}`)
        }
      } catch (e) {
        if (!active) return
        setDirectoryError(e instanceof Error ? e.message : 'Failed to load grant subjects')
      } finally {
        if (active) setDirectoryLoading(false)
      }
    }

    void loadDirectory()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    setIncludeDescendants(resource.kind === 'directory')
  }, [resource.kind, resource.resourceId])

  const bulkSubjectOptions = useMemo(
    () => buildGfsBulkSubjectOptions({ users, teams, hosts, recipes }),
    [hosts, recipes, teams, users]
  )
  const subjectOptions = useMemo<SelectionDropdownOption[]>(
    () => [...bulkSubjectOptions, OPERATOR_OPTION],
    [bulkSubjectOptions]
  )
  const operatorSelected = selectedValues.includes(OPERATOR_VALUE)
  const selectedBulkOptions = useMemo(
    () =>
      selectedValues
        .map(value => bulkSubjectOptions.find(option => option.value === value))
        .filter(option => option !== undefined),
    [bulkSubjectOptions, selectedValues]
  )
  const selectedSubjects = useMemo(
    () => toGfsBulkSubjectInputs(selectedBulkOptions),
    [selectedBulkOptions]
  )
  const hasHost = selectedSubjects.some(subject => subject.type === 'host')
  const subjectValid = operatorSelected || selectedSubjects.length > 0
  const actionPending = busy
  const bits = rolePermissions(role, hasHost)
  const canSubmit = subjectValid && bits.length > 0 && !actionPending

  function changeSelectedSubjects(nextValues: string[]) {
    const addingOperator = nextValues.includes(OPERATOR_VALUE) && !operatorSelected
    if (addingOperator) {
      setSelectedValues([OPERATOR_VALUE])
      setSelectionError('')
      return
    }

    const bulkValues = nextValues.filter(value => value !== OPERATOR_VALUE)
    if (bulkValues.length > GFS_MAX_BULK_SUBJECTS) {
      setSelectionError(`You can select up to ${GFS_MAX_BULK_SUBJECTS} subjects.`)
      return
    }

    const nextOptions = bulkValues
      .map(value => bulkSubjectOptions.find(option => option.value === value))
      .filter(option => option !== undefined)
    setSelectionError('')
    setSelectedValues(bulkValues)
  }

  async function submit() {
    setError('')
    if (!subjectValid || bits.length === 0) {
      setError('subject_and_permissions_required')
      return
    }

    setBusy(true)
    try {
      if (operatorSelected) {
        const body = {
          drive: DRIVE,
          resourceId: resource.resourceId,
          subject: { type: 'operator' as const },
          permissions: bits,
        }
        await putGfsGrant({ ...body, inherit: includeDescendants })
      } else {
        const body = {
          drive: DRIVE,
          resourceId: resource.resourceId,
          subjects: selectedSubjects,
          permissions: bits,
        }
        await putGfsGrant({ ...body, inherit: includeDescendants })
      }
      showToast('Access shared.', { tone: 'success' })
      await loadExistingAccess()
      setSelectedValues([])
      setRole('read')
      setSelectionError('')
      setIncludeDescendants(resource.kind === 'directory')
    } catch (e) {
      const grantError = e as GfsGrantError
      const verdict = grantError.code
        ? grantError.serverMessage && grantError.serverMessage !== grantError.code
          ? `${grantError.code}: ${grantError.serverMessage}`
          : grantError.code
        : e instanceof Error
          ? e.message
          : String(e)
      const invalidIndexes = grantError.invalidIndexes
      setError(
        invalidIndexes && invalidIndexes.length > 0
          ? `${verdict} (invalid indexes: ${invalidIndexes.join(', ')})`
          : verdict
      )
    } finally {
      setBusy(false)
    }
  }

  const subjectLabel = useCallback(
    (item: { subject: GfsSubjectInput }): string => {
      if (item.subject.type === 'operator') return 'Operator'
      const option = bulkSubjectOptions.find(
        candidate =>
          candidate.subject.type === item.subject.type && candidate.subject.id === item.subject.id
      )
      if (option) return option.label
      if (item.subject.type === 'host') {
        return item.subject.id?.split('/').at(-1) || 'Agent or workflow'
      }
      const typeLabel = item.subject.type.charAt(0).toUpperCase() + item.subject.type.slice(1)
      return item.subject.id ? `${typeLabel} · ${item.subject.id}` : typeLabel
    },
    [bulkSubjectOptions]
  )

  const subjectKind = useCallback(
    (item: { subject: GfsSubjectInput }): AccessSubjectKind => {
      if (item.subject.type !== 'host') return item.subject.type
      const option = bulkSubjectOptions.find(
        candidate =>
          candidate.subject.type === item.subject.type && candidate.subject.id === item.subject.id
      )
      return option?.badge.toLowerCase() === 'workflow' || item.subject.id?.startsWith('3rd:')
        ? 'workflow'
        : 'agent'
    },
    [bulkSubjectOptions]
  )

  const bySubjectLabel = useCallback(
    (left: { subject: GfsSubjectInput }, right: { subject: GfsSubjectInput }): number =>
      subjectLabel(left).localeCompare(subjectLabel(right), undefined, {
        numeric: true,
        sensitivity: 'base',
      }) || subjectKey(left.subject).localeCompare(subjectKey(right.subject)),
    [subjectLabel]
  )

  // Every dialog — file AND folder — dedupes to exactly one row per member
  // across direct grants/shares and inherited ancestor rows; the effective
  // role is the strongest. Folders previously rendered direct-only, which hid
  // the identities their ancestors grant.
  const sortedAccessRows = useMemo<GfsFileAccessRow[]>(() => {
    const bySubjectRow = new Map<string, GfsFileAccessRow>()
    for (const direct of existingAccess) {
      bySubjectRow.set(subjectKey(direct.subject), {
        subject: direct.subject,
        permissions: [...direct.permissions],
        direct,
        inherited: null,
      })
    }
    for (const inherited of inheritedAccess) {
      const key = subjectKey(inherited.subject)
      const existingRow = bySubjectRow.get(key)
      if (existingRow) {
        existingRow.inherited = inherited
        existingRow.permissions = [
          ...new Set([...existingRow.permissions, ...inherited.permissions]),
        ]
      } else {
        bySubjectRow.set(key, {
          subject: inherited.subject,
          permissions: [...inherited.permissions],
          direct: null,
          inherited,
        })
      }
    }
    return [...bySubjectRow.values()].sort(bySubjectLabel)
  }, [bySubjectLabel, existingAccess, inheritedAccess])

  async function revokeAccess(item: GfsExistingAccessItem) {
    const label = subjectLabel(item)
    const confirmed = await confirm({
      title: 'Remove access?',
      message: `Remove access for ${label} from "${resource.name}"?`,
      confirmLabel: 'Remove access',
      tone: 'danger',
    })
    if (!confirmed) return
    setBusy(true)
    setError('')
    try {
      if (item.grantId) await deleteGfsGrant(item.grantId)
      for (const shareId of item.shareIds) await deleteGfsShare(shareId)
      showToast('Access removed.', { tone: 'success' })
      await loadExistingAccess()
    } catch (caught) {
      const accessError = caught as GfsGrantError
      if (
        accessError.status === 404 &&
        (accessError.code === 'grant_not_found' || accessError.code === 'share_not_found')
      ) {
        showToast('Access was already removed.', { tone: 'success' })
        await loadExistingAccess()
        return
      }
      setError(caught instanceof Error ? caught.message : 'Failed to remove access')
    } finally {
      setBusy(false)
    }
  }

  async function updateAccessRole(
    item: GfsExistingAccessItem,
    nextRole: AccessRole,
    inheritedSources: GfsInheritedAccessSource[] = [],
    skippedFolderNames: string[] = []
  ) {
    // R1-M5: role editing never creates a grant. A share-only direct row has
    // no grant to rewrite and there is no share-update surface — refuse with
    // honest feedback instead of converting the share into a grant.
    if (item.grantId === null) {
      showToast(
        `${subjectLabel(item)}'s access comes from a sharing entry that can only be removed, not changed here.`,
        { tone: 'error' }
      )
      return
    }
    const permissions = rolePermissions(nextRole, hostOnlySubject(item.subject))
    setBusy(true)
    setError('')
    try {
      await putGfsGrant({
        drive: DRIVE,
        resourceId: resource.resourceId,
        subject: item.subject,
        permissions,
        // R1-M5: the grant row's OWN scope flag — share coverage is never
        // OR'd into a role write.
        inherit: item.grantInherit,
      })
      // Shares survive role edits (R1-M5); when an editor-strength share
      // remains, the effective role claim must say so.
      const residualNames =
        nextRole === 'read'
          ? [
              ...new Set([
                ...inheritedSources
                  .filter(source =>
                    source.shareEntries.some(entry => isEditorPermissions(entry.permissions))
                  )
                  .map(source => source.name),
                ...(item.shareEntries.some(entry => isEditorPermissions(entry.permissions))
                  ? [resource.name]
                  : []),
              ]),
            ]
          : []
      const details: string[] = []
      if (skippedFolderNames.length > 0) {
        details.push(
          `Sharing details on ${joinFolderNames(skippedFolderNames)} could not be verified; existing access was kept.`
        )
      }
      if (residualNames.length > 0) {
        details.push(
          `Sharing entries on ${joinFolderNames(residualNames)} still grant Editor access.`
        )
      }
      if (details.length > 0) {
        showToast(
          `Changed grant access to ${nextRole === 'editor' ? 'Editor' : 'Read-only'} on ${resource.name}. ${details.join(' ')}`,
          { tone: skippedFolderNames.length > 0 ? 'error' : 'info' }
        )
      } else {
        showToast(
          `${subjectLabel(item)} is now ${nextRole === 'editor' ? 'an Editor' : 'Read-only'}.${inheritedCoverageCaveat(inheritedAccessCoverage, inheritedAccessLoading)}`,
          { tone: 'success' }
        )
      }
      await loadExistingAccess()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to update access')
    } finally {
      setBusy(false)
    }
  }

  /** Concurrent removal already did the work — treat those verdicts as success. */
  function isAlreadyMissing(caught: unknown): boolean {
    const accessError = caught as GfsGrantError
    return (
      accessError.status === 404 &&
      (accessError.code === 'grant_not_found' || accessError.code === 'share_not_found')
    )
  }

  /**
   * Control UI is the operator plane. The backend remains authoritative for
   * ACL enforcement, so this client plans the affected ancestor mutations from
   * the access rows it can already read and lets the server accept or reject
   * each mutation. Per-folder affordance preflight is deferred to the backend
   * contract tracked separately from this PR.
   *
   * R1-M5: the shared split planner separates grant-backed sources (rewritten
   * with their OWN scope flag) from share-only sources (never converted into
   * grants, never deleted — residual access survives and is disclosed).
   */
  async function prepareParentRoleChange(row: GfsFileAccessRow, nextRole: AccessRole) {
    const inherited = row.inherited
    if (!inherited) return
    if (nextRole === roleForPermissions(row.permissions)) return
    const plan = planGfsInheritedRoleChange(inherited, nextRole === 'editor')
    // Unknown own-scope folders are never written (no `?? true` default);
    // they surface through the partial summary at confirm time.
    const writable = plan.grantSources.filter(
      (source): source is GfsInheritedAccessSource & { grantInherit: boolean } =>
        typeof source.grantInherit === 'boolean'
    )
    const skippedFolderNames = plan.grantSources
      .filter(source => typeof source.grantInherit !== 'boolean')
      .map(source => source.name)
    if (writable.length === 0) {
      if (row.direct && row.direct.grantId !== null) {
        await updateAccessRole(row.direct, nextRole, plan.shareOnlySources, skippedFolderNames)
        return
      }
      // Unknown scope and non-editable shares are different reasons to keep access.
      if (skippedFolderNames.length > 0) {
        showToast(
          `Sharing details on ${joinFolderNames(skippedFolderNames)} could not be verified; existing access was kept.`,
          { tone: 'error' }
        )
        return
      }
      // Nothing writable anywhere: explain why nothing changed.
      showToast(
        `${subjectLabel(row)} still has ${roleForPermissions(row.permissions) === 'editor' ? 'Editor' : 'Read-only'} access from sharing entries that can't be edited here.`,
        { tone: 'info' }
      )
      return
    }

    const permissions = rolePermissions(nextRole, hostOnlySubject(row.subject))
    const updates = writable.map(source => ({ source, permissions }))
    setParentUpdate({
      row,
      mode: 'change-role',
      nextRole,
      affected: updates,
      residualSources: plan.shareOnlySources,
      skippedFolderNames,
    })
  }

  /**
   * Confirmed edit of an inherited row (R1-H1 semantics, verified against
   * Google Drive): a removal revokes the member's rows on EVERY contributing
   * ancestor folder; a downgrade lowers every ancestor above the target role;
   * an upgrade raises the strongest ancestor. The file's own direct rows are
   * aligned in every case so they cannot mask the outcome. The confirm issues
   * several sequential calls — on the first failure it stops, refreshes both
   * lists so the dialog shows the TRUE partial state, and the toast says
   * exactly how far the change got. Full success is never claimed on partial
   * completion. Cancel never reaches this path — the dropdown reverts.
   */
  async function confirmParentUpdate() {
    const request = parentUpdate
    if (!request) return
    const row = request.row
    const inherited = row.inherited
    if (!inherited) {
      setParentUpdate(null)
      return
    }
    const sources = inherited.sources
    setParentUpdate(null)
    setBusy(true)
    setError('')
    const reload = async () => {
      await Promise.all([loadExistingAccess(), loadInheritedAccess()])
    }
    /** Partial-failure honesty: state the true outcome, show the server error, reload. */
    const failPartially = async (caught: unknown, summary: string) => {
      if (!isAlreadyMissing(caught)) {
        setError(caught instanceof Error ? caught.message : 'Failed to update access')
      }
      showToast(summary, { tone: 'error' })
      await reload()
    }
    try {
      if (request.mode === 'remove') {
        let removed = 0
        for (const source of sources) {
          try {
            if (source.grantId) await deleteGfsGrant(source.grantId)
            for (const shareId of source.shareIds) await deleteGfsShare(shareId)
            removed += 1
          } catch (caught) {
            if (isAlreadyMissing(caught)) {
              removed += 1
              continue
            }
            await failPartially(
              caught,
              `Removed from ${removed} of ${sources.length} folders — ${source.name} still grants access.`
            )
            return
          }
        }
        if (row.direct) {
          try {
            if (row.direct.grantId) await deleteGfsGrant(row.direct.grantId)
            for (const shareId of row.direct.shareIds) await deleteGfsShare(shareId)
          } catch (caught) {
            if (!isAlreadyMissing(caught)) {
              await failPartially(
                caught,
                `Removed from ${sources.length} of ${sources.length} folders — direct access on ${resource.name} could not be removed.`
              )
              return
            }
          }
        }
        showToast(
          sources.length === 1
            ? `Access removed on ${sources[0].name} and everything inside it.`
            : `Access removed on ${sources.length} folders and everything inside them.`,
          { tone: 'success' }
        )
        await reload()
        return
      }
      const affected = request.affected
      const affectedNames = affected.map(update => update.source.name)
      let updated = 0
      for (const { source, permissions } of affected) {
        try {
          await putGfsGrant({
            drive: DRIVE,
            resourceId: source.resourceId,
            subject: row.subject,
            permissions,
            // R1-M5: the folder grant's OWN scope flag (prepare guaranteed a
            // known boolean) — share coverage is never OR'd in and the
            // folder's share rows are never touched by a role change.
            inherit: source.grantInherit === true,
          })
          updated += 1
        } catch (caught) {
          if (isAlreadyMissing(caught)) {
            updated += 1
            continue
          }
          await failPartially(
            caught,
            `Updated ${updated} of ${affected.length} folders — ${source.name} still grants access.`
          )
          return
        }
      }
      if (row.direct && row.direct.grantId !== null) {
        try {
          const permissions = rolePermissions(request.nextRole, hostOnlySubject(row.subject))
          await putGfsGrant({
            drive: DRIVE,
            resourceId: resource.resourceId,
            subject: row.subject,
            permissions,
            // The direct GRANT's own scope flag; direct shares survive role
            // edits (R1-M5) and a share-only direct row never gains a grant.
            inherit: row.direct.grantInherit,
          })
        } catch (caught) {
          await failPartially(
            caught,
            `Updated ${affected.length} of ${affected.length} folders — direct access on ${resource.name} still shows the old role.`
          )
          return
        }
      }
      // Residual honesty (R1-M5): a downgrade never claims effective
      // Read-only while a surviving share entry still grants Editor.
      const residualNames =
        request.nextRole === 'read'
          ? [
              ...new Set([
                ...[...request.residualSources, ...affected.map(update => update.source)]
                  .filter(source =>
                    source.shareEntries.some(entry => isEditorPermissions(entry.permissions))
                  )
                  .map(source => source.name),
                ...(row.direct?.shareEntries.some(entry => isEditorPermissions(entry.permissions))
                  ? [resource.name]
                  : []),
              ]),
            ]
          : []
      const details: string[] = []
      if (request.skippedFolderNames.length > 0) {
        details.push(
          `Updated ${updated} of ${affected.length + request.skippedFolderNames.length} folders. Sharing details on ${joinFolderNames(request.skippedFolderNames)} could not be verified; existing access was kept.`
        )
      }
      if (residualNames.length > 0) {
        details.push(
          `Sharing entries on ${joinFolderNames(residualNames)} still grant Editor access.`
        )
      }
      if (details.length > 0) {
        showToast(
          `Changed grant access to ${request.nextRole === 'editor' ? 'Editor' : 'Read-only'} on ${affectedNames.length > 0 ? joinFolderNames(affectedNames) : resource.name}. ${details.join(' ')}`,
          { tone: request.skippedFolderNames.length > 0 ? 'error' : 'info' }
        )
      } else {
        showToast(
          affectedNames.length > 0
            ? `${subjectLabel(row)} is now ${request.nextRole === 'editor' ? 'an Editor' : 'Read-only'} on ${joinFolderNames(affectedNames)} and everything inside ${affectedNames.length > 1 ? 'them' : 'it'}.${inheritedCoverageCaveat(inheritedAccessCoverage, inheritedAccessLoading)}`
            : `${subjectLabel(row)} is now ${request.nextRole === 'editor' ? 'an Editor' : 'Read-only'} on ${resource.name}.${inheritedCoverageCaveat(inheritedAccessCoverage, inheritedAccessLoading)}`,
          { tone: 'success' }
        )
      }
      await reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cu-gfs-grant-panel">
      <div
        className={`cu-gfs-grant__composer${subjectValid ? ' cu-gfs-grant__composer--details' : ''}`}
      >
        <GfsSubjectPicker
          disabled={actionPending}
          loading={directoryLoading}
          onChange={changeSelectedSubjects}
          options={subjectOptions}
          value={selectedValues}
        />
        {subjectValid ? (
          <SelectionDropdown
            ariaLabel="Access role for selected recipients"
            className="cu-gfs-role-select"
            disabled={actionPending}
            multiple={false}
            onChange={next => setRole((next[0] ?? 'read') as AccessRole)}
            options={ROLE_OPTIONS}
            placeholder="Role"
            searchable={false}
            showSelectedChips={false}
            value={[role]}
          />
        ) : null}
      </div>
      {selectionError ? (
        <p role="alert" className="cu-field__error">
          {selectionError}
        </p>
      ) : null}
      {directoryError ? (
        <p role="alert" className="cu-field__error">
          {directoryError}
        </p>
      ) : null}
      {subjectValid && hasHost ? (
        <p className="cu-field__hint">Agents, workflows, and plugins use read/write access only.</p>
      ) : null}
      {subjectValid ? (
        <div className="cu-gfs-grant__scope-actions">
          {canIncludeDescendants ? (
            <CheckboxField
              className="cu-gfs-grant__scope"
              label="Include contents of this folder"
              checked={includeDescendants}
              onChange={() => setIncludeDescendants(current => !current)}
              disabled={actionPending}
            />
          ) : null}
          <div className="cu-gfs-grant__actions">
            <Button
              disabled={actionPending}
              onClick={() => {
                setSelectedValues([])
                setRole('read')
                setSelectionError('')
              }}
              variant="ghost"
            >
              Back
            </Button>
            <Button variant="primary" disabled={!canSubmit} onClick={() => submit()}>
              Share
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="cu-field__error">
          {error}
        </p>
      ) : null}
      {!subjectValid ? (
        <section className="cu-gfs-existing-access" aria-label="People with access">
          <div className="cu-gfs-existing-access__header">
            <h4>People with access</h4>
          </div>
          {inheritedAccessFailed ? (
            <p
              role="status"
              className="cu-gfs-existing-access__notice"
              title={inheritedAccessNoticeTitle}
            >
              {inheritedAccessNotice}
            </p>
          ) : null}
          {existingAccessLoading || inheritedAccessLoading ? (
            <p className="cu-gfs-existing-access__empty" role="status">
              Loading access…
            </p>
          ) : existingAccessError ? (
            <div className="cu-gfs-existing-access__error">
              <p role="alert" className="cu-field__error">
                {existingAccessError}
              </p>
              <Button size="sm" disabled={actionPending} onClick={() => void loadExistingAccess()}>
                Retry
              </Button>
            </div>
          ) : existingAccess.length === 0 &&
            inheritedAccess.length === 0 &&
            !inheritedAccessFailed ? (
            <p className="cu-gfs-existing-access__empty">No one has access yet.</p>
          ) : (
            <RecordList className="cu-gfs-existing-access__list" aria-label="Resource access">
              {sortedAccessRows.map(row => {
                const label = subjectLabel(row)
                const kind = subjectKind(row)
                const inherited = row.inherited !== null
                // R1-M5: a share-only direct row has no grant to rewrite and
                // no share-edit surface — the role control stays disabled
                // instead of offering a change that would create a grant.
                const shareOnlyDirect =
                  !inherited && row.direct !== null && row.direct.grantId === null
                return (
                  <RecordListRow
                    className="cu-gfs-existing-access__item"
                    data-testid={`gfs-access-row-${subjectKey(row.subject)}`}
                    data-access-id={row.direct?.grantId ?? row.direct?.shareIds[0]}
                    data-inherited={inherited ? 'true' : undefined}
                    key={`access:${subjectKey(row.subject)}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`cu-gfs-existing-access__avatar cu-gfs-existing-access__avatar--${kind}`}
                      data-subject-kind={kind}
                    >
                      <AccessSubjectIcon kind={kind} />
                    </span>
                    <span className="cu-gfs-existing-access__identity">
                      <span className="cu-gfs-existing-access__subject">{label}</span>
                    </span>
                    <span className="cu-gfs-existing-access__meta">
                      <SelectionDropdown
                        ariaLabel={`Access role for ${label}`}
                        className="cu-gfs-existing-access__role"
                        disabled={actionPending || shareOnlyDirect}
                        multiple={false}
                        onChange={next => {
                          if (!inherited) {
                            void updateAccessRole(
                              row.direct as GfsExistingAccessItem,
                              (next[0] ?? 'read') as AccessRole
                            )
                            return
                          }
                          const nextRole = (next[0] ?? 'read') as AccessRole
                          void prepareParentRoleChange(row, nextRole)
                        }}
                        menuClassName="cu-gfs-existing-access__role-menu"
                        options={ROLE_OPTIONS}
                        placeholder="Role"
                        portal
                        searchable={false}
                        showSelectedChips={false}
                        value={[roleForPermissions(row.permissions)]}
                      />
                    </span>
                    <RowActionMenu
                      actions={[
                        {
                          key: 'remove',
                          label: 'Remove access',
                          danger: true,
                          disabled: actionPending,
                          onSelect: () =>
                            inherited
                              ? setParentUpdate({ row, mode: 'remove' })
                              : void revokeAccess(row.direct as GfsExistingAccessItem),
                        },
                      ]}
                      ariaLabel={`Actions for ${label}`}
                    />
                  </RecordListRow>
                )
              })}
            </RecordList>
          )}
        </section>
      ) : null}
      <GfsInheritedAccessDialog
        busy={busy}
        request={
          parentUpdate?.row.inherited
            ? {
                mode: parentUpdate.mode,
                memberLabel: subjectLabel(parentUpdate.row),
                fileName: resource.name,
                // Removal touches every contributing folder; a role change
                // touches only the R1-H1 plan's affected folders.
                folders:
                  parentUpdate.mode === 'remove'
                    ? parentUpdate.row.inherited.sources.map(source => ({
                        name: source.name,
                        currentRole: roleForPermissions(source.permissions),
                      }))
                    : parentUpdate.affected.map(({ source }) => ({
                        name: source.name,
                        currentRole: roleForPermissions(source.permissions),
                      })),
                fileCurrentRole: roleForPermissions(parentUpdate.row.permissions),
                nextRole: parentUpdate.mode === 'change-role' ? parentUpdate.nextRole : undefined,
              }
            : null
        }
        onCancel={() => setParentUpdate(null)}
        onConfirm={() => void confirmParentUpdate()}
      />
      {confirmDialog}
    </div>
  )
}
