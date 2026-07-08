import { useEffect, useMemo, useState } from 'react'
import { DataTable, EmptyState, TabButton } from '@components/Common'
import { PageBreadcrumb } from '@components/PageBreadcrumb'
import { ResourceBreadcrumbSwitcher } from '@components/ResourceBreadcrumbSwitcher'
import { useNavigationContext } from '../contexts/NavigationContext'
import { useTeamsDataController } from '../hooks/domain/useTeamsDataController'
import { clickableRowProps } from '../lib/clickableRowProps'
import type { TeamTab } from './TeamDetailsPage.types'

export function TeamDetailsPage() {
  const { teamDirectory, loading, teamDirectoryHydrated, teams } = useTeamsDataController()
  const {
    selectedTeam,
    selectedContext,
    selectedAgent,
    handleOpenContextDetails,
    handleOpenAgentWorkspace,
    handleOpenTeamDetails,
    handleBackToTeams,
  } = useNavigationContext()

  const [activeTab, setActiveTab] = useState<TeamTab>('members')

  useEffect(() => {
    setActiveTab('members')
  }, [selectedTeam])

  const selectedTeamDetails = useMemo(() => {
    if (!selectedTeam) return null
    const team = teams.find(entry => entry.id === selectedTeam)
    if (!team) return null
    return team
  }, [selectedTeam, teams])

  const selectedTeamData = selectedTeam ? teamDirectory[selectedTeam] : undefined
  const selectedMembers = selectedTeamData?.members || []
  const selectedContextIds = selectedTeamData?.contextIds || []
  const selectedAgentNames = selectedTeamData?.agentNames || []
  const selectedDataPending =
    Boolean(selectedTeam) && !selectedTeamData && (loading || !teamDirectoryHydrated)
  const selectedTeamName = selectedTeamDetails?.name || selectedTeam || 'Team details'
  const teamOptions = useMemo(
    () =>
      [...teams]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(team => ({ id: team.id, label: team.name })),
    [teams]
  )

  const selectedContextRows = useMemo(
    () => [...selectedContextIds].sort((a, b) => a.localeCompare(b)).map(id => ({ id })),
    [selectedContextIds]
  )

  const selectedAgentRows = useMemo(
    () => [...selectedAgentNames].sort((a, b) => a.localeCompare(b)).map(name => ({ name })),
    [selectedAgentNames]
  )

  if (!selectedTeam || !selectedTeamDetails) {
    return (
      <section className="page team-detail-page">
        <PageBreadcrumb
          ariaLabel="Team breadcrumb"
          items={[
            { label: 'Teams', onClick: handleBackToTeams },
            { label: selectedTeamName, onClick: handleBackToTeams },
          ]}
        />
        <section className="teams-detail-page-card">
          <EmptyState
            title="Team not found"
            body="This team is not available in your workspace scope."
          />
        </section>
      </section>
    )
  }

  return (
    <section className="page team-detail-page">
      <PageBreadcrumb
        ariaLabel="Team breadcrumb"
        items={[
          { label: 'Teams', onClick: handleBackToTeams },
          {
            label: (
              <ResourceBreadcrumbSwitcher
                ariaLabel="Switch team"
                emptyLabel="No teams"
                options={teamOptions}
                selectedId={selectedTeam}
                selectedLabel={selectedTeamName}
                onSelect={handleOpenTeamDetails}
              />
            ),
          },
        ]}
      />
      <section className="teams-detail-page-card">
        <div className="page-card__header">
          <div>
            <h3 className="team-detail-title-row">
              <span>{selectedTeamDetails.name}</span>
            </h3>
            <p className="muted">Review members, contexts, and mapped agents for this team.</p>
          </div>
        </div>

        <div className="page-tabs team-tabs">
          <TabButton
            active={activeTab === 'members'}
            className="team-tab"
            onClick={() => setActiveTab('members')}
          >
            Members
          </TabButton>
          <TabButton
            active={activeTab === 'contexts'}
            className="team-tab"
            onClick={() => setActiveTab('contexts')}
          >
            Contexts
          </TabButton>
          <TabButton
            active={activeTab === 'agents'}
            className="team-tab"
            onClick={() => setActiveTab('agents')}
          >
            Agents
          </TabButton>
        </div>

        {activeTab === 'members' && (
          <div className="team-resource-list">
            {selectedDataPending && (
              <div className="teams-detail-skeleton-list" aria-hidden="true">
                <div className="teams-detail-skeleton-row" />
                <div className="teams-detail-skeleton-row" />
                <div className="teams-detail-skeleton-row" />
              </div>
            )}
            {!selectedDataPending && (
              <>
                {!selectedMembers.length && (
                  <EmptyState
                    title="No members"
                    body="No active team members were returned by the API."
                  />
                )}
                {selectedMembers.length > 0 && (
                  <DataTable className="team-members-data-table">
                    <thead>
                      <tr>
                        <th className="da-table__col-header" scope="col">
                          Name
                        </th>
                        <th className="da-table__col-header" scope="col">
                          Email
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedMembers.map(member => (
                        <tr key={member.id}>
                          <td className="da-table__cell">
                            <span className="context-members-name">
                              {member.name || member.email || '-'}
                            </span>
                          </td>
                          <td className="da-table__cell">
                            <span className="context-members-email">{member.email || '-'}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === 'contexts' && (
          <div className="team-resource-list">
            {selectedDataPending && (
              <div className="teams-detail-skeleton-list" aria-hidden="true">
                <div className="teams-detail-skeleton-row" />
                <div className="teams-detail-skeleton-row" />
              </div>
            )}
            {!selectedDataPending && (
              <>
                {!selectedContextRows.length && (
                  <EmptyState
                    title="No contexts"
                    body="No team contexts are currently mapped for this team."
                  />
                )}
                {!!selectedContextRows.length && (
                  <DataTable className="team-contexts-data-table">
                    <thead>
                      <tr>
                        <th className="da-table__col-header" scope="col">
                          Context
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedContextRows.map(row => (
                        <tr
                          key={row.id}
                          className={`da-table__row--clickable${
                            selectedContext === row.id ? ' da-table__row--selected' : ''
                          }`}
                          {...clickableRowProps(() => handleOpenContextDetails(row.id), {
                            ariaLabel: `Open context ${row.id}`,
                            selected: selectedContext === row.id,
                          })}
                        >
                          <td className="da-table__cell">
                            <span className="context-id-cell">
                              <strong>{row.id}</strong>
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === 'agents' && (
          <div className="team-resource-list">
            {selectedDataPending && (
              <div className="teams-detail-skeleton-list" aria-hidden="true">
                <div className="teams-detail-skeleton-row" />
                <div className="teams-detail-skeleton-row" />
              </div>
            )}
            {!selectedDataPending && (
              <>
                {!selectedAgentRows.length && (
                  <EmptyState
                    title="No agents"
                    body="No team agents are currently mapped for this team."
                  />
                )}
                {!!selectedAgentRows.length && (
                  <DataTable className="team-agents-data-table">
                    <thead>
                      <tr>
                        <th className="da-table__col-header" scope="col">
                          Agent
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedAgentRows.map(row => (
                        <tr
                          key={row.name}
                          className={`da-table__row--clickable${
                            selectedAgent === row.name ? ' da-table__row--selected' : ''
                          }`}
                          {...clickableRowProps(() => handleOpenAgentWorkspace(row.name), {
                            ariaLabel: `Open agent ${row.name}`,
                            selected: selectedAgent === row.name,
                          })}
                        >
                          <td className="da-table__cell">
                            <span className="context-id-cell">
                              <strong>{row.name}</strong>
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </section>
  )
}
