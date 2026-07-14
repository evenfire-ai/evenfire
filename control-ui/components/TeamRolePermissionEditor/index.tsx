'use client'

import { CheckboxField, Field, TextInput } from '@components/ui'
import type { TeamRole } from '@lib/api'
import {
  formatTeamRole,
  permissionsForTeamRole,
  setDeletePermission,
  setInvitePermission,
} from '@lib/teamRoles'

export function TeamRolePermissionEditor({
  disabled = false,
  idPrefix,
  onChange,
  role,
  showRoleField = true,
}: {
  disabled?: boolean
  idPrefix: string
  onChange: (role: TeamRole) => void
  role: TeamRole
  showRoleField?: boolean
}) {
  const permissions = permissionsForTeamRole(role)

  return (
    <div className="cu-role-permission-editor">
      {showRoleField ? (
        <Field label="Role" htmlFor={`${idPrefix}-role`}>
          <TextInput id={`${idPrefix}-role`} value={formatTeamRole(role)} disabled readOnly />
        </Field>
      ) : null}
      <div className="cu-role-permission-editor__checks">
        <CheckboxField
          checked={permissions.canInviteMembers}
          disabled={disabled}
          label="Can Invite Members"
          onChange={event => onChange(setInvitePermission(role, event.target.checked))}
        />
        <CheckboxField
          checked={permissions.canDeleteMembers}
          disabled={disabled}
          label="Can Delete Members"
          onChange={event => onChange(setDeletePermission(role, event.target.checked))}
        />
      </div>
    </div>
  )
}
