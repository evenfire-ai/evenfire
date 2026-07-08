'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { DashboardLayout } from '@components/DashboardLayout'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { IconSettings } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { IconTrash } from '@components/icons'
import { Button, CheckboxField, Field, TextInput } from '@components/ui'
import { getAdminTeams, inviteControlAdmin } from '@lib/api'
import type { TeamRole } from '@lib/api'
import { permissionsForTeamRole, setDeletePermission, setInvitePermission } from '@lib/teamRoles'

const ADMINS_TAB_HREF = '/profile-admin/admins'

export default function CreateControlAdminInvitationPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()
  const initialEmail = searchParams.get('email') || ''
  const fromMember = searchParams.get('source') === 'member'
  const [step, setStep] = useState(() =>
    initialEmail && searchParams.get('step') === 'review' ? 1 : 0
  )
  const [email, setEmail] = useState(initialEmail)
  const [createDesktopAccess, setCreateDesktopAccess] = useState(false)
  const [teamRoleDrafts, setTeamRoleDrafts] = useState<Record<string, TeamRole>>({})
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([])
  const [loadingTeams, setLoadingTeams] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const normalizedEmail = useMemo(() => email.trim().toLowerCase(), [email])
  const steps = useMemo(() => {
    if (fromMember) return ['Email', 'Review']
    return createDesktopAccess
      ? ['Email', 'Review', 'Teams', 'Send invitation']
      : ['Email', 'Review']
  }, [createDesktopAccess, fromMember])
  const stepDetails = useMemo(
    () =>
      steps.map((label, index) => {
        if (label === 'Email') {
          return {
            description: 'Enter admin email',
            eyebrow: `Step ${index + 1} of ${steps.length}`,
            title: 'Admin email',
            subtitle: 'Send a Control UI admin invitation to this email address.',
          }
        }
        if (label === 'Teams') {
          return {
            description: 'Choose Desktop App teams',
            eyebrow: `Step ${index + 1} of ${steps.length}`,
            title: 'Desktop App access',
            subtitle: 'Select the teams this admin should join as a member.',
          }
        }
        if (label === 'Send invitation') {
          return {
            description: 'Review access',
            eyebrow: `Step ${index + 1} of ${steps.length}`,
            title: 'Send invitation',
            subtitle: 'Send one email for Control UI admin and Desktop App access.',
          }
        }
        return {
          description: 'Confirm invitation',
          eyebrow: `Step ${index + 1} of ${steps.length}`,
          title: 'Review invitation',
          subtitle: 'The invitee will set their username and password after accepting the email.',
        }
      }),
    [steps]
  )
  const canContinue = normalizedEmail.length > 0
  const canSubmit = normalizedEmail.length > 0 && !saving
  const selectedTeamIds = useMemo(() => Object.keys(teamRoleDrafts), [teamRoleDrafts])
  const selectedTeams = useMemo(
    () =>
      selectedTeamIds
        .map(teamId => teams.find(team => team.id === teamId))
        .filter((team): team is { id: string; name: string } => Boolean(team)),
    [selectedTeamIds, teams]
  )
  const teamOptions = useMemo(
    () => teams.map(team => ({ value: team.id, label: team.name })),
    [teams]
  )

  useEffect(() => {
    if (!createDesktopAccess) return
    let cancelled = false
    async function loadTeams() {
      setLoadingTeams(true)
      setError('')
      try {
        const response = await getAdminTeams()
        if (!cancelled) {
          setTeams((response.items || []).map(team => ({ id: team.id, name: team.name })))
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
  }, [createDesktopAccess])

  useEffect(() => {
    if (!createDesktopAccess && step > 1) setStep(1)
  }, [createDesktopAccess, step])

  function canSelectStep(targetStep: number) {
    if (targetStep <= step) return true
    return canContinue && targetStep < steps.length
  }

  async function handleSubmit() {
    if (!canSubmit) return
    const emailInput = document.getElementById('control-admin-email') as HTMLInputElement | null
    if (emailInput && !emailInput.reportValidity()) return
    setSaving(true)
    setError('')
    try {
      await inviteControlAdmin(normalizedEmail, {
        createDesktopAccess: fromMember ? false : createDesktopAccess,
        teams: selectedTeamIds.map(teamId => ({
          teamId,
          role: teamRoleDrafts[teamId] || 'member',
        })),
      })
      showToast('Admin invitation sent.', { tone: 'success' })
      router.push(ADMINS_TAB_HREF)
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : 'Failed to invite admin')
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

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CreateFlowPanel
          header={
            <CreatePageHeader
              icon={<IconSettings />}
              title="Invite admin"
              subtitle="Invite a new Control UI admin."
              backLabel="Back to admins"
              onBack={() => router.push(ADMINS_TAB_HREF)}
              backDisabled={saving}
            />
          }
        >
          <CreateStepFlow
            ariaLabel="Invite admin steps"
            className="cu-create-step-flow--2"
            currentStep={step}
            onStepChange={setStep}
            canSelectStep={canSelectStep}
            steps={stepDetails}
            stepLabels={steps}
            titleId="create-control-admin-step-title"
          >
            {step === 0 ? (
              <div className="cu-form-stack cu-agent-form-stack">
                <Field
                  label="Email"
                  htmlFor="control-admin-email"
                  required
                  description="This email cannot already belong to another Control UI admin or pending admin invitation."
                >
                  <TextInput
                    id="control-admin-email"
                    type="email"
                    value={email}
                    onChange={event => setEmail(event.target.value)}
                    placeholder="admin@example.com"
                    disabled={saving}
                    autoFocus
                  />
                </Field>
              </div>
            ) : null}

            {step === 1 ? (
              <div className="cu-form-stack cu-agent-form-stack">
                <div className="cu-summary-list">
                  <div className="cu-summary-list__row">
                    <span>Email</span>
                    <strong>{normalizedEmail}</strong>
                  </div>
                  <div className="cu-summary-list__row">
                    <span>Access</span>
                    <strong>Control UI admin</strong>
                  </div>
                </div>
                <p className="cu-muted-note--compact">
                  The email link opens Control UI and asks the invitee to choose a username and
                  password.
                </p>
                {!fromMember ? (
                  <CheckboxField
                    checked={createDesktopAccess}
                    disabled={saving}
                    label="Create access to Desktop App"
                    description="Also create this admin as a member for selected teams."
                    onChange={event => setCreateDesktopAccess(event.currentTarget.checked)}
                  />
                ) : null}
              </div>
            ) : null}

            {step === 2 && createDesktopAccess ? (
              <div className="cu-form-stack cu-agent-form-stack">
                <Field label="Teams" htmlFor="control-admin-desktop-teams">
                  <SelectionDropdown
                    id="control-admin-desktop-teams"
                    value={selectedTeamIds}
                    onChange={updateSelectedTeams}
                    options={teamOptions}
                    placeholder={loadingTeams ? 'Loading teams...' : 'Select teams'}
                    searchPlaceholder="Search teams..."
                    selectionLabel="Selected teams"
                    emptyLabel="No teams match your search."
                    showSelectedChips={false}
                    disabled={saving || loadingTeams}
                  />
                </Field>
                {selectedTeams.length > 0 ? (
                  <div className="cu-permission-selection__table cu-table-wrap">
                    <table className="cu-table">
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
                              <td>{team.name}</td>
                              <td className="cu-permission-cell">
                                <input
                                  type="checkbox"
                                  checked={permissions.canInviteMembers}
                                  disabled={saving}
                                  aria-label={`Can invite members for ${team.name}`}
                                  onChange={event =>
                                    updateTeamRole(
                                      team.id,
                                      setInvitePermission(role, event.target.checked)
                                    )
                                  }
                                />
                              </td>
                              <td className="cu-permission-cell">
                                <input
                                  type="checkbox"
                                  checked={permissions.canDeleteMembers}
                                  disabled={saving}
                                  aria-label={`Can delete members for ${team.name}`}
                                  onChange={event =>
                                    updateTeamRole(
                                      team.id,
                                      setDeletePermission(role, event.target.checked)
                                    )
                                  }
                                />
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="cu-btn cu-btn--icon cu-btn--danger-icon"
                                  onClick={() =>
                                    updateSelectedTeams(
                                      selectedTeamIds.filter(teamId => teamId !== team.id)
                                    )
                                  }
                                  disabled={saving}
                                  aria-label={`Remove ${team.name}`}
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
                ) : (
                  <p className="cu-muted-note--compact">No Desktop App teams selected.</p>
                )}
              </div>
            ) : null}

            {step === 3 && createDesktopAccess ? (
              <div className="cu-form-stack cu-agent-form-stack">
                <div className="cu-summary-list">
                  <div className="cu-summary-list__row">
                    <span>Email</span>
                    <strong>{normalizedEmail}</strong>
                  </div>
                  <div className="cu-summary-list__row">
                    <span>Access</span>
                    <strong>Control UI admin and Desktop App member</strong>
                  </div>
                  <div className="cu-summary-list__row">
                    <span>Teams</span>
                    <strong>
                      {selectedTeams.length
                        ? selectedTeams.map(team => team.name).join(', ')
                        : 'None selected'}
                    </strong>
                  </div>
                </div>
              </div>
            ) : null}

            {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

            <div className="cu-create-actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => (step === 0 ? router.push(ADMINS_TAB_HREF) : setStep(step - 1))}
                disabled={saving}
              >
                {step === 0 ? 'Cancel' : 'Back'}
              </Button>
              {step < steps.length - 1 ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setStep(current => Math.min(steps.length - 1, current + 1))}
                  disabled={saving || !canContinue}
                >
                  Continue
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleSubmit()}
                  disabled={!canSubmit}
                >
                  {saving ? 'Sending...' : 'Send invite'}
                </Button>
              )}
            </div>
          </CreateStepFlow>
        </CreateFlowPanel>
      </DashboardLayout>
    </AuthGate>
  )
}
