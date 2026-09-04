'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RecordList, RecordListRow, RowActionMenu } from '@clerum/frontend-components'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { TabBar } from '@components/TabBar'
import { useToast } from '@components/Toast'
import {
  allowWorkflowApprovalTeam,
  getAdminTeams,
  getAdminUsers,
  isSilentApiError,
  listWorkflowApprovalAllowedTeams,
  listWorkflowGrants,
  listWorkflowTeamGrants,
  revokeWorkflowApprovalTeam,
  setWorkflowGrants,
  setWorkflowTeamGrants,
} from '@lib/api'
import { WORKFLOW_ACCESS_SECTIONS } from './constants'
import type {
  AccessContractKey,
  AccessSectionDefinition,
  AccessTeamOption,
  AccessTeamRow,
  AccessUserOption,
  AccessUserRow,
  WorkflowAccessPanelProps,
} from './types'

type SectionState = {
  loadError: string | null
  mutateError: string | null
  mutating: boolean
}

type WorkflowAccessTab = AccessContractKey

const INITIAL_SECTION_STATE: SectionState = {
  loadError: null,
  mutateError: null,
  mutating: false,
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map(id => id.trim()).filter(Boolean))]
}

function apiErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : null
}

function apiErrorRetryAfterSeconds(error: unknown): number | null {
  if (apiErrorStatus(error) !== 429 || !error || typeof error !== 'object') return null
  const body = (error as { body?: unknown }).body
  if (!body || typeof body !== 'object') return null
  const raw = (body as Record<string, unknown>).retryAfterSeconds
  const seconds = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null
}

function removeId(ids: string[], id: string): string[] {
  return ids.filter(existing => existing !== id)
}

function userLabel(user: AccessUserRow): string {
  return user.displayName || user.name || user.email
}

function teamLabel(team: AccessTeamRow): string {
  return team.name || team.id
}

function compareIdentity(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}

function sectionCount(mode: 'create' | 'edit', loadedCount: number | null, selectedCount: number) {
  return mode === 'edit'
    ? loadedCount === null
      ? '...'
      : String(loadedCount)
    : String(selectedCount)
}

function stateError(state: SectionState, inlineError: string | null | undefined) {
  return inlineError ?? state.loadError ?? state.mutateError
}

export function WorkflowAccessPanel(props: WorkflowAccessPanelProps): React.JSX.Element {
  const {
    mode,
    selectedUserIds,
    selectedTeamIds,
    selectedApprovalTeamIds,
    onSelectedUserIdsChange,
    onSelectedTeamIdsChange,
    onSelectedApprovalTeamIdsChange,
    inlineError,
    showHeader = true,
  } = props
  const { confirm, confirmDialog } = useConfirmDialog()
  const [allUsers, setAllUsers] = useState<AccessUserOption[] | null>(null)
  const [allTeams, setAllTeams] = useState<AccessTeamOption[] | null>(null)
  const [userGrants, setUserGrants] = useState<AccessUserRow[] | null>(null)
  const [teamGrants, setTeamGrants] = useState<AccessTeamRow[] | null>(null)
  const [approvalTeams, setApprovalTeams] = useState<AccessTeamRow[] | null>(null)
  const [pickUserIds, setPickUserIds] = useState<string[]>([])
  const [pickTeamIds, setPickTeamIds] = useState<string[]>([])
  const [pickApprovalTeamIds, setPickApprovalTeamIds] = useState<string[]>([])
  const [internalActiveAccessTab, setInternalActiveAccessTab] =
    useState<WorkflowAccessTab>('trigger-users')
  const [sectionState, setSectionState] = useState<Record<AccessContractKey, SectionState>>({
    'trigger-users': INITIAL_SECTION_STATE,
    'trigger-teams': INITIAL_SECTION_STATE,
    'approval-target-teams': INITIAL_SECTION_STATE,
  })
  const { showToast } = useToast()
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const setSectionPatch = useCallback((key: AccessContractKey, patch: Partial<SectionState>) => {
    setSectionState(previous => ({
      ...previous,
      [key]: { ...previous[key], ...patch },
    }))
  }, [])

  const namespace = mode === 'edit' ? props.namespace : ''
  const recipeName = mode === 'edit' ? props.recipeName : ''
  const activeAccessTab = props.activeSection ?? internalActiveAccessTab

  const loadDirectory = useCallback(async () => {
    try {
      const [users, teams] = await Promise.all([getAdminUsers(''), getAdminTeams()])
      if (!mountedRef.current) return
      setAllUsers(users.items ?? [])
      setAllTeams(teams.items ?? [])
    } catch (error) {
      if (!mountedRef.current) return
      const message = error instanceof Error ? error.message : 'Failed to load directory'
      setSectionPatch('trigger-users', { loadError: message })
      setSectionPatch('trigger-teams', { loadError: message })
      setSectionPatch('approval-target-teams', { loadError: message })
    }
  }, [setSectionPatch])

  const loadUserGrants = useCallback(async () => {
    if (mode !== 'edit') return
    setSectionPatch('trigger-users', { loadError: null })
    try {
      const result = await listWorkflowGrants(namespace, recipeName)
      if (!mountedRef.current) return
      const items = result.items ?? []
      setUserGrants(items)
      onSelectedUserIdsChange(items.map(item => item.id))
    } catch (error) {
      if (!mountedRef.current) return
      setSectionPatch('trigger-users', {
        loadError: error instanceof Error ? error.message : 'Failed to load user grants',
      })
    }
  }, [mode, namespace, onSelectedUserIdsChange, recipeName, setSectionPatch])

  const loadTeamGrants = useCallback(async () => {
    if (mode !== 'edit') return
    setSectionPatch('trigger-teams', { loadError: null })
    try {
      const result = await listWorkflowTeamGrants(namespace, recipeName)
      if (!mountedRef.current) return
      const items = result.items ?? []
      setTeamGrants(items)
      onSelectedTeamIdsChange(items.map(item => item.id))
    } catch (error) {
      if (!mountedRef.current) return
      setSectionPatch('trigger-teams', {
        loadError: error instanceof Error ? error.message : 'Failed to load team grants',
      })
    }
  }, [mode, namespace, onSelectedTeamIdsChange, recipeName, setSectionPatch])

  const loadApprovalTeams = useCallback(async () => {
    if (mode !== 'edit') return
    setSectionPatch('approval-target-teams', { loadError: null })
    try {
      const result = await listWorkflowApprovalAllowedTeams(namespace, recipeName)
      if (!mountedRef.current) return
      const items = result.items ?? []
      setApprovalTeams(items)
      onSelectedApprovalTeamIdsChange(items.map(item => item.id))
    } catch (error) {
      if (!mountedRef.current) return
      setSectionPatch('approval-target-teams', {
        loadError: error instanceof Error ? error.message : 'Failed to load approval target teams',
      })
    }
  }, [mode, namespace, onSelectedApprovalTeamIdsChange, recipeName, setSectionPatch])

  useEffect(() => {
    loadDirectory()
    if (mode === 'edit') {
      loadUserGrants()
      loadTeamGrants()
      loadApprovalTeams()
    }
  }, [loadApprovalTeams, loadDirectory, loadTeamGrants, loadUserGrants, mode])

  const selectedUserSet = useMemo(() => new Set(selectedUserIds), [selectedUserIds])
  const selectedTeamSet = useMemo(() => new Set(selectedTeamIds), [selectedTeamIds])
  const selectedApprovalTeamSet = useMemo(
    () => new Set(selectedApprovalTeamIds),
    [selectedApprovalTeamIds]
  )

  const displayUsers = useMemo(
    () =>
      (mode === 'edit'
        ? (userGrants ?? [])
        : (allUsers ?? []).filter(user => selectedUserSet.has(user.id))
      ).toSorted(
        (left, right) =>
          compareIdentity(userLabel(left), userLabel(right)) || compareIdentity(left.id, right.id)
      ),
    [allUsers, mode, selectedUserSet, userGrants]
  )
  const displayTeams = useMemo(
    () =>
      (mode === 'edit'
        ? (teamGrants ?? [])
        : (allTeams ?? []).filter(team => selectedTeamSet.has(team.id))
      ).toSorted(
        (left, right) =>
          compareIdentity(teamLabel(left), teamLabel(right)) || compareIdentity(left.id, right.id)
      ),
    [allTeams, mode, selectedTeamSet, teamGrants]
  )
  const displayApprovalTeams = useMemo(
    () =>
      (mode === 'edit'
        ? (approvalTeams ?? [])
        : (allTeams ?? []).filter(team => selectedApprovalTeamSet.has(team.id))
      ).toSorted(
        (left, right) =>
          compareIdentity(teamLabel(left), teamLabel(right)) || compareIdentity(left.id, right.id)
      ),
    [allTeams, approvalTeams, mode, selectedApprovalTeamSet]
  )

  const ungrantedUsers = (allUsers ?? []).filter(user => !selectedUserSet.has(user.id))
  const ungrantedTeams = (allTeams ?? []).filter(team => !selectedTeamSet.has(team.id))
  const unallowedApprovalTeams = (allTeams ?? []).filter(
    team => !selectedApprovalTeamSet.has(team.id)
  )

  async function persistUserGrants(nextUserIds: string[]) {
    if (mode === 'create') {
      onSelectedUserIdsChange(nextUserIds)
      return
    }
    if (userGrants === null) return
    const current = selectedUserIds
    const added = nextUserIds.filter(id => !current.includes(id))
    const removed = current.filter(id => !nextUserIds.includes(id))
    setSectionPatch('trigger-users', { mutating: true, mutateError: null })
    try {
      await setWorkflowGrants(namespace, recipeName, nextUserIds)
      await loadUserGrants()
      if (added.length > 0) {
        showToast(
          added.length === 1 ? 'Workflow user access granted.' : 'Workflow user access granted.',
          { tone: 'success' }
        )
      } else if (removed.length > 0) {
        showToast(
          removed.length === 1 ? 'Workflow user access revoked.' : 'Workflow user access revoked.',
          { tone: 'success' }
        )
      } else {
        showToast('Workflow user access updated.', { tone: 'success' })
      }
    } catch (error) {
      if (!mountedRef.current) return
      setSectionPatch('trigger-users', {
        mutateError: error instanceof Error ? error.message : 'Failed to save user grants',
      })
    } finally {
      if (mountedRef.current) setSectionPatch('trigger-users', { mutating: false })
    }
  }

  async function persistTeamGrants(nextTeamIds: string[]) {
    if (mode === 'create') {
      onSelectedTeamIdsChange(nextTeamIds)
      return
    }
    if (teamGrants === null) return
    const current = selectedTeamIds
    const added = nextTeamIds.filter(id => !current.includes(id))
    const removed = current.filter(id => !nextTeamIds.includes(id))
    setSectionPatch('trigger-teams', { mutating: true, mutateError: null })
    try {
      await setWorkflowTeamGrants(namespace, recipeName, nextTeamIds)
      await loadTeamGrants()
      if (added.length > 0) {
        showToast('Workflow team access granted.', { tone: 'success' })
      } else if (removed.length > 0) {
        showToast('Workflow team access revoked.', { tone: 'success' })
      } else {
        showToast('Workflow team access updated.', { tone: 'success' })
      }
    } catch (error) {
      if (!mountedRef.current) return
      setSectionPatch('trigger-teams', {
        mutateError: error instanceof Error ? error.message : 'Failed to save team grants',
      })
    } finally {
      if (mountedRef.current) setSectionPatch('trigger-teams', { mutating: false })
    }
  }

  async function persistApprovalTeams(nextTeamIds: string[]) {
    if (mode === 'create') {
      onSelectedApprovalTeamIdsChange(nextTeamIds)
      return
    }
    if (approvalTeams === null) return
    const current = selectedApprovalTeamIds
    const added = nextTeamIds.filter(id => !current.includes(id))
    const removed = current.filter(id => !nextTeamIds.includes(id))
    setSectionPatch('approval-target-teams', { mutating: true, mutateError: null })
    const errors: string[] = []
    let rateLimited = false
    let retryAfterSeconds: number | null = null
    let appliedMutations = 0
    const recordMutationError = (error: unknown): boolean => {
      if (isSilentApiError(error)) throw error
      if (apiErrorStatus(error) === 429) {
        rateLimited = true
        const retry = apiErrorRetryAfterSeconds(error)
        retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, retry ?? 0) || null
        return true
      }
      errors.push(error instanceof Error ? error.message : String(error))
      return false
    }
    let stopMutations = false
    try {
      // Serialize allow/revoke so a shared 20/min grant-write bucket cannot
      // leave a partial write behind a Promise.all rejection.
      for (const teamId of added) {
        try {
          await allowWorkflowApprovalTeam(namespace, recipeName, teamId)
          appliedMutations += 1
        } catch (error) {
          stopMutations = recordMutationError(error)
          if (stopMutations) break
        }
      }
      for (const teamId of stopMutations ? [] : removed) {
        try {
          await revokeWorkflowApprovalTeam(namespace, recipeName, teamId)
          appliedMutations += 1
        } catch (error) {
          stopMutations = recordMutationError(error)
          if (stopMutations) break
        }
      }
      await loadApprovalTeams()
      if (rateLimited || errors.length > 0) {
        const messages = [...errors]
        if (rateLimited) {
          const partialPrefix = appliedMutations > 0 ? 'Some changes were saved. ' : ''
          messages.unshift(
            retryAfterSeconds === null
              ? `${partialPrefix}Too many approval target team changes. Try again shortly.`
              : `${partialPrefix}Too many approval target team changes. Try again in about ${retryAfterSeconds} seconds.`
          )
        }
        throw new Error(messages.join('; '))
      }
      if (added.length > 0) {
        showToast('Approval target team allowed.', { tone: 'success' })
      } else if (removed.length > 0) {
        showToast('Approval target team revoked.', { tone: 'success' })
      } else {
        showToast('Approval target teams updated.', { tone: 'success' })
      }
    } catch (error) {
      if (!mountedRef.current || isSilentApiError(error)) return
      setSectionPatch('approval-target-teams', {
        mutateError:
          error instanceof Error ? error.message : 'Failed to save approval target teams',
      })
    } finally {
      if (mountedRef.current) setSectionPatch('approval-target-teams', { mutating: false })
    }
  }

  async function handleGrantUser() {
    if (pickUserIds.length === 0) return
    const next = uniqueIds([...selectedUserIds, ...pickUserIds])
    setPickUserIds([])
    await persistUserGrants(next)
  }

  async function handleGrantTeam() {
    if (pickTeamIds.length === 0) return
    const next = uniqueIds([...selectedTeamIds, ...pickTeamIds])
    setPickTeamIds([])
    await persistTeamGrants(next)
  }

  async function handleAllowApprovalTeam() {
    if (pickApprovalTeamIds.length === 0) return
    const next = uniqueIds([...selectedApprovalTeamIds, ...pickApprovalTeamIds])
    setPickApprovalTeamIds([])
    await persistApprovalTeams(next)
  }

  async function handleRevokeUser(id: string) {
    if (mode === 'create') {
      await persistUserGrants(removeId(selectedUserIds, id))
      return
    }
    const user = displayUsers.find(row => row.id === id)
    const shouldRevoke = await confirm({
      title: 'Remove Member Trigger Access',
      message: `Remove trigger access for ${user ? userLabel(user) : 'this member'}?`,
      confirmLabel: 'Remove access',
      tone: 'danger',
    })
    if (!shouldRevoke) return
    await persistUserGrants(removeId(selectedUserIds, id))
  }

  async function handleRevokeTeam(id: string) {
    if (mode === 'create') {
      await persistTeamGrants(removeId(selectedTeamIds, id))
      return
    }
    const team = displayTeams.find(row => row.id === id)
    const shouldRevoke = await confirm({
      title: 'Remove Team Trigger Access',
      message: `Remove trigger access for ${team ? teamLabel(team) : 'this team'}?`,
      confirmLabel: 'Remove access',
      tone: 'danger',
    })
    if (!shouldRevoke) return
    await persistTeamGrants(removeId(selectedTeamIds, id))
  }

  async function handleRevokeApprovalTeam(id: string) {
    if (mode === 'create') {
      await persistApprovalTeams(removeId(selectedApprovalTeamIds, id))
      return
    }
    const team = displayApprovalTeams.find(row => row.id === id)
    const shouldRevoke = await confirm({
      title: 'Remove Approval Target Team',
      message: `Remove ${team ? teamLabel(team) : 'this team'} as an approval target?`,
      confirmLabel: 'Remove target',
      tone: 'danger',
    })
    if (!shouldRevoke) return
    await persistApprovalTeams(removeId(selectedApprovalTeamIds, id))
  }

  const sectionByKey = Object.fromEntries(
    WORKFLOW_ACCESS_SECTIONS.map(section => [section.key, section])
  ) as Record<AccessContractKey, AccessSectionDefinition>
  const accessTabOptions = [
    {
      value: 'trigger-users' as const,
      label: `${sectionByKey['trigger-users'].title} (${sectionCount(
        mode,
        userGrants?.length ?? null,
        selectedUserIds.length
      )})`,
    },
    {
      value: 'trigger-teams' as const,
      label: `${sectionByKey['trigger-teams'].title} (${sectionCount(
        mode,
        teamGrants?.length ?? null,
        selectedTeamIds.length
      )})`,
    },
    {
      value: 'approval-target-teams' as const,
      label: `${sectionByKey['approval-target-teams'].title} (${sectionCount(
        mode,
        approvalTeams?.length ?? null,
        selectedApprovalTeamIds.length
      )})`,
    },
  ]

  return (
    <section className="cu-workflow-access" data-testid="workflow-access-panel">
      {showHeader && !props.activeSection ? (
        <div className="cu-workflow-access__header">
          <div>
            <div className="cu-workflow-access__title">Workflow access</div>
            <p className="cu-workflow-access__description">
              Trigger permissions and approval targets are managed separately.
            </p>
          </div>
        </div>
      ) : null}

      {!props.activeSection ? (
        <TabBar<WorkflowAccessTab>
          activeValue={activeAccessTab}
          ariaLabel="Workflow access sections"
          className="cu-tabs--flush"
          onChange={setInternalActiveAccessTab}
          options={accessTabOptions}
        />
      ) : null}

      {activeAccessTab === 'trigger-users' ? (
        <AccessUserSection
          definition={sectionByKey['trigger-users']}
          rows={displayUsers}
          options={ungrantedUsers}
          loaded={mode === 'create' ? allUsers !== null : userGrants !== null}
          selectedCount={selectedUserIds.length}
          loadedCount={mode === 'edit' ? (userGrants?.length ?? null) : null}
          countLabel={sectionCount(mode, userGrants?.length ?? null, selectedUserIds.length)}
          state={sectionState['trigger-users']}
          inlineError={inlineError}
          pickValue={pickUserIds}
          onPickChange={setPickUserIds}
          onGrant={handleGrantUser}
          onRevoke={handleRevokeUser}
          emptyText={
            mode === 'edit'
              ? sectionByKey['trigger-users'].emptyEdit
              : sectionByKey['trigger-users'].emptyCreate
          }
        />
      ) : activeAccessTab === 'trigger-teams' ? (
        <AccessTeamSection
          definition={sectionByKey['trigger-teams']}
          rows={displayTeams}
          options={ungrantedTeams}
          loaded={mode === 'create' ? allTeams !== null : teamGrants !== null}
          selectedCount={selectedTeamIds.length}
          loadedCount={mode === 'edit' ? (teamGrants?.length ?? null) : null}
          countLabel={sectionCount(mode, teamGrants?.length ?? null, selectedTeamIds.length)}
          state={sectionState['trigger-teams']}
          inlineError={inlineError}
          pickValue={pickTeamIds}
          onPickChange={setPickTeamIds}
          onGrant={handleGrantTeam}
          onRevoke={handleRevokeTeam}
          emptyText={
            mode === 'edit'
              ? sectionByKey['trigger-teams'].emptyEdit
              : sectionByKey['trigger-teams'].emptyCreate
          }
        />
      ) : (
        <AccessTeamSection
          definition={sectionByKey['approval-target-teams']}
          rows={displayApprovalTeams}
          options={unallowedApprovalTeams}
          loaded={mode === 'create' ? allTeams !== null : approvalTeams !== null}
          selectedCount={selectedApprovalTeamIds.length}
          loadedCount={mode === 'edit' ? (approvalTeams?.length ?? null) : null}
          countLabel={sectionCount(
            mode,
            approvalTeams?.length ?? null,
            selectedApprovalTeamIds.length
          )}
          state={sectionState['approval-target-teams']}
          inlineError={inlineError}
          pickValue={pickApprovalTeamIds}
          onPickChange={setPickApprovalTeamIds}
          onGrant={handleAllowApprovalTeam}
          onRevoke={handleRevokeApprovalTeam}
          emptyText={
            mode === 'edit'
              ? sectionByKey['approval-target-teams'].emptyEdit
              : sectionByKey['approval-target-teams'].emptyCreate
          }
        />
      )}
      {confirmDialog}
    </section>
  )
}

function SectionShell({
  definition,
  countLabel,
  state,
  inlineError,
  children,
}: {
  definition: AccessSectionDefinition
  countLabel: string
  state: SectionState
  inlineError?: string | null
  children: React.ReactNode
}) {
  const error = stateError(state, inlineError)
  return (
    <div className="cu-workflow-access__section" data-testid={`workflow-access-${definition.key}`}>
      <div className="cu-workflow-access__section-head">
        <div>
          <div className="cu-workflow-access__section-title">{definition.title}</div>
          <p className="cu-workflow-access__section-description">{definition.description}</p>
        </div>
        <span className="cu-workflow-access__count">{countLabel}</span>
      </div>
      {error && (
        <div className="cu-workflow-access__error" role="alert">
          {error}
        </div>
      )}
      {children}
    </div>
  )
}

function AccessUserSection({
  definition,
  rows,
  options,
  loaded,
  countLabel,
  state,
  inlineError,
  pickValue,
  onPickChange,
  onGrant,
  onRevoke,
  emptyText,
}: {
  definition: AccessSectionDefinition
  rows: AccessUserRow[]
  options: AccessUserOption[]
  loaded: boolean
  selectedCount: number
  loadedCount: number | null
  countLabel: string
  state: SectionState
  inlineError?: string | null
  pickValue: string[]
  onPickChange: (next: string[]) => void
  onGrant: () => void
  onRevoke: (id: string) => void
  emptyText: string
}) {
  const busy = state.mutating
  const userOptions = options.map(user => ({
    value: user.id,
    label: userLabel(user),
    description: user.email,
  }))
  return (
    <SectionShell
      definition={definition}
      countLabel={countLabel}
      state={state}
      inlineError={inlineError}
    >
      {!loaded ? (
        <div className="cu-workflow-access__empty">Loading workflow access...</div>
      ) : rows.length === 0 ? (
        <div className="cu-workflow-access__empty">{emptyText}</div>
      ) : (
        <RecordList className="cu-workflow-access__rows">
          {rows.map(user => (
            <RecordListRow className="cu-workflow-access__row" key={user.id}>
              <div className="cu-workflow-access__row-main">
                <span className="cu-workflow-access__row-title">{userLabel(user)}</span>
                {(user.displayName || user.name) && (
                  <span className="cu-workflow-access__row-meta">{user.email}</span>
                )}
              </div>
              <RowActionMenu
                actions={[
                  {
                    key: 'remove',
                    label: definition.revokeLabel,
                    danger: true,
                    disabled: busy,
                    onSelect: () => void onRevoke(user.id),
                  },
                ]}
                ariaLabel={`Actions for ${userLabel(user)}`}
              />
            </RecordListRow>
          ))}
        </RecordList>
      )}
      <div className="cu-workflow-access__picker cu-workflow-access__picker--inline">
        <SelectionDropdown
          id={`workflow-${definition.key}-picker`}
          inline
          value={pickValue}
          onChange={onPickChange}
          options={userOptions}
          placeholder={options.length === 0 ? 'All users already granted' : 'Pick users'}
          searchPlaceholder="Search users..."
          selectionLabel="Selected users"
          emptyLabel="All users already granted."
          disabled={busy || options.length === 0}
        />
        <button
          className="cu-btn cu-btn--primary cu-btn--sm"
          type="button"
          disabled={pickValue.length === 0 || busy}
          onClick={onGrant}
        >
          {pickValue.length > 1 ? 'Add members' : definition.grantLabel}
        </button>
      </div>
    </SectionShell>
  )
}

function AccessTeamSection({
  definition,
  rows,
  options,
  loaded,
  countLabel,
  state,
  inlineError,
  pickValue,
  onPickChange,
  onGrant,
  onRevoke,
  emptyText,
}: {
  definition: AccessSectionDefinition
  rows: AccessTeamRow[]
  options: AccessTeamOption[]
  loaded: boolean
  selectedCount: number
  loadedCount: number | null
  countLabel: string
  state: SectionState
  inlineError?: string | null
  pickValue: string[]
  onPickChange: (next: string[]) => void
  onGrant: () => void
  onRevoke: (id: string) => void
  emptyText: string
}) {
  const busy = state.mutating
  const teamOptions = options.map(team => ({
    value: team.id,
    label: teamLabel(team),
  }))
  return (
    <SectionShell
      definition={definition}
      countLabel={countLabel}
      state={state}
      inlineError={inlineError}
    >
      {!loaded ? (
        <div className="cu-workflow-access__empty">Loading workflow access...</div>
      ) : rows.length === 0 ? (
        <div className="cu-workflow-access__empty">{emptyText}</div>
      ) : (
        <RecordList className="cu-workflow-access__rows">
          {rows.map(team => (
            <RecordListRow className="cu-workflow-access__row" key={team.id}>
              <div className="cu-workflow-access__row-main">
                <span className="cu-workflow-access__row-title">{teamLabel(team)}</span>
              </div>
              <RowActionMenu
                actions={[
                  {
                    key: 'remove',
                    label: definition.revokeLabel,
                    danger: true,
                    disabled: busy,
                    onSelect: () => void onRevoke(team.id),
                  },
                ]}
                ariaLabel={`Actions for ${teamLabel(team)}`}
              />
            </RecordListRow>
          ))}
        </RecordList>
      )}
      <div className="cu-workflow-access__picker cu-workflow-access__picker--inline">
        <SelectionDropdown
          id={`workflow-${definition.key}-picker`}
          inline
          value={pickValue}
          onChange={onPickChange}
          options={teamOptions}
          placeholder={options.length === 0 ? 'All teams already selected' : 'Pick teams'}
          searchPlaceholder="Search teams..."
          selectionLabel="Selected teams"
          emptyLabel="All teams already selected."
          disabled={busy || options.length === 0}
        />
        <button
          className="cu-btn cu-btn--primary cu-btn--sm"
          type="button"
          disabled={pickValue.length === 0 || busy}
          onClick={onGrant}
        >
          {pickValue.length > 1
            ? definition.key === 'approval-target-teams'
              ? 'Allow teams'
              : 'Add teams'
            : definition.grantLabel}
        </button>
      </div>
    </SectionShell>
  )
}
