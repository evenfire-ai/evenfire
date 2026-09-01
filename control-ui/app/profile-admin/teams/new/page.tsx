'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { DashboardLayout } from '@components/DashboardLayout'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { IconUsers } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { IconTrash } from '@components/icons'
import { Button, Field, TextInput } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import { getAgentDisplayName } from '@lib/agentName'
import {
  addAdminTeamMember,
  createAdminTeam,
  getAdminUsers,
  getContexts,
  getHosts,
  updateAdminTeamAgents,
  updateAdminTeamContexts,
} from '@lib/api'
import type { AdminUser, ContextResource, HostResource } from '@lib/api'
import { permissionsForTeamRole, setDeletePermission, setInvitePermission } from '@lib/teamRoles'

type Role = 'admin' | 'inviter' | 'member'

type TeamCreateStep = 0 | 1 | 2

const STEPS = ['Team', 'Members', 'Agents'] as const

const STEP_DETAILS = [
  {
    description: 'Name',
    title: 'Team identity',
    subtitle: 'Create the team shell.',
  },
  {
    description: 'Add existing members',
    title: 'Members',
    subtitle: 'Choose initial team members and roles.',
  },
  {
    description: 'Map agent access',
    title: 'Agents',
    subtitle: 'Choose the agents this team can use — their connectors come along.',
  },
] as const

function contextIdFromResource(item: {
  metadata?: { name?: string }
  spec?: { contextId?: string }
}) {
  return String(item.spec?.contextId || item.metadata?.name || '').trim()
}

function hostNameFromResource(item: HostResource) {
  return String(item.metadata?.name || '').trim()
}

export default function CreateTeamPage() {
  const router = useRouter()
  const { showToast } = useToast()

  const [loadingReferenceData, setLoadingReferenceData] = useState(true)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [contextResources, setContextResources] = useState<ContextResource[]>([])
  const [availableContextIds, setAvailableContextIds] = useState<string[]>([])
  const [hosts, setHosts] = useState<HostResource[]>([])
  const [teamName, setTeamName] = useState('')
  const [step, setStep] = useState<TeamCreateStep>(0)
  const [memberRoleDrafts, setMemberRoleDrafts] = useState<Record<string, Role>>({})
  const [selectedContextIds, setSelectedContextIds] = useState<string[]>([])
  const [selectedAgentNames, setSelectedAgentNames] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [createdTeamRecoveryId, setCreatedTeamRecoveryId] = useState('')
  const selectedMemberIds = useMemo(() => Object.keys(memberRoleDrafts), [memberRoleDrafts])
  const usersById = useMemo(() => new Map(users.map(user => [user.id, user])), [users])

  useEffect(() => {
    async function loadReferenceData() {
      setLoadingReferenceData(true)
      setError('')
      try {
        const [usersResponse, contextsResponse, hostsResponse] = await Promise.all([
          getAdminUsers(''),
          getContexts(),
          getHosts(),
        ])
        setUsers(Array.isArray(usersResponse.items) ? usersResponse.items : [])
        setContextResources((contextsResponse.items || []) as ContextResource[])
        setAvailableContextIds(
          (contextsResponse.items || [])
            .map((item: ContextResource) => contextIdFromResource(item))
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b))
        )
        setHosts(Array.isArray(hostsResponse.items) ? hostsResponse.items : [])
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Failed to load team options')
      } finally {
        setLoadingReferenceData(false)
      }
    }

    void loadReferenceData()
  }, [])

  const canCreate = teamName.trim().length > 0 && !saving && !createdTeamRecoveryId
  const selectedMemberRows = useMemo(
    () =>
      selectedMemberIds
        .map(userId => usersById.get(userId))
        .filter((user): user is AdminUser => Boolean(user)),
    [selectedMemberIds, usersById]
  )
  const memberOptions = useMemo(
    () =>
      users.map(user => ({
        value: user.id,
        label: user.displayName || user.name || user.email,
        description: user.email,
      })),
    [users]
  )
  // Options keep context IDs as values (the write model) but show what the
  // access means: the owning agent(s), else the stored display name.
  const contextOptions = useMemo(
    () => {
      const resolveLabel = (contextId: string): string => {
        const owners = hosts
          .map(host => {
            const ref = String(
              (host.spec as { contextRef?: string } | undefined)?.contextRef || ''
            ).trim()
            if (ref !== contextId) return ''
            return (
              String((host.spec as { host?: string } | undefined)?.host || '').trim() ||
              String(host.metadata?.name || '')
            )
          })
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
        if (owners.length > 0) return owners.join(', ')
        return (
          contextResources
            .find(item => contextIdFromResource(item as never) === contextId)
            ?.spec?.displayName?.trim() || contextId
        )
      }
      return availableContextIds.map(contextId => ({
        value: contextId,
        label: resolveLabel(contextId),
      }))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [availableContextIds, contextResources, hosts]
  )
  const agentOptions = useMemo(
    () =>
      Array.from(new Set(hosts.map(host => hostNameFromResource(host)).filter(Boolean)))
        .sort((a, b) => a.localeCompare(b))
        .map(agentName => ({
          value: agentName,
          label: getAgentDisplayName(agentName, hosts),
          description: agentName,
        })),
    [hosts]
  )

  function canJumpToStep(index: number) {
    return !saving && (index === 0 || teamName.trim().length > 0)
  }

  function goToStep(index: number) {
    if (canJumpToStep(index)) {
      setError('')
      setStep(index as TeamCreateStep)
    } else {
      setError('Team name is required before configuring access.')
    }
  }

  function goNext() {
    if (!teamName.trim()) {
      setError('Team name is required.')
      return
    }
    setError('')
    setStep(current => Math.min(current + 1, STEPS.length - 1) as TeamCreateStep)
  }

  function updateSelectedMembers(nextMemberIds: string[]) {
    setMemberRoleDrafts(current => {
      const next: Record<string, Role> = {}
      nextMemberIds.forEach(userId => {
        next[userId] = current[userId] || 'member'
      })
      return next
    })
  }

  function removeMember(userId: string) {
    setMemberRoleDrafts(current => {
      const next = { ...current }
      delete next[userId]
      return next
    })
  }

  function updateMemberRole(userId: string, role: Role) {
    setMemberRoleDrafts(current => ({
      ...current,
      [userId]: role,
    }))
  }

  function skipStep() {
    if (step === 1) {
      setMemberRoleDrafts({})
      goNext()
      return
    }
    if (step === 2) {
      void handleCreateTeam({ agentNames: [], contextIds: [] })
    }
  }

  async function handleCreateTeam(overrides?: {
    agentNames?: string[]
    contextIds?: string[]
    memberRoles?: Record<string, Role>
  }) {
    if (!canCreate) {
      setError('Team name is required.')
      return
    }
    setSaving(true)
    setError('')
    setCreatedTeamRecoveryId('')
    let createdTeamId = ''
    try {
      const createdTeam = await createAdminTeam(teamName.trim())
      createdTeamId = createdTeam.id
      const teamId = createdTeamId
      const selectedMemberRoles = overrides?.memberRoles ?? memberRoleDrafts
      const selectedAgentValues = overrides?.agentNames ?? selectedAgentNames
      // D8 composite: the wizard's Access step picks AGENTS; both mappings are
      // written so scope-based and agent-based enforcement agree.
      const agentRefs = selectedAgentValues
        .map(agentName => hosts.find(host => host.metadata?.name === agentName))
        .map(host =>
          String((host?.spec as { contextRef?: string } | undefined)?.contextRef || '').trim()
        )
        .filter(Boolean)
      const selectedContextValues = Array.from(new Set([...agentRefs]))
      void selectedContextIds

      await Promise.all(
        Object.entries(selectedMemberRoles).map(([userId, role]) =>
          addAdminTeamMember(teamId, userId, role)
        )
      )
      await Promise.all([
        selectedContextValues.length > 0
          ? updateAdminTeamContexts(teamId, selectedContextValues)
          : Promise.resolve(),
        selectedAgentValues.length > 0
          ? updateAdminTeamAgents(teamId, selectedAgentValues, [])
          : Promise.resolve(),
      ])
      showToast('Team created.', { tone: 'success' })
      router.push(CONTROL_ROUTES.usersAndTeams.teams)
    } catch (createError) {
      if (createdTeamId) {
        setCreatedTeamRecoveryId(createdTeamId)
        setError(
          createError instanceof Error
            ? `Team was created, but setup did not finish: ${createError.message}`
            : 'Team was created, but setup did not finish.'
        )
      } else {
        setError(createError instanceof Error ? createError.message : 'Failed to create team')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CreateFlowPanel
          header={
            <CreatePageHeader
              icon={<IconUsers />}
              title="Create team"
              subtitle="Create a team now. Add members and roles next."
              backLabel="Back to teams"
              onBack={() => router.push(CONTROL_ROUTES.usersAndTeams.teams)}
              backDisabled={saving}
            />
          }
        >
          <CreateStepFlow
            ariaLabel="Create team steps"
            className="cu-create-step-flow--4 cu-team-create-panel"
            currentStep={step}
            onStepChange={goToStep}
            canSelectStep={canJumpToStep}
            steps={STEP_DETAILS}
            stepLabels={STEPS}
            titleId="create-team-title"
          >
            {step === 0 ? (
              <div className="cu-form-stack cu-agent-form-stack">
                <Field htmlFor="new-team-name" label="Team name" required>
                  <TextInput
                    id="new-team-name"
                    value={teamName}
                    onChange={event => setTeamName(event.target.value)}
                    placeholder="Team name"
                    disabled={saving}
                    autoFocus
                  />
                </Field>
              </div>
            ) : null}

            {step === 1 ? (
              <div className="cu-form-stack cu-agent-form-stack--wide">
                {loadingReferenceData ? (
                  <div className="cu-muted cu-muted-note--compact">Loading members...</div>
                ) : users.length > 0 ? (
                  <Field htmlFor="new-team-members" label="Members">
                    <div className="cu-team-member-picker">
                      <SelectionDropdown
                        id="new-team-members"
                        value={selectedMemberIds}
                        onChange={updateSelectedMembers}
                        options={memberOptions}
                        placeholder="Select members or leave empty"
                        searchPlaceholder="Search members..."
                        selectionLabel="Selected members"
                        emptyLabel="No members match your search."
                        showSelectedChips={false}
                        disabled={saving}
                      />
                      {selectedMemberRows.length > 0 ? (
                        <div className="cu-permission-selection">
                          <div className="cu-permission-selection__table cu-table-wrap">
                            <table className="cu-table">
                              <thead>
                                <tr>
                                  <th>Member</th>
                                  <th>Can Invite Members</th>
                                  <th>Can Delete Members</th>
                                  <th className="cu-table__actions-heading">Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {selectedMemberRows.map(user => {
                                  const label = user.displayName || user.name || user.email
                                  const role = memberRoleDrafts[user.id] || 'member'
                                  const permissions = permissionsForTeamRole(role)
                                  return (
                                    <tr key={user.id}>
                                      <td>
                                        <span className="cu-permission-row__name">
                                          <span className="cu-permission-row__title">{label}</span>
                                          <span className="cu-permission-row__subtitle">
                                            {user.email}
                                          </span>
                                        </span>
                                      </td>
                                      <td className="cu-permission-cell">
                                        <input
                                          type="checkbox"
                                          checked={permissions.canInviteMembers}
                                          disabled={saving}
                                          onChange={event =>
                                            updateMemberRole(
                                              user.id,
                                              setInvitePermission(role, event.target.checked)
                                            )
                                          }
                                          aria-label={`Can invite members for ${label}`}
                                        />
                                      </td>
                                      <td className="cu-permission-cell">
                                        <input
                                          type="checkbox"
                                          checked={permissions.canDeleteMembers}
                                          disabled={saving}
                                          onChange={event =>
                                            updateMemberRole(
                                              user.id,
                                              setDeletePermission(role, event.target.checked)
                                            )
                                          }
                                          aria-label={`Can delete members for ${label}`}
                                        />
                                      </td>
                                      <td>
                                        <button
                                          type="button"
                                          className="cu-btn cu-btn--icon cu-btn--danger-icon"
                                          onClick={() => removeMember(user.id)}
                                          disabled={saving}
                                          aria-label={`Remove ${label}`}
                                        >
                                          <IconTrash width={16} height={16} />
                                        </button>
                                      </td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ) : (
                        <p className="cu-permission-selection__empty">No members selected.</p>
                      )}
                    </div>
                  </Field>
                ) : (
                  <div className="cu-muted cu-muted-note--compact">No users available.</div>
                )}
              </div>
            ) : null}

            {step === 2 ? (
              <div className="cu-form-stack cu-agent-form-stack--wide">
                {loadingReferenceData ? (
                  <div className="cu-muted cu-muted-note--compact">Loading agents...</div>
                ) : agentOptions.length > 0 ? (
                  <Field htmlFor="new-team-agent-picker" label="Agents">
                    <SelectionDropdown
                      id="new-team-agent-picker"
                      options={agentOptions}
                      value={selectedAgentNames}
                      onChange={setSelectedAgentNames}
                      placeholder="Select agents"
                      searchPlaceholder="Search agents..."
                      selectionLabel="Selected agents"
                      emptyLabel="No agents match your search."
                      disabled={saving}
                      showSelectedChips={false}
                    />
                  </Field>
                ) : (
                  <div className="cu-muted cu-muted-note--compact">
                    No access available to grant.
                  </div>
                )}
              </div>
            ) : null}

            {error ? (
              <div className="cu-banner cu-banner--error">
                <span>{error}</span>
                {createdTeamRecoveryId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      router.push(CONTROL_ROUTES.usersAndTeams.team(createdTeamRecoveryId))
                    }
                  >
                    Open created team
                  </Button>
                ) : null}
              </div>
            ) : null}

            <div className="cu-create-actions">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  step === 0
                    ? router.push(CONTROL_ROUTES.usersAndTeams.teams)
                    : setStep(current => Math.max(current - 1, 0) as TeamCreateStep)
                }
                disabled={saving}
              >
                {step === 0 ? 'Cancel' : 'Back'}
              </Button>
              {step > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={skipStep}
                  disabled={saving}
                >
                  Skip
                </Button>
              ) : null}
              {step < STEPS.length - 1 ? (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={goNext}
                  disabled={saving}
                >
                  Continue
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => void handleCreateTeam()}
                  disabled={!canCreate}
                >
                  {saving ? 'Creating…' : 'Create team'}
                </Button>
              )}
            </div>
          </CreateStepFlow>
        </CreateFlowPanel>
      </DashboardLayout>
    </AuthGate>
  )
}
