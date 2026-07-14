import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, DataTable, EmptyState, ReferenceTag } from '@components/Common'
import type { TeamMember } from '../../../src/types'
import { useAuthContext } from '../contexts/AuthContext'
import { useNavigationContext } from '../contexts/NavigationContext'
import { useTeamsDataController } from '../hooks/domain/useTeamsDataController'
import { clickableRowProps } from '../lib/clickableRowProps'

type TeamFloatingTooltip =
  | {
      kind: 'member'
      top: number
      left: number
      placement: 'top' | 'bottom'
      title: string
      email: string
      role: string
    }
  | {
      kind: 'agent'
      top: number
      left: number
      placement: 'top' | 'bottom'
      title: string
      items: string[]
      overflowCount: number
    }

export function TeamsPage() {
  const { busy } = useAuthContext()
  const { teams, loading, error, teamDirectory, teamDirectoryHydrated, truncated, refresh } =
    useTeamsDataController()
  const { selectedTeam, handleOpenContextDetails, handleOpenTeamDetails } = useNavigationContext()
  const [floatingTooltip, setFloatingTooltip] = useState<TeamFloatingTooltip | null>(null)

  const setFloatingTooltipNode = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !floatingTooltip) return
      node.style.setProperty('--team-floating-tooltip-top', `${floatingTooltip.top}px`)
      node.style.setProperty('--team-floating-tooltip-left', `${floatingTooltip.left}px`)
    },
    [floatingTooltip]
  )

  const memberInitial = (member: TeamMember): string => {
    const base = (member.name || member.email || '').trim()
    return base ? base.charAt(0).toUpperCase() : '?'
  }

  const memberDisplayName = (member: TeamMember): string => {
    const name = (member.name || '').trim()
    return name || member.email
  }

  const hideFloatingTooltip = () => {
    setFloatingTooltip(null)
  }

  const resolveTooltipPosition = (
    anchorElement: HTMLElement,
    tooltipWidth: number
  ): { left: number; top: number; placement: 'top' | 'bottom' } => {
    const rect = anchorElement.getBoundingClientRect()
    const viewportPadding = 12
    const halfWidth = tooltipWidth / 2
    const left = Math.max(
      viewportPadding + halfWidth,
      Math.min(rect.left + rect.width / 2, window.innerWidth - viewportPadding - halfWidth)
    )
    const prefersTop = rect.top > 120
    return {
      left,
      top: prefersTop ? rect.top - 8 : rect.bottom + 8,
      placement: prefersTop ? 'top' : 'bottom',
    }
  }

  const showMemberTooltip = (member: TeamMember, anchorElement: HTMLElement) => {
    const position = resolveTooltipPosition(anchorElement, 220)
    setFloatingTooltip({
      kind: 'member',
      ...position,
      title: memberDisplayName(member),
      email: member.email,
      role: member.role,
    })
  }

  const showAgentTooltip = (agentNames: string[], anchorElement: HTMLElement) => {
    const visibleItems = agentNames.slice(0, 6)
    const overflowCount = Math.max(0, agentNames.length - visibleItems.length)
    const position = resolveTooltipPosition(anchorElement, 240)
    setFloatingTooltip({
      kind: 'agent',
      ...position,
      title: `Active agents (${agentNames.length})`,
      items: visibleItems,
      overflowCount,
    })
  }

  const renderMemberStack = (members: TeamMember[], teamId: string, limit: number) => {
    if (!members.length) return <span className="team-cell-muted">No members</span>
    const visible = members.slice(0, limit)
    return (
      <span className="team-member-avatar-stack" aria-label={`${members.length} members`}>
        {visible.map(member => (
          <button
            key={`${teamId}-${member.id}`}
            className="team-member-avatar-chip"
            type="button"
            aria-label={`${memberDisplayName(member)} (${member.role})`}
            aria-describedby="team-member-tooltip-description"
            onClick={event => event.stopPropagation()}
            onMouseEnter={event => showMemberTooltip(member, event.currentTarget)}
            onMouseLeave={hideFloatingTooltip}
            onFocus={event => showMemberTooltip(member, event.currentTarget)}
            onBlur={hideFloatingTooltip}
          >
            <span className="team-member-initial-avatar">{memberInitial(member)}</span>
          </button>
        ))}
        {members.length > limit && (
          <span className="team-member-overflow">+{members.length - limit}</span>
        )}
      </span>
    )
  }

  return (
    <section className="page">
      <div className="page-header">
        <h2>Members & Teams</h2>
        <p className="muted">Browse all teams and review their members, contexts, and agents.</p>
      </div>

      <div className="page-layout">
        <section className="page-card teams-board-card">
          {loading && !teams.length && (
            <EmptyState title="Loading" body="Fetching teams and members..." />
          )}
          {error && !teams.length && !loading && (
            <div className="composer-error" role="alert">
              <p className="error-text">{error}</p>
            </div>
          )}
          {truncated && (
            <div className="teams-directory-warning" role="status">
              <span>
                Initial load returned a partial team directory. Load all teams to include every
                workspace team.
              </span>
              <Button
                onClick={() => void refresh()}
                disabled={busy || loading}
                color="neutral"
                size="xs"
                variant="ghost"
              >
                {loading ? 'Loading...' : 'Load all teams'}
              </Button>
            </div>
          )}
          {!loading && !error && !teams.length && (
            <EmptyState title="No teams" body="No teams were returned for this account." />
          )}
          {Boolean(teams.length) && (
            <>
              <DataTable frameless fullBleed className="teams-data-table">
                <thead>
                  <tr>
                    <th className="da-table__col-header" scope="col">
                      Team
                    </th>
                    <th className="da-table__col-header" scope="col">
                      Members
                    </th>
                    <th className="da-table__col-header da-table__col-header--center" scope="col">
                      Agents
                    </th>
                    <th className="da-table__col-header da-table__col-header--center" scope="col">
                      Contexts
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {teams.map(team => {
                    const rowData = teamDirectory[team.id]
                    const rowMembers = rowData?.members || []
                    const rowContexts = rowData?.contextIds || []
                    const rowAgents = rowData?.agentNames || []
                    const isSelectedTeam = selectedTeam === team.id
                    const showRowSkeleton = !rowData && (loading || !teamDirectoryHydrated)
                    return (
                      <tr
                        key={team.id}
                        className={`da-table__row--clickable${
                          isSelectedTeam ? ' da-table__row--selected' : ''
                        }`}
                        {...clickableRowProps(() => handleOpenTeamDetails(team.id), {
                          selected: isSelectedTeam,
                        })}
                      >
                        <td className="da-table__cell">
                          <span className="team-table-name-cell">
                            <span className="team-list-title-row">
                              <span className="team-list-name">{team.name}</span>
                            </span>
                            <span className="team-list-subtitle">Workspace team</span>
                          </span>
                        </td>
                        <td className="da-table__cell">
                          <span className="team-table-personnel-cell">
                            {showRowSkeleton ? (
                              <span
                                className="teams-inline-skeleton teams-inline-skeleton-members"
                                aria-hidden="true"
                              />
                            ) : rowData ? (
                              renderMemberStack(rowMembers, team.id, 4)
                            ) : (
                              <span className="team-cell-muted">No members</span>
                            )}
                          </span>
                        </td>
                        <td className="da-table__cell da-table__cell--center">
                          <span className="team-table-count-cell">
                            {showRowSkeleton ? (
                              <span
                                className="teams-inline-skeleton teams-inline-skeleton-count"
                                aria-hidden="true"
                              />
                            ) : rowAgents.length > 0 ? (
                              <button
                                className="team-agent-count-chip"
                                type="button"
                                aria-label={`${rowAgents.length} active agents`}
                                aria-describedby="team-agent-tooltip-description"
                                onClick={event => event.stopPropagation()}
                                onMouseEnter={event =>
                                  showAgentTooltip(rowAgents, event.currentTarget)
                                }
                                onMouseLeave={hideFloatingTooltip}
                                onFocus={event => showAgentTooltip(rowAgents, event.currentTarget)}
                                onBlur={hideFloatingTooltip}
                              >
                                <strong>{rowAgents.length}</strong>
                              </button>
                            ) : (
                              <strong>{rowAgents.length}</strong>
                            )}
                            <span className="team-list-subtitle">
                              {showRowSkeleton ? 'Loading' : rowData ? 'Active' : 'Hidden'}
                            </span>
                          </span>
                        </td>
                        <td className="da-table__cell da-table__cell--center">
                          <span className="team-table-context-cell">
                            {showRowSkeleton ? (
                              <span
                                className="teams-inline-skeleton teams-inline-skeleton-context"
                                aria-hidden="true"
                              />
                            ) : (
                              Boolean(rowContexts.length) && (
                                <span className="team-row-context-badges">
                                  {rowContexts.slice(0, 2).map(contextId => (
                                    <ReferenceTag
                                      key={contextId}
                                      kind="context"
                                      onClick={event => {
                                        event.stopPropagation()
                                        handleOpenContextDetails(contextId)
                                      }}
                                      title={contextId}
                                      aria-label={`Open context ${contextId}`}
                                    >
                                      {contextId}
                                    </ReferenceTag>
                                  ))}
                                </span>
                              )
                            )}
                            {!showRowSkeleton && !rowContexts.length && (
                              <span className="team-cell-muted">No contexts</span>
                            )}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </DataTable>
            </>
          )}
        </section>
      </div>
      {floatingTooltip &&
        createPortal(
          <div
            ref={setFloatingTooltipNode}
            className={`team-floating-tooltip ${floatingTooltip.placement === 'top' ? 'is-top' : 'is-bottom'}`}
            role="tooltip"
          >
            {floatingTooltip.kind === 'member' ? (
              <>
                <strong className="team-floating-tooltip-name">{floatingTooltip.title}</strong>
                <span className="team-floating-tooltip-meta">{floatingTooltip.email}</span>
                <span className="team-floating-tooltip-meta">{floatingTooltip.role}</span>
              </>
            ) : (
              <>
                <strong className="team-floating-tooltip-name">{floatingTooltip.title}</strong>
                <span className="team-floating-tooltip-list">
                  {floatingTooltip.items.map(agentName => (
                    <span key={agentName} className="team-floating-tooltip-item">
                      {agentName}
                    </span>
                  ))}
                  {floatingTooltip.overflowCount > 0 && (
                    <span className="team-floating-tooltip-item">
                      +{floatingTooltip.overflowCount} more
                    </span>
                  )}
                </span>
              </>
            )}
          </div>,
          document.body
        )}
      <span id="team-member-tooltip-description" className="visually-hidden">
        Focus to preview member email and role details.
      </span>
      <span id="team-agent-tooltip-description" className="visually-hidden">
        Focus to preview active agent names for this team.
      </span>
    </section>
  )
}
