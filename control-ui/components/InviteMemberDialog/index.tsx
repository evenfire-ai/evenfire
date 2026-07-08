'use client'

import { IconX } from '@components/icons'
import { Button, Field, SelectInput, TextInput } from '@components/ui'
import { formatTeamRole } from '@lib/teamRoles'
import type { InviteMemberDialogProps } from './types'

export function InviteMemberDialog({
  isOpen,
  embedded = false,
  busy,
  name,
  email,
  error,
  lockedTeamId,
  onClose,
  onNameChange,
  onEmailChange,
  onRoleChange,
  onSubmit,
  onTeamChange,
  role,
  submitLabel = 'Send invite',
  teamId,
  teams,
  title = 'Invite member by email',
}: InviteMemberDialogProps) {
  if (!isOpen) return null

  const teamLabel = teams.find(team => team.id === teamId)?.name || ''
  const showTeamSelect = teams.length > 0

  const content = (
    <>
      {embedded ? null : (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <div className="cu-modal-panel__head">
            <strong id="invite-member-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
              {title}
            </strong>
            <button
              type="button"
              className="cu-btn cu-btn--icon cu-btn--ghost"
              onClick={onClose}
              disabled={busy}
              aria-label="Close"
            >
              <IconX width={18} height={18} />
            </button>
          </div>
          <p className="cu-muted" style={{ margin: 0, fontSize: '0.875rem' }}>
            An invitation link will be sent and remain available for 48 hours.
          </p>
        </div>
      )}

      {lockedTeamId ? (
        <Field label="Team" htmlFor="invite-member-team">
          <TextInput
            id="invite-member-team"
            value={teamLabel}
            disabled
            placeholder="Selected team"
          />
        </Field>
      ) : showTeamSelect ? (
        <Field label="Team" htmlFor="invite-member-team">
          <SelectInput
            id="invite-member-team"
            value={teamId}
            onChange={event => onTeamChange(event.target.value)}
            disabled={busy}
          >
            <option value="">No team</option>
            {teams.map(team => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </SelectInput>
        </Field>
      ) : null}

      <Field label="Name" htmlFor="invite-member-name" required>
        <TextInput
          id="invite-member-name"
          value={name}
          onChange={event => onNameChange(event.target.value)}
          placeholder="Member full name"
          disabled={busy}
          autoFocus={!showTeamSelect && !lockedTeamId}
        />
      </Field>

      <Field label="Email" htmlFor="invite-member-email" required>
        <TextInput
          id="invite-member-email"
          value={email}
          onChange={event => onEmailChange(event.target.value)}
          placeholder="invitee@evenfire.com"
          disabled={busy}
          autoFocus={showTeamSelect || Boolean(lockedTeamId)}
        />
      </Field>

      <Field label="Role" htmlFor="invite-member-role" required>
        <SelectInput
          id="invite-member-role"
          value={role}
          onChange={event => onRoleChange(event.target.value as typeof role)}
          disabled={busy}
        >
          <option value="member">{formatTeamRole('member')}</option>
          <option value="inviter">{formatTeamRole('inviter')}</option>
          <option value="admin">{formatTeamRole('admin')}</option>
        </SelectInput>
      </Field>

      {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

      <div className="cu-modal-panel__foot">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={onSubmit}
          disabled={busy || !name.trim() || !email.trim()}
        >
          {busy ? 'Sending…' : submitLabel}
        </Button>
      </div>
    </>
  )

  if (embedded) return content

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '1rem',
      }}
      role="presentation"
      onClick={event => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div
        className="cu-modal-panel"
        style={{ width: 'min(30rem, 96vw)' }}
        role="dialog"
        aria-labelledby="invite-member-title"
        onClick={event => event.stopPropagation()}
      >
        {content}
      </div>
    </div>
  )
}
