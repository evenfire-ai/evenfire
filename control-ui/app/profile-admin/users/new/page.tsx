'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { DataTable, RowActionMenu } from '@clerum/frontend-components'
import { AuthGate } from '@components/AuthGate'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { DashboardLayout } from '@components/DashboardLayout'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { IconUsers } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { Button, CheckboxField, Field, TextInput } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import { createMemberFromControlAdmin, getAdminTeams, inviteAdminTeamMember } from '@lib/api'
import type { TeamRole } from '@lib/api'
import { permissionsForTeamRole, setDeletePermission, setInvitePermission } from '@lib/teamRoles'

const STEPS = ['Member', 'Team'] as const

const STEP_DETAILS = [
  {
    description: 'Enter invite details',
    title: 'Member identity',
    subtitle: 'Set the name and email address used for the invitation.',
  },
  {
    description: 'Choose team placement',
    title: 'Team assignment',
    subtitle: 'Place the invited member on a team now, or leave them unassigned.',
  },
] as const

function formatCreateMemberError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Failed to create member'
  if (message.includes('A member with this email')) {
    return 'A member with this email already exists. Open the existing member and add them to more teams instead.'
  }
  return message
}

export default function CreateMemberPage() {
  const router = useRouter()
  const { showToast } = useToast()
  const searchParams = useSearchParams()
  const hasFocusedInitialFieldRef = useRef(false)

  const [step, setStep] = useState(0)
  const [email, setEmail] = useState(() => searchParams.get('email') || '')
  const [name, setName] = useState(() => searchParams.get('name') || '')
  const sourceAdminId = searchParams.get('adminId') || ''
  const [reuseAdminPassword, setReuseAdminPassword] = useState(
    () =>
      searchParams.get('reusePassword') === 'true' ||
      (typeof window !== 'undefined' &&
        Boolean(
          searchParams.get('adminId') &&
          window.sessionStorage.getItem(
            `control-admin-member-reuse-password:${searchParams.get('adminId')}`
          ) === 'true'
        ))
  )
  const [teamRoleDrafts, setTeamRoleDrafts] = useState<Record<string, TeamRole>>({})
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([])
  const [loadingTeams, setLoadingTeams] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const hasTeams = teams.length > 0
  const teamOptions = useMemo(
    () =>
      teams.map(team => ({
        value: team.id,
        label: team.name,
      })),
    [teams]
  )
  const selectedTeamIds = useMemo(() => Object.keys(teamRoleDrafts), [teamRoleDrafts])
  const selectedTeams = useMemo(
    () =>
      selectedTeamIds
        .map(teamId => teams.find(team => team.id === teamId))
        .filter((team): team is { id: string; name: string } => Boolean(team)),
    [selectedTeamIds, teams]
  )

  useEffect(() => {
    let cancelled = false
    async function loadTeams() {
      setLoadingTeams(true)
      setError('')
      try {
        const response = await getAdminTeams()
        if (!cancelled) {
          const items = Array.isArray(response.items) ? response.items : []
          setTeams(items.map(team => ({ id: team.id, name: team.name })))
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load teams')
        }
      } finally {
        if (!cancelled) setLoadingTeams(false)
      }
    }
    void loadTeams()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (loadingTeams || saving || hasFocusedInitialFieldRef.current) return

    const activeElement = document.activeElement
    if (activeElement && activeElement !== document.body) return

    document.getElementById('new-user-name')?.focus()
    hasFocusedInitialFieldRef.current = true
  }, [loadingTeams, saving])

  const canSubmit = useMemo(
    () => name.trim().length > 0 && email.trim().length > 0 && !saving && !loadingTeams,
    [email, loadingTeams, name, saving]
  )
  const canContinue = step === 0 ? name.trim().length > 0 && email.trim().length > 0 : !loadingTeams
  function isMemberIdentityValid() {
    if (name.trim().length === 0) return false
    const emailInput = document.getElementById('new-user-email') as HTMLInputElement | null
    return emailInput ? emailInput.checkValidity() : email.trim().length > 0
  }
  function canSelectStep(targetStep: number) {
    if (targetStep <= step) return true
    return !loadingTeams && isMemberIdentityValid()
  }

  async function handleCreateMember() {
    if (!canSubmit) return
    setSaving(true)
    setError('')
    try {
      const payload = {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        role: 'member' as const,
        teams: selectedTeamIds.map(teamId => ({
          teamId,
          role: teamRoleDrafts[teamId] || ('member' as const),
        })),
      }
      if (sourceAdminId && reuseAdminPassword) {
        await createMemberFromControlAdmin(sourceAdminId, {
          reusePassword: true,
          teams: payload.teams,
        })
        window.sessionStorage.removeItem(`control-admin-member-reuse-password:${sourceAdminId}`)
        showToast(`Member created for ${payload.email}.`, { tone: 'success' })
      } else {
        await inviteAdminTeamMember(null, payload)
        showToast(`Invitation sent to ${payload.email}.`, { tone: 'success' })
      }
      router.push(CONTROL_ROUTES.usersAndTeams.users)
    } catch (createError) {
      setError(formatCreateMemberError(createError))
    } finally {
      setSaving(false)
    }
  }

  function updateSelectedTeams(nextTeamIds: string[]) {
    setTeamRoleDrafts(current => {
      const next: Record<string, TeamRole> = {}
      nextTeamIds.forEach(teamId => {
        next[teamId] = current[teamId] || 'member'
      })
      return next
    })
  }

  function updateTeamRole(teamId: string, role: TeamRole) {
    setTeamRoleDrafts(current => ({
      ...current,
      [teamId]: role,
    }))
  }

  function handleContinue() {
    if (step === 0) {
      const emailInput = document.getElementById('new-user-email') as HTMLInputElement | null
      if (emailInput && !emailInput.reportValidity()) return
    }
    setStep(current => Math.min(STEPS.length - 1, current + 1))
  }

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CreateFlowPanel
          header={
            <CreatePageHeader
              icon={<IconUsers />}
              title="Create member"
              subtitle="Create a pending invitation and send the invitation email."
              backLabel="Back to members"
              onBack={() => router.push(CONTROL_ROUTES.usersAndTeams.users)}
              backDisabled={saving}
            />
          }
        >
          <CreateStepFlow
            ariaLabel="Create member steps"
            className="cu-create-step-flow--2"
            currentStep={step}
            onStepChange={setStep}
            canSelectStep={canSelectStep}
            steps={STEP_DETAILS}
            stepLabels={STEPS}
            titleId="create-member-step-title"
          >
            {step === 0 ? (
              <div className="cu-form-stack cu-agent-form-stack">
                <Field label="Name" htmlFor="new-user-name" required>
                  <TextInput
                    id="new-user-name"
                    value={name}
                    onChange={event => setName(event.target.value)}
                    placeholder="Full name"
                    disabled={saving}
                    autoFocus
                  />
                </Field>

                <Field label="Email" htmlFor="new-user-email" required>
                  <TextInput
                    id="new-user-email"
                    type="email"
                    value={email}
                    onChange={event => setEmail(event.target.value)}
                    placeholder="user@example.com"
                    disabled={saving}
                  />
                </Field>
                {sourceAdminId ? (
                  <Field label="Password setup">
                    <CheckboxField
                      checked={reuseAdminPassword}
                      disabled={saving}
                      label="Reuse current password for member"
                      description={
                        reuseAdminPassword
                          ? 'No member invitation email will be sent.'
                          : 'An invitation will be sent to this email and must be accepted before Desktop App access is active.'
                      }
                      onChange={event => setReuseAdminPassword(event.currentTarget.checked)}
                    />
                  </Field>
                ) : null}
              </div>
            ) : null}

            {step === 1 ? (
              <div className="cu-form-stack cu-agent-form-stack">
                {loadingTeams ? (
                  <div className="cu-muted cu-muted-note--compact">Loading teams...</div>
                ) : hasTeams ? (
                  <Field label="Teams" htmlFor="new-user-teams">
                    <div className="cu-team-member-picker">
                      <SelectionDropdown
                        id="new-user-teams"
                        value={selectedTeamIds}
                        onChange={updateSelectedTeams}
                        options={teamOptions}
                        placeholder="Select teams or leave empty"
                        searchPlaceholder="Search teams..."
                        selectionLabel="Selected teams"
                        emptyLabel="No teams match your search."
                        showSelectedChips={false}
                        disabled={saving || loadingTeams}
                      />
                      {selectedTeams.length > 0 ? (
                        <div className="cu-permission-selection">
                          <div className="cu-permission-selection__table cu-table-wrap">
                            <DataTable className="eft-table cu-table">
                              <thead>
                                <tr>
                                  <th>Team</th>
                                  <th>Can Invite Members</th>
                                  <th>Can Delete Members</th>
                                  <th className="cu-table__actions-heading">Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {selectedTeams.map(team => {
                                  const role = teamRoleDrafts[team.id] || 'member'
                                  const permissions = permissionsForTeamRole(role)
                                  return (
                                    <tr key={team.id}>
                                      <td>
                                        <span className="cu-permission-row__title">
                                          {team.name}
                                        </span>
                                      </td>
                                      <td className="cu-permission-cell">
                                        <input
                                          type="checkbox"
                                          checked={permissions.canInviteMembers}
                                          disabled={saving}
                                          onChange={event =>
                                            updateTeamRole(
                                              team.id,
                                              setInvitePermission(role, event.target.checked)
                                            )
                                          }
                                          aria-label={`Can invite members for ${team.name}`}
                                        />
                                      </td>
                                      <td className="cu-permission-cell">
                                        <input
                                          type="checkbox"
                                          checked={permissions.canDeleteMembers}
                                          disabled={saving}
                                          onChange={event =>
                                            updateTeamRole(
                                              team.id,
                                              setDeletePermission(role, event.target.checked)
                                            )
                                          }
                                          aria-label={`Can delete members for ${team.name}`}
                                        />
                                      </td>
                                      <td>
                                        <RowActionMenu
                                          ariaLabel={`Actions for ${team.name}`}
                                          actions={[
                                            {
                                              key: 'remove',
                                              label: 'Remove',
                                              danger: true,
                                              disabled: saving,
                                              onSelect: () =>
                                                updateSelectedTeams(
                                                  selectedTeamIds.filter(
                                                    teamId => teamId !== team.id
                                                  )
                                                ),
                                            },
                                          ]}
                                        />
                                      </td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </DataTable>
                          </div>
                        </div>
                      ) : (
                        <p className="cu-permission-selection__empty">
                          No teams selected. The invitation will stay unassigned.
                        </p>
                      )}
                    </div>
                  </Field>
                ) : (
                  <div className="cu-muted cu-muted-note--compact">
                    No teams are available. The invitation can still be sent.
                  </div>
                )}
              </div>
            ) : null}

            {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

            <div className="cu-create-actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  step === 0 ? router.push(CONTROL_ROUTES.usersAndTeams.users) : setStep(step - 1)
                }
                disabled={saving}
              >
                {step === 0 ? 'Cancel' : 'Back'}
              </Button>
              {step < STEPS.length - 1 ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleContinue}
                  disabled={saving || !canContinue}
                >
                  Continue
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleCreateMember()}
                  disabled={!canSubmit}
                >
                  {sourceAdminId && reuseAdminPassword
                    ? saving
                      ? 'Creating…'
                      : 'Create member'
                    : saving
                      ? 'Sending…'
                      : 'Send invite'}
                </Button>
              )}
            </div>
          </CreateStepFlow>
        </CreateFlowPanel>
      </DashboardLayout>
    </AuthGate>
  )
}
