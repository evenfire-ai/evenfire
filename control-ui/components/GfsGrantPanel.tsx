'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RecordList, RecordListRow, RowActionMenu } from '@clerum/frontend-components'
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
  GfsInheritedAccessItem,
} from './GfsGrantPanel.types'
import { buildGfsBulkSubjectOptions, toGfsBulkSubjectInputs } from './gfsGrantSubjectOptions'
import { loadGfsInheritedAccess } from './gfsInheritedAccess'

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
  // not from this resource's direct grant/share rows. Only FILE dialogs use
  // the derivation — folder dialogs keep their direct-only behavior.
  const [inheritedAccess, setInheritedAccess] = useState<GfsInheritedAccessItem[]>([])
  const [inheritedAccessLoading, setInheritedAccessLoading] = useState(true)
  // True only when the whole derivation failed (R1-M3): the access section
  // then shows a quiet notice instead of trusting an empty derived list.
  const [inheritedAccessFailed, setInheritedAccessFailed] = useState(false)
  const inheritedAccessRequest = useRef(0)
  const inheritedAccessController = useRef<AbortController | null>(null)
  // Pending parent-folder confirmation (role change or removal) for a member
  // whose access is inherited from an ancestor folder.
  const [parentUpdate, setParentUpdate] = useState<
    | { row: GfsFileAccessRow; mode: 'change-role'; nextRole: AccessRole }
    | { row: GfsFileAccessRow; mode: 'remove' }
    | null
  >(null)
  const canIncludeDescendants = resource.kind === 'directory'
  const resourceIsFile = resource.kind === 'file'

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
          entry = { subject, permissions: [], inherit: false, grantId: null, shareIds: [] }
          bySubject.set(key, entry)
        }
        return entry
      }
      for (const grant of grantResult.items) {
        const entry = entryFor(grant.subject)
        entry.grantId = grant.id
        entry.inherit = entry.inherit || grant.inherit
        entry.permissions = [...new Set([...entry.permissions, ...grant.permissions])]
      }
      for (const share of shareResult.items) {
        const entry = entryFor(share.subject)
        entry.shareIds.push(share.id)
        entry.inherit = entry.inherit || share.includeDescendants
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
    setInheritedAccessFailed(false)
    if (!resourceIsFile || !resource.path) {
      inheritedAccessController.current = null
      setInheritedAccess([])
      setInheritedAccessLoading(false)
      return
    }
    const controller = new AbortController()
    inheritedAccessController.current = controller
    setInheritedAccessLoading(true)
    try {
      const items = await loadGfsInheritedAccess(resource.path, DRIVE, controller.signal)
      if (requestId !== inheritedAccessRequest.current) return
      setInheritedAccess(items)
    } catch {
      if (requestId !== inheritedAccessRequest.current) return
      setInheritedAccess([])
      // A TOTAL derivation failure (the walk itself blew up) is surfaced as a
      // quiet notice; per-ancestor best-effort skipping stays silent by
      // design. An empty derived list alone would silently read as "no one
      // else has access" (R1-M3).
      setInheritedAccessFailed(true)
    } finally {
      if (requestId === inheritedAccessRequest.current) {
        inheritedAccessController.current = null
        setInheritedAccessLoading(false)
      }
    }
  }, [resource.path, resourceIsFile])

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

  const sortedExistingAccess = useMemo(
    () => [...existingAccess].sort(bySubjectLabel),
    [bySubjectLabel, existingAccess]
  )

  // File dialogs dedupe to exactly one row per member across direct grants
  // and inherited ancestor grants; the effective role is the strongest.
  const sortedFileAccessRows = useMemo<GfsFileAccessRow[]>(() => {
    if (!resourceIsFile) return []
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
  }, [bySubjectLabel, existingAccess, inheritedAccess, resourceIsFile])

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

  async function updateAccessRole(item: GfsExistingAccessItem, nextRole: AccessRole) {
    const permissions = rolePermissions(nextRole, hostOnlySubject(item.subject))
    setBusy(true)
    setError('')
    try {
      await putGfsGrant({
        drive: DRIVE,
        resourceId: resource.resourceId,
        subject: item.subject,
        permissions,
        inherit: item.inherit,
      })
      // The upserted grant supersedes any legacy URI share for this subject;
      // the server has no share-update surface, so consolidation happens here.
      for (const shareId of item.shareIds) await deleteGfsShare(shareId)
      showToast(
        `${subjectLabel(item)} is now ${nextRole === 'editor' ? 'an Editor' : 'Read-only'}.`,
        {
          tone: 'success',
        }
      )
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
   * Confirmed edit of an inherited row: the change is applied to the parent
   * folder that configures the access (its grant cascades to everything
   * inside), and the file's own direct rows are aligned so they cannot mask
   * the chosen role. Cancel never reaches this path — the dropdown reverts.
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
    const source = inherited.source
    setParentUpdate(null)
    setBusy(true)
    setError('')
    const reload = async () => {
      await Promise.all([loadExistingAccess(), loadInheritedAccess()])
    }
    try {
      if (request.mode === 'change-role') {
        const permissions = rolePermissions(request.nextRole, hostOnlySubject(row.subject))
        await putGfsGrant({
          drive: DRIVE,
          resourceId: source.resourceId,
          subject: row.subject,
          permissions,
          inherit: true,
        })
        for (const shareId of source.shareIds) await deleteGfsShare(shareId)
        if (row.direct) {
          await putGfsGrant({
            drive: DRIVE,
            resourceId: resource.resourceId,
            subject: row.subject,
            permissions,
            inherit: row.direct.inherit,
          })
          for (const shareId of row.direct.shareIds) await deleteGfsShare(shareId)
        }
        showToast(
          `${subjectLabel(row)} is now ${request.nextRole === 'editor' ? 'an Editor' : 'Read-only'} on ${source.name} and everything inside it.`,
          { tone: 'success' }
        )
      } else {
        if (source.grantId) await deleteGfsGrant(source.grantId)
        for (const shareId of source.shareIds) await deleteGfsShare(shareId)
        showToast(`Access removed on ${source.name} and everything inside it.`, {
          tone: 'success',
        })
      }
      await reload()
    } catch (caught) {
      if (!isAlreadyMissing(caught)) {
        setError(caught instanceof Error ? caught.message : 'Failed to update access')
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
            <p role="status" className="cu-gfs-existing-access__notice">
              Inherited access could not be loaded. Members with access from a parent folder may be
              missing.
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
              {resourceIsFile
                ? sortedFileAccessRows.map(row => {
                    const label = subjectLabel(row)
                    const kind = subjectKind(row)
                    const inherited = row.inherited !== null
                    return (
                      <RecordListRow
                        className="cu-gfs-existing-access__item"
                        data-testid={`gfs-access-row-${row.subject.type}`}
                        data-access-id={row.direct?.grantId ?? row.direct?.shareIds[0]}
                        data-inherited={inherited ? 'true' : undefined}
                        key={`file:${subjectKey(row.subject)}`}
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
                            disabled={actionPending}
                            multiple={false}
                            onChange={next =>
                              inherited
                                ? setParentUpdate({
                                    row,
                                    mode: 'change-role',
                                    nextRole: (next[0] ?? 'read') as AccessRole,
                                  })
                                : void updateAccessRole(
                                    row.direct as GfsExistingAccessItem,
                                    (next[0] ?? 'read') as AccessRole
                                  )
                            }
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
                  })
                : sortedExistingAccess.map(item => {
                    const label = subjectLabel(item)
                    const kind = subjectKind(item)
                    return (
                      <RecordListRow
                        className="cu-gfs-existing-access__item"
                        data-testid={`gfs-access-row-${item.subject.type}`}
                        data-access-id={item.grantId ?? item.shareIds[0]}
                        key={`${item.subject.type}:${item.grantId ?? item.shareIds[0]}`}
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
                            disabled={actionPending}
                            multiple={false}
                            onChange={next =>
                              void updateAccessRole(item, (next[0] ?? 'read') as AccessRole)
                            }
                            menuClassName="cu-gfs-existing-access__role-menu"
                            options={ROLE_OPTIONS}
                            placeholder="Role"
                            portal
                            searchable={false}
                            showSelectedChips={false}
                            value={[roleForPermissions(item.permissions)]}
                          />
                        </span>
                        <RowActionMenu
                          actions={[
                            {
                              key: 'remove',
                              label: 'Remove access',
                              danger: true,
                              disabled: actionPending,
                              onSelect: () => void revokeAccess(item),
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
                parentFolderName: parentUpdate.row.inherited.source.name,
                fileName: resource.name,
                parentCurrentRole: roleForPermissions(
                  parentUpdate.row.inherited.source.permissions
                ),
                fileCurrentRole: roleForPermissions(parentUpdate.row.permissions),
                nextRole: parentUpdate.mode === 'change-role' ? parentUpdate.nextRole : undefined,
                fileRemainingRole:
                  parentUpdate.mode === 'remove' && parentUpdate.row.direct
                    ? roleForPermissions(parentUpdate.row.direct.permissions)
                    : null,
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
