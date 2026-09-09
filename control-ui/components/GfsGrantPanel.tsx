'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RecordList, RecordListRow, RowActionMenu } from '@clerum/frontend-components'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { GfsSubjectPicker } from '@components/GfsSubjectPicker'
import { SelectionDropdown } from '@components/SelectionDropdown'
import type { SelectionDropdownOption } from '@components/SelectionDropdown/types'
import { IconFolder } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { Button, CheckboxField } from '@components/ui'
import { GFS_MAX_BULK_SUBJECTS } from '@constants/gfsGrantSubjects'
import {
  type AdminUser,
  type GfsGrantError,
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
import type { GfsExistingAccessItem, GfsGrantPanelProps } from './GfsGrantPanel.types'
import { buildGfsBulkSubjectOptions, toGfsBulkSubjectInputs } from './gfsGrantSubjectOptions'

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
      setExistingAccess([
        ...grantResult.items.map(item => ({ ...item, kind: 'grant' as const })),
        ...shareResult.items.map(item => ({ ...item, kind: 'share' as const })),
      ])
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
    (item: GfsExistingAccessItem): string => {
      if (item.subject.type === 'operator') return 'Operator'
      const option = bulkSubjectOptions.find(
        candidate =>
          candidate.subject.type === item.subject.type && candidate.subject.id === item.subject.id
      )
      if (option) return option.label
      const typeLabel =
        item.subject.type === 'host'
          ? 'Agent or workflow'
          : item.subject.type.charAt(0).toUpperCase() + item.subject.type.slice(1)
      return item.subject.id ? `${typeLabel} · ${item.subject.id}` : typeLabel
    },
    [bulkSubjectOptions]
  )

  const sortedExistingAccess = useMemo(
    () =>
      [...existingAccess].sort(
        (left, right) =>
          subjectLabel(left).localeCompare(subjectLabel(right), undefined, {
            numeric: true,
            sensitivity: 'base',
          }) ||
          left.kind.localeCompare(right.kind) ||
          left.id.localeCompare(right.id)
      ),
    [existingAccess, subjectLabel]
  )

  async function revokeAccess(item: GfsExistingAccessItem) {
    const label = subjectLabel(item)
    const confirmed = await confirm({
      title: 'Remove access?',
      message: `Remove ${item.kind} access for ${label} from "${resource.name}"?`,
      confirmLabel: 'Remove access',
      tone: 'danger',
    })
    if (!confirmed) return
    setBusy(true)
    setError('')
    try {
      if (item.kind === 'grant') await deleteGfsGrant(item.id)
      else await deleteGfsShare(item.id)
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
    if (item.kind !== 'grant') return
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
          {existingAccessLoading ? (
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
          ) : existingAccess.length === 0 ? (
            <p className="cu-gfs-existing-access__empty">No direct grants or shares yet.</p>
          ) : (
            <RecordList className="cu-gfs-existing-access__list" aria-label="Resource access">
              {sortedExistingAccess.map(item => {
                const label = subjectLabel(item)
                const coversDescendants =
                  item.kind === 'grant' ? item.inherit : item.includeDescendants
                return (
                  <RecordListRow
                    className="cu-gfs-existing-access__item"
                    data-testid={`gfs-access-row-${item.kind}-${item.id}`}
                    data-access-id={item.id}
                    key={`${item.kind}:${item.id}`}
                  >
                    <span className="cu-gfs-existing-access__identity">
                      <span className="cu-gfs-existing-access__subject">{label}</span>
                      <span className="cu-gfs-existing-access__detail">
                        {item.kind === 'grant' ? 'Direct grant' : 'Direct share'} ·{' '}
                        {item.subject.type}
                      </span>
                    </span>
                    <span className="cu-gfs-existing-access__meta">
                      {item.kind === 'grant' ? (
                        <SelectionDropdown
                          ariaLabel={`Access role for ${label}`}
                          className="cu-gfs-existing-access__role"
                          disabled={actionPending}
                          multiple={false}
                          onChange={next =>
                            void updateAccessRole(item, (next[0] ?? 'read') as AccessRole)
                          }
                          options={ROLE_OPTIONS}
                          placeholder="Role"
                          searchable={false}
                          showSelectedChips={false}
                          value={[roleForPermissions(item.permissions)]}
                        />
                      ) : (
                        <span className="cu-gfs-existing-access__role-label">
                          {roleForPermissions(item.permissions) === 'editor' ? 'Editor' : 'Read'}
                        </span>
                      )}
                      {coversDescendants ? (
                        <span className="cu-gfs-existing-access__inherit">
                          <IconFolder />
                          Includes contents
                        </span>
                      ) : null}
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
                      ariaLabel={`Actions for ${item.kind === 'grant' ? 'direct grant to' : 'direct share to'} ${label}`}
                    />
                  </RecordListRow>
                )
              })}
            </RecordList>
          )}
        </section>
      ) : null}
      {confirmDialog}
    </div>
  )
}
