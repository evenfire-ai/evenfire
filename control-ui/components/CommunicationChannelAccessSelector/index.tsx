'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { TabBar } from '@components/TabBar'
import { getAgentTeams, getAgentUsers, isSilentApiError } from '@lib/api'
import type {
  CommunicationChannelAccessDirectory,
  CommunicationChannelAccessSelectorProps,
  CommunicationChannelAccessTab,
} from './types'

function userLabel(user: CommunicationChannelAccessDirectory['users'][number]): string {
  return user.displayName || user.name || user.email
}

function uniqueSelected(ids: string[], allowed: Set<string>): string[] {
  return [...new Set(ids)].filter(id => allowed.has(id))
}

export function CommunicationChannelAccessSelector({
  agentName,
  disabled,
  inlineDropdowns = false,
  selectedTeamIds,
  selectedUserIds,
  onSelectedTeamIdsChange,
  onSelectedUserIdsChange,
}: CommunicationChannelAccessSelectorProps) {
  const [directory, setDirectory] = useState<CommunicationChannelAccessDirectory>({
    teams: [],
    users: [],
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<CommunicationChannelAccessTab>('members')
  const [loadedAgentName, setLoadedAgentName] = useState('')
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!agentName.trim()) {
      setDirectory({ teams: [], users: [] })
      setLoadedAgentName('')
      setError('')
      return
    }
    async function load() {
      setLoading(true)
      setLoadedAgentName('')
      setError('')
      try {
        const [users, teams] = await Promise.all([
          getAgentUsers(agentName),
          getAgentTeams(agentName),
        ])
        if (cancelled || !mountedRef.current) return
        setDirectory({
          users: users.items ?? [],
          teams: teams.items ?? [],
        })
        setLoadedAgentName(agentName)
      } catch (err) {
        if (isSilentApiError(err) || cancelled || !mountedRef.current) return
        setError(err instanceof Error ? err.message : 'Failed to load agent access')
      } finally {
        if (!cancelled && mountedRef.current) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [agentName])

  const userOptions = useMemo(
    () =>
      directory.users.map(user => ({
        value: user.id,
        label: userLabel(user),
        description: user.email,
      })),
    [directory.users]
  )
  const teamOptions = useMemo(
    () =>
      directory.teams.map(team => ({
        value: team.id,
        label: team.name,
      })),
    [directory.teams]
  )

  useEffect(() => {
    if (loadedAgentName !== agentName) return
    const allowedUsers = new Set(directory.users.map(user => user.id))
    const allowedTeams = new Set(directory.teams.map(team => team.id))
    const nextUsers = uniqueSelected(selectedUserIds, allowedUsers)
    const nextTeams = uniqueSelected(selectedTeamIds, allowedTeams)
    if (nextUsers.length !== selectedUserIds.length) onSelectedUserIdsChange(nextUsers)
    if (nextTeams.length !== selectedTeamIds.length) onSelectedTeamIdsChange(nextTeams)
  }, [
    directory.teams,
    directory.users,
    agentName,
    loadedAgentName,
    onSelectedTeamIdsChange,
    onSelectedUserIdsChange,
    selectedTeamIds,
    selectedUserIds,
  ])

  return (
    <section className="cu-channel-access">
      <div className="cu-channel-access__header">
        <div>
          <p className="cu-section-title">Communication access</p>
          <p className="cu-muted">
            Select only members or teams that already have access to this agent.
          </p>
        </div>
      </div>
      {!agentName.trim() ? (
        <div className="cu-empty cu-empty--compact">
          Select an agent before granting chat access.
        </div>
      ) : error ? (
        <div className="cu-banner cu-banner--error" role="alert">
          {error}
        </div>
      ) : (
        <div className="cu-channel-access__content">
          <TabBar<CommunicationChannelAccessTab>
            activeValue={activeTab}
            ariaLabel="Communication channel access type"
            className="cu-tabs--flush"
            onChange={setActiveTab}
            options={[
              { value: 'members', label: `Members (${selectedUserIds.length})` },
              { value: 'teams', label: `Teams (${selectedTeamIds.length})` },
            ]}
          />
          {activeTab === 'members' ? (
            <div className="cu-field cu-field--compact">
              <label htmlFor="channel-access-users">Members</label>
              <SelectionDropdown
                key="members"
                id="channel-access-users"
                value={selectedUserIds}
                onChange={onSelectedUserIdsChange}
                options={userOptions}
                placeholder={loading ? 'Loading members...' : 'Select members'}
                searchPlaceholder="Search members..."
                selectionLabel="Selected members"
                emptyLabel={loading ? 'Loading members...' : 'No agent members available.'}
                disabled={disabled || loading}
                inline={inlineDropdowns}
              />
            </div>
          ) : (
            <div className="cu-field cu-field--compact">
              <label htmlFor="channel-access-teams">Teams</label>
              <SelectionDropdown
                key="teams"
                id="channel-access-teams"
                value={selectedTeamIds}
                onChange={onSelectedTeamIdsChange}
                options={teamOptions}
                placeholder={loading ? 'Loading teams...' : 'Select teams'}
                searchPlaceholder="Search teams..."
                selectionLabel="Selected teams"
                emptyLabel={loading ? 'Loading teams...' : 'No agent teams available.'}
                disabled={disabled || loading}
                inline={inlineDropdowns}
              />
            </div>
          )}
        </div>
      )}
    </section>
  )
}
