'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { IconInfoCircle, IconTrash } from '@components/icons'
import { Button, CheckboxField, TextInput } from '@components/ui'
import { getAgentDisplayName } from '@lib/agentName'
import { cn } from '@lib/cn'
import { teamSelectionOptions } from '../draft'
import type {
  MicrosoftDirectoryResponse,
  MicrosoftImportReviewStepProps,
  MicrosoftMembersMappingStepProps,
  MicrosoftTeamsMappingStepProps,
} from '../types'

const TEAM_MENU_VIEWPORT_PADDING = 8
const TEAM_MENU_GAP = 4

function MicrosoftTeamDestinationInput({
  directory,
  disabled,
  invalid,
  label,
  onChange,
  value,
}: {
  directory: MicrosoftDirectoryResponse
  disabled: boolean
  invalid: boolean
  label: string
  onChange: (value: string) => void
  value: string
}) {
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<{
    left: number
    top?: number
    bottom?: number
    width: number
  } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const existingTeams = directory.evenfireTeams

  const updateMenuPosition = useCallback(() => {
    const input = inputRef.current
    if (!input) return
    const rect = input.getBoundingClientRect()
    const availableWidth = Math.max(0, window.innerWidth - TEAM_MENU_VIEWPORT_PADDING * 2)
    const width = Math.min(rect.width, availableWidth)
    const left = Math.min(
      Math.max(TEAM_MENU_VIEWPORT_PADDING, rect.left),
      Math.max(TEAM_MENU_VIEWPORT_PADDING, window.innerWidth - width - TEAM_MENU_VIEWPORT_PADDING)
    )
    const spaceBelow = window.innerHeight - rect.bottom - TEAM_MENU_VIEWPORT_PADDING
    const spaceAbove = rect.top - TEAM_MENU_VIEWPORT_PADDING
    const openAbove = spaceBelow < 220 && spaceAbove > spaceBelow

    setMenuPosition({
      left,
      width,
      ...(openAbove
        ? { bottom: window.innerHeight - rect.top + TEAM_MENU_GAP }
        : { top: rect.bottom + TEAM_MENU_GAP }),
    })
  }, [])

  useEffect(() => {
    if (!open) return

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }

    updateMenuPosition()
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', updateMenuPosition, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', updateMenuPosition, true)
    }
  }, [open, updateMenuPosition])

  function openMenu() {
    if (disabled || existingTeams.length === 0) return
    updateMenuPosition()
    setOpen(true)
  }

  const selectedTeam = existingTeams.find(
    team => team.name.trim().toLowerCase() === value.trim().toLowerCase()
  )
  const menu =
    open && menuPosition && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={menuRef}
            className="cu-ms-import__team-menu"
            role="listbox"
            style={{
              top: menuPosition.top,
              bottom: menuPosition.bottom,
              left: menuPosition.left,
              width: menuPosition.width,
            }}
          >
            {existingTeams.length === 0 ? (
              <span className="cu-selection-dropdown__empty">No existing teams available.</span>
            ) : (
              existingTeams.map(team => {
                const selected = team.id === selectedTeam?.id
                return (
                  <button
                    key={team.id}
                    type="button"
                    className="cu-ms-import__team-option"
                    role="option"
                    aria-selected={selected}
                    data-selected={selected ? 'true' : undefined}
                    onClick={() => {
                      onChange(team.name)
                      setOpen(false)
                      window.setTimeout(() => inputRef.current?.focus(), 0)
                    }}
                  >
                    <span>{team.name}</span>
                    <span>{team.memberCount} members</span>
                  </button>
                )
              })
            )}
          </div>,
          document.body
        )
      : null

  return (
    <div className="cu-ms-import__team-combobox" ref={rootRef}>
      <input
        ref={inputRef}
        className={cn('cu-input', invalid && 'cu-input--invalid')}
        value={value}
        onChange={event => onChange(event.target.value)}
        onFocus={openMenu}
        onClick={openMenu}
        disabled={disabled}
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        autoComplete="off"
      />
      <button
        type="button"
        className={cn('cu-ms-import__team-menu-toggle', open && 'is-open')}
        aria-label={`Show existing Evenfire teams for ${label}`}
        disabled={disabled || existingTeams.length === 0}
        onClick={() => {
          if (open) {
            setOpen(false)
            return
          }
          inputRef.current?.focus()
          openMenu()
        }}
      >
        <span aria-hidden="true" />
      </button>
      {menu}
    </div>
  )
}

export function MicrosoftTeamsMappingStep({
  directory,
  teams,
  duplicateTeamIds,
  onReplaceTeams,
  onUpdateTeam,
  onUpdateTeamDestination,
  onAddManualTeam,
}: MicrosoftTeamsMappingStepProps) {
  const selectedImportedTeams = teams.filter(team => !team.manual)
  const allImportedTeamsSelected =
    selectedImportedTeams.length > 0 && selectedImportedTeams.every(team => team.selected)
  const contextOptions = directory.contexts.map(contextId => ({
    value: contextId,
    label: contextId,
  }))
  const agentOptions = directory.agents.map(agentName => ({
    value: agentName,
    label: getAgentDisplayName(agentName),
    description: agentName,
  }))

  return (
    <div className="cu-form-stack cu-agent-form-stack--wide cu-ms-import__table-step">
      <p className="cu-muted">
        We detected these Microsoft Teams. Confirm the destinations you want in Evenfire.
      </p>
      <div className="cu-ms-import__table-wrap">
        <table className="cu-ms-import__table">
          <thead>
            <tr>
              <th className="cu-ms-import__select-column">
                {selectedImportedTeams.length > 0 ? (
                  <input
                    type="checkbox"
                    checked={allImportedTeamsSelected}
                    aria-label="Select all Microsoft Teams"
                    onChange={event =>
                      onReplaceTeams(
                        teams.map(team =>
                          team.manual ? team : { ...team, selected: event.currentTarget.checked }
                        )
                      )
                    }
                  />
                ) : null}
              </th>
              {directory.teams.length > 0 ? <th>Microsoft Team</th> : null}
              <th>Evenfire team</th>
              <th>Contexts</th>
              <th>Agents</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {teams.length === 0 ? (
              <tr>
                <td
                  colSpan={directory.teams.length > 0 ? 6 : 5}
                  className="cu-ms-import__empty-cell"
                >
                  Add Evenfire teams to group the members you import.
                </td>
              </tr>
            ) : null}
            {teams.map(team => {
              const duplicate = duplicateTeamIds.has(team.id)
              return (
                <tr key={team.id} data-disabled={!team.selected || undefined}>
                  <td className="cu-ms-import__select-column">
                    <input
                      type="checkbox"
                      checked={team.selected}
                      disabled={team.manual}
                      aria-label={`Import ${team.externalTeamName || team.name || 'manual team'}`}
                      onChange={event =>
                        onUpdateTeam(team.id, { selected: event.currentTarget.checked })
                      }
                    />
                  </td>
                  {directory.teams.length > 0 ? (
                    <td>
                      {team.externalTeamName || <span className="cu-muted">Not imported</span>}
                    </td>
                  ) : null}
                  <td>
                    <MicrosoftTeamDestinationInput
                      directory={directory}
                      value={team.name}
                      disabled={!team.selected}
                      invalid={duplicate}
                      label={`Evenfire team for ${team.externalTeamName || 'manual team'}`}
                      onChange={value => onUpdateTeamDestination(team.id, value)}
                    />
                    {duplicate ? (
                      <span className="cu-field__error">Name already exists.</span>
                    ) : null}
                  </td>
                  <td>
                    <SelectionDropdown
                      id={`microsoft-team-contexts-${team.id}`}
                      value={team.contextIds}
                      onChange={contextIds => onUpdateTeam(team.id, { contextIds })}
                      options={contextOptions}
                      placeholder="Select contexts"
                      searchPlaceholder="Search contexts..."
                      selectionLabel="Selected contexts"
                      emptyLabel="No contexts available."
                      showSelectedChips={false}
                      disabled={!team.selected}
                    />
                  </td>
                  <td>
                    <SelectionDropdown
                      id={`microsoft-team-agents-${team.id}`}
                      value={team.agentNames}
                      onChange={agentNames => onUpdateTeam(team.id, { agentNames })}
                      options={agentOptions}
                      placeholder="Select agents"
                      searchPlaceholder="Search agents..."
                      selectionLabel="Selected agents"
                      emptyLabel="No agents available."
                      showSelectedChips={false}
                      disabled={!team.selected}
                    />
                  </td>
                  <td>
                    {team.manual ? (
                      <button
                        type="button"
                        className="cu-btn cu-btn--icon cu-btn--danger-icon"
                        aria-label={`Remove ${team.name || 'manual team'}`}
                        title="Remove team"
                        onClick={() => onReplaceTeams(teams.filter(item => item.id !== team.id))}
                      >
                        <IconTrash width={16} height={16} />
                      </button>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <Button variant="secondary" size="sm" onClick={onAddManualTeam}>
        Add team
      </Button>
    </div>
  )
}

export function MicrosoftMembersMappingStep({
  directory,
  teams,
  members,
  onReplaceMembers,
  onUpdateMember,
}: MicrosoftMembersMappingStepProps) {
  const memberTeamOptions = useMemo(
    () => teamSelectionOptions(directory, teams),
    [directory, teams]
  )

  return (
    <div className="cu-form-stack cu-agent-form-stack--wide cu-ms-import__table-step">
      <div className="cu-ms-import__table-wrap">
        <table className="cu-ms-import__table cu-ms-import__member-table">
          <thead>
            <tr>
              <th className="cu-ms-import__select-column">
                <input
                  type="checkbox"
                  checked={members.length > 0 && members.every(member => member.selected)}
                  aria-label="Select all Microsoft members"
                  onChange={event =>
                    onReplaceMembers(
                      members.map(member => ({
                        ...member,
                        selected: event.currentTarget.checked,
                      }))
                    )
                  }
                />
              </th>
              <th>Microsoft user</th>
              <th>Evenfire Member</th>
              {memberTeamOptions.length > 0 ? <th>Teams</th> : null}
            </tr>
          </thead>
          <tbody>
            {members.map(member => (
              <tr key={member.externalSubject} data-disabled={!member.selected || undefined}>
                <td className="cu-ms-import__select-column">
                  <input
                    type="checkbox"
                    checked={member.selected}
                    aria-label={`Import ${member.microsoftDisplayName}`}
                    onChange={event =>
                      onUpdateMember(member.externalSubject, {
                        selected: event.currentTarget.checked,
                      })
                    }
                  />
                </td>
                <td>
                  <span className="cu-ms-import__person">
                    <strong>{member.microsoftDisplayName}</strong>
                    <span>{member.email}</span>
                  </span>
                </td>
                <td>
                  <span className="cu-ms-import__member-inputs">
                    <TextInput
                      value={member.displayName}
                      onChange={event =>
                        onUpdateMember(member.externalSubject, {
                          displayName: event.target.value,
                        })
                      }
                      disabled={!member.selected}
                      aria-label={`Evenfire Member name for ${member.email}`}
                    />
                    <TextInput
                      value={member.email}
                      readOnly
                      disabled
                      aria-label={`Email ${member.email}`}
                    />
                    {member.existingMemberId ? (
                      <span className="cu-ms-import__existing">Existing member</span>
                    ) : null}
                  </span>
                </td>
                {memberTeamOptions.length > 0 ? (
                  <td>
                    <SelectionDropdown
                      id={`microsoft-member-teams-${member.externalSubject}`}
                      value={member.teamRefs}
                      onChange={teamRefs =>
                        onUpdateMember(member.externalSubject, {
                          teamRefs,
                          teamSelectionCustomized: true,
                        })
                      }
                      options={memberTeamOptions}
                      placeholder="Select teams"
                      searchPlaceholder="Search teams..."
                      selectionLabel="Selected teams"
                      emptyLabel="No teams available."
                      showSelectedChips={false}
                      disabled={!member.selected}
                    />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function MicrosoftImportReviewStep({
  reviewTeams,
  options,
  showCreateTeams,
  hasAssignedMembers,
  onUpdateOptions,
}: MicrosoftImportReviewStepProps) {
  return (
    <div className="cu-form-stack cu-agent-form-stack--wide cu-ms-import__table-step">
      <div className="cu-ms-import__table-wrap">
        <table className="cu-ms-import__table cu-ms-import__review-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Contexts</th>
              <th>Agents</th>
            </tr>
          </thead>
          <tbody>
            {reviewTeams.map(team => (
              <tr key={team.key}>
                <td>
                  <div className="cu-ms-import__review-team">
                    <strong className={team.existing ? 'cu-ms-import__existing' : undefined}>
                      {team.name}
                    </strong>
                    {team.members.map(member => (
                      <span className="cu-ms-import__review-member" key={member.externalSubject}>
                        <strong
                          className={member.existingMemberId ? 'cu-ms-import__existing' : undefined}
                        >
                          {member.displayName}
                        </strong>
                        <span>{member.email}</span>
                      </span>
                    ))}
                  </div>
                </td>
                <td>{team.contextIds.join(', ') || 'None'}</td>
                <td>{team.agentNames.map(getAgentDisplayName).join(', ') || 'None'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="cu-ms-import__confirmations">
        {showCreateTeams ? (
          <CheckboxField
            checked={options.createTeams}
            onChange={event => onUpdateOptions({ createTeams: event.currentTarget.checked })}
            label="Create teams"
          />
        ) : null}
        <CheckboxField
          checked={options.createMembers}
          onChange={event => onUpdateOptions({ createMembers: event.currentTarget.checked })}
          label={hasAssignedMembers ? 'Create members and assign teams' : 'Create members'}
        />
        <CheckboxField
          checked={options.sendInvitations}
          onChange={event => onUpdateOptions({ sendInvitations: event.currentTarget.checked })}
          label={
            <span className="cu-ms-import__inline-label">
              Send invitation emails
              <span
                className="cu-help-tooltip"
                tabIndex={0}
                data-tooltip="Every new member receives an invitation to join the organization, download the Desktop App, and configure its Evenfire environment."
                aria-label="Invitation email information"
              >
                <IconInfoCircle width={14} height={14} />
              </span>
            </span>
          }
        />
        <CheckboxField
          checked={options.allowMemberLogin}
          onChange={event => onUpdateOptions({ allowMemberLogin: event.currentTarget.checked })}
          label={
            <span className="cu-ms-import__inline-label">
              Allow members to sign in with Microsoft
              <span
                className="cu-help-tooltip"
                tabIndex={0}
                data-tooltip="Members can accept eligible invitations and sign in to Profile UI or Desktop App without a password. Turning this off requires passwords. Microsoft sign-in also stops when the client secret expires until the integration is updated."
                aria-label="Microsoft member sign-in information"
              >
                <IconInfoCircle width={14} height={14} />
              </span>
            </span>
          }
        />
      </div>
    </div>
  )
}
