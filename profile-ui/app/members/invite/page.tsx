'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { Button } from '@components/Button'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { FormField } from '@components/FormField'
import { ProfileShell } from '@components/ProfileShell'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { IconMembers } from '@components/Sidebar/icons'
import { TextInput } from '@components/TextInput'
import { useToast } from '@components/Toast'
import { IconTrash } from '@components/icons'
import { getManageableTeams, inviteManagedMember, isSilentApiError } from '@lib/api'
import {
  formatTeamRole,
  permissionsForTeamRole,
  setDeletePermission,
  setInvitePermission,
} from '@lib/teamRoles'
import type { ManageableTeam, Role } from '@/app/types/profile'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const STEPS = ['Member', 'Team'] as const
const STEP_DETAILS = [
  {
    description: 'Enter invite details',
    title: 'Member identity',
    subtitle: 'Set the email address used for the invitation.',
  },
  {
    description: 'Choose team placement',
    title: 'Team assignment',
    subtitle: 'Place the invited member on teams you can manage.',
  },
] as const

export default function InviteMemberPage() {
  const router = useRouter()
  const { showToast } = useToast()
  const hasFocusedInitialFieldRef = useRef(false)
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [teams, setTeams] = useState<ManageableTeam[]>([])
  const [inviteRoles, setInviteRoles] = useState<Record<string, Role>>({})
  const [loadingTeams, setLoadingTeams] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const emailValid = EMAIL_PATTERN.test(email.trim())
  const nameValid = Boolean(name.trim())
  const selectedTeamIds = useMemo(() => Object.keys(inviteRoles), [inviteRoles])
  const selectedTeams = useMemo(
    () =>
      selectedTeamIds
        .map(teamId => teams.find(team => team.id === teamId))
        .filter((team): team is ManageableTeam => Boolean(team)),
    [selectedTeamIds, teams]
  )
  const teamOptions = useMemo(
    () =>
      teams.map(team => ({
        value: team.id,
        label: team.name,
        badge: formatTeamRole(team.role),
      })),
    [teams]
  )
  const canSubmit = nameValid && emailValid && selectedTeams.length > 0 && !saving && !loadingTeams
  const canContinue = step === 0 ? nameValid && emailValid : !loadingTeams

  useEffect(() => {
    let cancelled = false
    async function loadTeams() {
      setLoadingTeams(true)
      setError('')
      try {
        const response = await getManageableTeams()
        if (!cancelled) setTeams(Array.isArray(response.items) ? response.items : [])
      } catch (nextError) {
        if (cancelled || isSilentApiError(nextError)) return
        setError(nextError instanceof Error ? nextError.message : 'Failed to load teams')
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
    document.getElementById('invite-member-name')?.focus()
    hasFocusedInitialFieldRef.current = true
  }, [loadingTeams, saving])

  function canSelectStep(targetStep: number) {
    if (targetStep <= step) return true
    return nameValid && emailValid && !loadingTeams
  }

  function updateSelectedTeams(nextTeamIds: string[]) {
    setInviteRoles(current => {
      const next: Record<string, Role> = {}
      nextTeamIds.forEach(teamId => {
        next[teamId] = current[teamId] || 'member'
      })
      return next
    })
  }

  function updateInviteRole(team: ManageableTeam, role: Role) {
    const nextRole = role === 'admin' && !team.canAssignLeader ? 'inviter' : role
    setInviteRoles(current => ({ ...current, [team.id]: nextRole }))
  }

  async function sendInvite() {
    if (!canSubmit) return
    setSaving(true)
    setError('')
    try {
      await inviteManagedMember(
        email.trim().toLowerCase(),
        name.trim(),
        selectedTeams.map(team => ({
          teamId: team.id,
          role: inviteRoles[team.id] || 'member',
        }))
      )
      showToast('Invitation sent.', { tone: 'success' })
      router.push('/members')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to send invitation')
    } finally {
      setSaving(false)
    }
  }

  return (
    <AuthGate>
      <ProfileShell currentRoute="members">
        <div className="profile-page profile-page--members">
          <CreateFlowPanel
            header={
              <CreatePageHeader
                icon={<IconMembers />}
                title="Invite member"
                subtitle="Send an invitation and assign team permissions."
                backLabel="Back to members"
                onBack={() => router.push('/members')}
                backDisabled={saving}
              />
            }
          >
            <CreateStepFlow
              ariaLabel="Invite member steps"
              className="cu-create-step-flow--2"
              currentStep={step}
              onStepChange={setStep}
              canSelectStep={canSelectStep}
              steps={STEP_DETAILS}
              stepLabels={STEPS}
              titleId="invite-member-step-title"
            >
              {step === 0 ? (
                <div className="cu-agent-form-stack">
                  <FormField label="Name">
                    <TextInput
                      id="invite-member-name"
                      type="text"
                      value={name}
                      onChange={event => setName(event.target.value)}
                      placeholder="Full Name"
                      disabled={saving}
                      autoComplete="name"
                      autoFocus
                    />
                  </FormField>
                  <FormField label="Email">
                    <TextInput
                      id="invite-member-email"
                      type="email"
                      value={email}
                      onChange={event => setEmail(event.target.value)}
                      placeholder="user@example.com"
                      disabled={saving}
                      autoComplete="email"
                      autoFocus
                    />
                  </FormField>
                </div>
              ) : null}

              {step === 1 ? (
                <div className="cu-agent-form-stack cu-agent-form-stack--wide">
                  {loadingTeams ? (
                    <div className="cu-muted cu-muted-note--compact">Loading teams...</div>
                  ) : teams.length > 0 ? (
                    <div className="form-field">
                      <span className="form-field__label">Teams</span>
                      <div className="cu-team-member-picker">
                        <SelectionDropdown
                          id="invite-member-teams"
                          value={selectedTeamIds}
                          onChange={updateSelectedTeams}
                          options={teamOptions}
                          placeholder="Select teams"
                          searchPlaceholder="Search teams..."
                          selectionLabel="Selected teams"
                          emptyLabel="No teams match your search."
                          showSelectedChips={false}
                          disabled={saving}
                        />
                        {selectedTeams.length > 0 ? (
                          <PermissionTable
                            busy={saving}
                            rows={selectedTeams.map(team => ({
                              team,
                              role: inviteRoles[team.id] || 'member',
                            }))}
                            onRemove={team =>
                              updateSelectedTeams(selectedTeamIds.filter(id => id !== team.id))
                            }
                            onRoleChange={updateInviteRole}
                          />
                        ) : (
                          <p className="body-copy">Select at least one team.</p>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="message message--plain">
                      No teams are available for your current permissions.
                    </div>
                  )}
                </div>
              ) : null}

              {error ? <div className="message message--error">{error}</div> : null}

              <div className="cu-create-actions">
                <Button
                  variant="ghost"
                  onClick={() => (step === 0 ? router.push('/members') : setStep(step - 1))}
                  disabled={saving}
                >
                  {step === 0 ? 'Cancel' : 'Back'}
                </Button>
                {step < STEPS.length - 1 ? (
                  <Button onClick={() => setStep(1)} disabled={saving || !canContinue}>
                    Continue
                  </Button>
                ) : (
                  <Button onClick={() => void sendInvite()} disabled={!canSubmit}>
                    {saving ? 'Sending...' : 'Send invite'}
                  </Button>
                )}
              </div>
            </CreateStepFlow>
          </CreateFlowPanel>
        </div>
      </ProfileShell>
    </AuthGate>
  )
}

function PermissionTable({
  busy,
  rows,
  onRemove,
  onRoleChange,
}: {
  busy: boolean
  rows: Array<{ team: ManageableTeam; role: Role }>
  onRemove: (team: ManageableTeam) => void
  onRoleChange: (team: ManageableTeam, role: Role) => void
}) {
  return (
    <div className="members-table-wrap">
      <table className="members-table">
        <thead>
          <tr>
            <th>Team</th>
            <th>Can Invite Members</th>
            <th>Can Delete Members</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ team, role }) => {
            const permissions = permissionsForTeamRole(role)
            return (
              <tr key={team.id}>
                <td>{team.name}</td>
                <td className="permission-cell">
                  <input
                    type="checkbox"
                    checked={permissions.canInviteMembers}
                    onChange={event =>
                      onRoleChange(team, setInvitePermission(role, event.target.checked))
                    }
                    disabled={busy}
                    aria-label={`Can invite members for ${team.name}`}
                  />
                </td>
                <td className="permission-cell">
                  <input
                    type="checkbox"
                    checked={permissions.canDeleteMembers}
                    onChange={event =>
                      onRoleChange(team, setDeletePermission(role, event.target.checked))
                    }
                    disabled={busy || !team.canAssignLeader}
                    aria-label={`Can delete members for ${team.name}`}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="icon-button icon-button--danger"
                    onClick={() => onRemove(team)}
                    disabled={busy}
                    aria-label={`Remove ${team.name}`}
                  >
                    <IconTrash />
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
