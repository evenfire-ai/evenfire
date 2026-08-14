'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { TabBar } from '@components/TabBar'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import { useToast } from '@components/Toast'
import { CONTROL_ROUTES } from '@constants/routes'
import { getAgentDisplayName } from '@lib/agentName'
import { buildContextUpdatePayload, contextMutationError } from '@lib/contextMutation'
import { DashboardLayout } from '../../../components/DashboardLayout'
import { IconFolder, IconGroupWork } from '../../../components/Sidebar/icons'
import { IconMoreHorizontal, IconX } from '../../../components/icons'
import {
  AdminUser,
  ContextResource,
  ContextSharedFileSystemRef,
  ContextSpec,
  ContextTeam,
  ContextUser,
  HostResource,
  SharedFileSystemResource,
  TeamListItem,
  apiSend,
  createContext,
  deleteContext,
  getAdminTeamContexts,
  getAdminTeams,
  getAdminUserContexts,
  getAdminUsers,
  getContext,
  getContextTeams,
  getContextUsers,
  getHosts,
  getMcpServers,
  getSharedFileSystems,
  updateAdminTeamContexts,
  updateAdminUserContexts,
  updateContext,
} from '../../../lib/api'

type ContextTab = 'connectors' | 'agent-files' | 'agents' | 'teams' | 'members'
const CONTEXT_TABS: ContextTab[] = ['connectors', 'agents', 'teams', 'members']

const TAB_LABELS: Record<ContextTab, string> = {
  connectors: 'Connectors',
  'agent-files': 'Agent Files',
  agents: 'Agents',
  teams: 'Teams',
  members: 'Members',
}

function parseContextTab(value: string | undefined): ContextTab {
  return CONTEXT_TABS.includes(value as ContextTab) ? (value as ContextTab) : 'connectors'
}

const CONNECTOR_COLUMNS: TableHeaderColumn[] = [
  { key: 'connector', label: 'Connector', minWidth: '14rem' },
  { key: 'actions', label: 'Actions', width: '6rem', align: 'right' },
]

const SHARED_FILE_COLUMNS: TableHeaderColumn[] = [
  { key: 'shared-filesystem', label: 'SharedFileSystem', minWidth: '14rem' },
  { key: 'mount-path', label: 'Mount path' },
  { key: 'actions', label: 'Actions', width: '6rem', align: 'right' },
]

const AGENT_COLUMNS: TableHeaderColumn[] = [
  { key: 'agent', label: 'Agent', minWidth: '14rem' },
  { key: 'namespace', label: 'Namespace', width: '12rem' },
]

const TEAM_COLUMNS: TableHeaderColumn[] = [
  { key: 'team', label: 'Team', minWidth: '14rem' },
  { key: 'actions', label: 'Actions', width: '6rem', align: 'right' },
]

const MEMBER_COLUMNS: TableHeaderColumn[] = [
  { key: 'member', label: 'Member', minWidth: '14rem' },
  { key: 'email', label: 'Email' },
  { key: 'actions', label: 'Actions', width: '6rem', align: 'right' },
]

function ContextActionsMenu({
  busy,
  editing,
  onEdit,
  onDelete,
}: {
  busy: boolean
  editing: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleDocClick(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    function handleEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleDocClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleDocClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open])

  return (
    <div ref={ref} className="cu-kebab">
      <button
        type="button"
        aria-label="Context actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="cu-btn cu-btn--icon cu-btn--ghost cu-kebab__trigger"
        onClick={() => setOpen(value => !value)}
        disabled={busy}
      >
        <IconMoreHorizontal width={16} height={16} />
      </button>
      {open ? (
        <div role="menu" className="cu-kebab__menu">
          <button
            type="button"
            role="menuitem"
            className="cu-kebab__item"
            disabled={editing}
            onClick={() => {
              setOpen(false)
              onEdit()
            }}
          >
            Edit context
          </button>
          <button
            type="button"
            role="menuitem"
            className="cu-kebab__item cu-kebab__item--danger"
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default function ContextDetailsPage() {
  const params = useParams<{ name: string; tab?: string }>()
  const router = useRouter()
  const { showToast } = useToast()

  const routeName = decodeURIComponent(params.name || '')
  const isNew = routeName === 'new'

  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [availableServers, setAvailableServers] = useState<string[]>([])
  const [allHosts, setAllHosts] = useState<HostResource[]>([])
  const [linkedHosts, setLinkedHosts] = useState<Array<{ name: string; namespace: string }>>([])
  const [contextUsers, setContextUsers] = useState<ContextUser[]>([])
  const [contextTeams, setContextTeams] = useState<ContextTeam[]>([])
  const [resolvedContextId, setResolvedContextId] = useState(isNew ? '' : routeName)
  const [contextResourceVersion, setContextResourceVersion] = useState<string | undefined>()

  const [contextNameDraft, setContextNameDraft] = useState(isNew ? '' : routeName)
  const [displayNameDraft, setDisplayNameDraft] = useState('')
  const [descriptionDraft, setDescriptionDraft] = useState('')
  // The raw spec exactly as it arrived from the server. A context PUT is a
  // full-replace: spreading this on save preserves any additive spec field the
  // form doesn't model yet (e.g. spec.gfs) instead of dropping it on a rename.
  const [loadedSpec, setLoadedSpec] = useState<Record<string, unknown>>({})
  const [mcpServersDraft, setMcpServersDraft] = useState<string[]>([])
  const [sharedFileSystemsDraft, setSharedFileSystemsDraft] = useState<
    ContextSharedFileSystemRef[]
  >([])
  const [availableSfses, setAvailableSfses] = useState<string[]>([])
  const [sfsAddName, setSfsAddName] = useState('')
  const [sfsAddMount, setSfsAddMount] = useState('')

  const [editing, setEditing] = useState(isNew)
  const [savedDescription, setSavedDescription] = useState('')
  const [savedContextName, setSavedContextName] = useState('')
  const [savedDisplayName, setSavedDisplayName] = useState('')

  const [activeTab, setActiveTab] = useState<ContextTab>(() => parseContextTab(params.tab))

  const [allTeams, setAllTeams] = useState<TeamListItem[]>([])
  const [allUsers, setAllUsers] = useState<AdminUser[]>([])
  const [selectedTeamIdsToAdd, setSelectedTeamIdsToAdd] = useState<string[]>([])
  const [selectedUserIdsToAdd, setSelectedUserIdsToAdd] = useState<string[]>([])

  const [showAddTeam, setShowAddTeam] = useState(false)
  const [showAddUser, setShowAddUser] = useState(false)
  const [showAddMcpServer, setShowAddMcpServer] = useState(false)
  const [showAddAgent, setShowAddAgent] = useState(false)
  const [selectedAgentNamesToAdd, setSelectedAgentNamesToAdd] = useState<string[]>([])
  const [selectedMcpServerNamesToAdd, setSelectedMcpServerNamesToAdd] = useState<string[]>([])
  const { confirm, confirmDialog } = useConfirmDialog()

  useEffect(() => {
    setContextNameDraft(isNew ? '' : routeName)
    setResolvedContextId(isNew ? '' : routeName)
  }, [isNew, routeName])

  useEffect(() => {
    if (isNew) {
      router.replace(CONTROL_ROUTES.contexts.new)
    }
  }, [isNew, router])

  useEffect(() => {
    setActiveTab(parseContextTab(params.tab))
  }, [params.tab])

  function contextTabHref(tab: ContextTab): string {
    return CONTROL_ROUTES.contexts.tab(routeName, tab)
  }

  function selectTab(tab: ContextTab) {
    setActiveTab(tab)
    router.replace(contextTabHref(tab))
  }

  useEffect(() => {
    async function loadReferenceData() {
      try {
        const [serversData, teamsData, usersData] = await Promise.all([
          getMcpServers(),
          getAdminTeams(),
          getAdminUsers(''),
        ])
        const names = (serversData.items || [])
          .map(item => item.metadata?.name || '')
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
        setAvailableServers(names)
        setAllTeams(Array.isArray(teamsData.items) ? teamsData.items : [])
        setAllUsers(Array.isArray(usersData.items) ? usersData.items : [])
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load reference data')
      }
    }
    void loadReferenceData()
  }, [])

  useEffect(() => {
    if (isNew) {
      setLoaded(true)
      return
    }

    async function loadContextDetails() {
      setBusy(true)
      setError('')
      try {
        const context = await getContext(routeName)
        const spec = (context.spec || {}) as Partial<ContextSpec>
        setLoadedSpec((context.spec || {}) as Record<string, unknown>)
        const metadata = (context.metadata || {}) as ContextResource['metadata']
        const resolvedName = metadata?.name || spec.contextId || routeName
        const resolvedContext = spec.contextId || resolvedName
        setContextResourceVersion(metadata?.resourceVersion)
        setContextNameDraft(resolvedName)
        setSavedContextName(resolvedName)
        setResolvedContextId(resolvedContext)
        setDisplayNameDraft(spec.displayName || '')
        setSavedDisplayName(spec.displayName || '')
        setDescriptionDraft(spec.description || '')
        setSavedDescription(spec.description || '')
        const servers = Array.isArray(spec.mcpServers)
          ? Array.from(
              new Set(
                spec.mcpServers
                  .map(String)
                  .map(v => v.trim())
                  .filter(Boolean)
              )
            )
          : []
        setMcpServersDraft(servers)
        const sfsRefs = Array.isArray(spec.sharedFileSystems)
          ? spec.sharedFileSystems
              .filter((r): r is ContextSharedFileSystemRef => Boolean(r && r.name && r.mountPath))
              .map(r => ({ name: r.name, mountPath: r.mountPath }))
          : []
        setSharedFileSystemsDraft(sfsRefs)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load context')
      } finally {
        setBusy(false)
        setLoaded(true)
      }
    }

    void loadContextDetails()
  }, [isNew, routeName])

  // Pull the cluster's SharedFileSystems once for the "attach" picker.
  useEffect(() => {
    let cancelled = false
    async function loadSfses() {
      try {
        const r = await getSharedFileSystems()
        if (cancelled) return
        const names = ((r.items || []) as SharedFileSystemResource[])
          .map(s => s.metadata?.name || '')
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
        setAvailableSfses(names)
      } catch {
        // Non-fatal — picker just won't suggest names.
      }
    }
    void loadSfses()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (isNew || !resolvedContextId.trim()) {
      setAllHosts([])
      setLinkedHosts([])
      setContextUsers([])
      setContextTeams([])
      return
    }

    async function loadAssociations() {
      setError('')
      try {
        const [hostsData, usersData, teamsData] = await Promise.all([
          getHosts(),
          getContextUsers(resolvedContextId),
          getContextTeams(resolvedContextId),
        ])
        const hosts = (hostsData.items || []) as HostResource[]
        setAllHosts(hosts)
        const linked = hosts
          .filter(host => String(host.spec?.contextRef || '').trim() === resolvedContextId)
          .map(host => ({
            name: host.metadata?.name || '-',
            namespace: host.metadata?.namespace || 'default',
          }))
          .sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`))
        setLinkedHosts(linked)
        setContextUsers(Array.isArray(usersData.items) ? usersData.items : [])
        setContextTeams(Array.isArray(teamsData.items) ? teamsData.items : [])
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load context associations')
      }
    }

    void loadAssociations()
  }, [isNew, resolvedContextId])

  const availableAgentsToAttach = useMemo(
    () =>
      allHosts
        .map(host => ({
          name: String(host.metadata?.name || '').trim(),
          contextRef: String(host.spec?.contextRef || '').trim(),
          displayName: getAgentDisplayName(String(host.metadata?.name || ''), allHosts),
        }))
        .filter(agent => agent.name && agent.contextRef !== resolvedContextId)
        .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.name.localeCompare(b.name)),
    [allHosts, resolvedContextId]
  )

  function toggleServer(name: string) {
    setMcpServersDraft(prev => {
      return prev.includes(name) ? prev.filter(v => v !== name) : [...prev, name]
    })
  }

  const canSave = useMemo(
    () => !busy && contextNameDraft.trim().length > 0,
    [busy, contextNameDraft]
  )

  function startEditing() {
    setSavedDescription(descriptionDraft)
    setSavedContextName(contextNameDraft)
    setSavedDisplayName(displayNameDraft)
    setEditing(true)
  }

  function cancelEditing() {
    setDescriptionDraft(savedDescription)
    setContextNameDraft(savedContextName)
    setDisplayNameDraft(savedDisplayName)
    setEditing(false)
    setError('')
  }

  async function save() {
    if (!canSave) return
    const trimmedDisplay = displayNameDraft.trim()
    const contextId = contextNameDraft.trim()

    setBusy(true)
    setError('')
    try {
      if (isNew) {
        // Create: no prior server spec to preserve — build a fresh spec.
        // The visible name lives in spec.displayName; omit it when empty so an
        // unset display stays absent, not "".
        const createSpec: ContextSpec = {
          contextId,
          ...(trimmedDisplay ? { displayName: trimmedDisplay } : {}),
          description: descriptionDraft.trim(),
          mcpServers: mcpServersDraft,
          sharedFileSystems: sharedFileSystemsDraft,
        }
        await createContext({ metadata: { name: contextId }, spec: createSpec })
        const nextName = encodeURIComponent(contextId)
        router.replace(CONTROL_ROUTES.contexts.detail(nextName))
      } else {
        // Full-replace PUT: spread the spec exactly as it was loaded so additive
        // fields the form doesn't model (e.g. spec.gfs) survive a rename, then
        // overwrite only the fields the form owns.
        const nextSpec: Record<string, unknown> = {
          ...loadedSpec,
          contextId,
          description: descriptionDraft.trim(),
          mcpServers: mcpServersDraft,
          sharedFileSystems: sharedFileSystemsDraft,
        }
        // Clearing the display name must REMOVE it, not leave the spread's stale
        // value — so a delete is required, the empty-omit ternary no longer suffices.
        if (trimmedDisplay) nextSpec.displayName = trimmedDisplay
        else delete nextSpec.displayName
        // Optimistic concurrency: carry the loaded resourceVersion so a stale
        // edit 409s instead of clobbering a concurrent write, and track the
        // version the server echoes back for the next save.
        const updated = await updateContext(
          routeName,
          buildContextUpdatePayload(contextResourceVersion, nextSpec as unknown as ContextSpec)
        )
        setContextResourceVersion(updated.metadata?.resourceVersion ?? contextResourceVersion)
        setResolvedContextId(contextId)
        setSavedDescription(descriptionDraft)
        setSavedContextName(contextNameDraft)
        setSavedDisplayName(trimmedDisplay)
        setEditing(false)
      }
      showToast('Context saved.', { tone: 'success' })
    } catch (e) {
      setError(contextMutationError(e, 'Failed to save context'))
    } finally {
      setBusy(false)
    }
  }

  async function saveMcpServers(nextServers: string[]) {
    setBusy(true)
    setError('')
    try {
      // Full-replace PUT: spread the loaded spec so additive fields the form
      // doesn't model (e.g. spec.gfs) survive a connector edit, then overwrite
      // only the fields this handler owns (all re-echoed from current state).
      const nextSpec: Record<string, unknown> = {
        ...loadedSpec,
        contextId: resolvedContextId,
        description: descriptionDraft.trim(),
        mcpServers: nextServers,
        sharedFileSystems: sharedFileSystemsDraft,
      }
      // Echo the persisted display name; a cleared name must REMOVE it, not leave
      // the spread's stale value — so a delete is required (mirrors save()).
      if (savedDisplayName.trim()) nextSpec.displayName = savedDisplayName.trim()
      else delete nextSpec.displayName
      const updated = await updateContext(
        routeName,
        buildContextUpdatePayload(contextResourceVersion, nextSpec as unknown as ContextSpec)
      )
      setContextResourceVersion(updated.metadata?.resourceVersion ?? contextResourceVersion)
      setMcpServersDraft(nextServers)
      showToast('Connectors updated.', { tone: 'success' })
    } catch (e) {
      setError(contextMutationError(e, 'Failed to update connectors'))
    } finally {
      setBusy(false)
    }
  }

  async function saveSharedFileSystems(nextRefs: ContextSharedFileSystemRef[]) {
    setBusy(true)
    setError('')
    try {
      // Full-replace PUT: spread the loaded spec so additive fields the form
      // doesn't model (e.g. spec.gfs) survive an SFS edit, then overwrite only
      // the fields this handler owns (all re-echoed from current state).
      const nextSpec: Record<string, unknown> = {
        ...loadedSpec,
        contextId: resolvedContextId,
        description: descriptionDraft.trim(),
        mcpServers: mcpServersDraft,
        sharedFileSystems: nextRefs,
      }
      // Echo the persisted display name; a cleared name must REMOVE it, not leave
      // the spread's stale value — so a delete is required (mirrors save()).
      if (savedDisplayName.trim()) nextSpec.displayName = savedDisplayName.trim()
      else delete nextSpec.displayName
      const updated = await updateContext(
        routeName,
        buildContextUpdatePayload(contextResourceVersion, nextSpec as unknown as ContextSpec)
      )
      setContextResourceVersion(updated.metadata?.resourceVersion ?? contextResourceVersion)
      setSharedFileSystemsDraft(nextRefs)
      showToast('Shared filesystems updated.', { tone: 'success' })
    } catch (e) {
      setError(contextMutationError(e, 'Failed to update shared filesystems'))
    } finally {
      setBusy(false)
    }
  }

  async function addTeamsToContext() {
    if (selectedTeamIdsToAdd.length === 0 || !resolvedContextId) return
    setBusy(true)
    setError('')
    try {
      await Promise.all(
        selectedTeamIdsToAdd.map(async teamId => {
          const current = await getAdminTeamContexts(teamId)
          const next = Array.from(new Set([...(current.contextIds || []), resolvedContextId]))
          await updateAdminTeamContexts(teamId, next)
        })
      )
      const addedCount = selectedTeamIdsToAdd.length
      setSelectedTeamIdsToAdd([])
      showToast(
        addedCount === 1 ? 'Team added to context.' : `${addedCount} teams added to context.`,
        { tone: 'success' }
      )
      const refreshed = await getContextTeams(resolvedContextId)
      setContextTeams(Array.isArray(refreshed.items) ? refreshed.items : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add teams')
    } finally {
      setBusy(false)
    }
  }

  async function removeTeamFromContext(teamId: string) {
    if (!resolvedContextId) return
    const team = contextTeams.find(item => item.id === teamId)
    const shouldRemove = await confirm({
      title: 'Remove Team From Context',
      message: `Remove ${team?.name || 'this team'} from ${resolvedContextId}?`,
      confirmLabel: 'Remove team',
      tone: 'danger',
    })
    if (!shouldRemove) return

    setBusy(true)
    setError('')
    try {
      const current = await getAdminTeamContexts(teamId)
      const next = (current.contextIds || []).filter(id => id !== resolvedContextId)
      await updateAdminTeamContexts(teamId, next)
      showToast('Team removed from context.', { tone: 'success' })
      setContextTeams(prev => prev.filter(t => t.id !== teamId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove team')
    } finally {
      setBusy(false)
    }
  }

  async function addUsersToContext() {
    if (selectedUserIdsToAdd.length === 0 || !resolvedContextId) return
    setBusy(true)
    setError('')
    try {
      await Promise.all(
        selectedUserIdsToAdd.map(async userId => {
          const current = await getAdminUserContexts(userId)
          const next = Array.from(new Set([...(current.contextIds || []), resolvedContextId]))
          await updateAdminUserContexts(userId, next)
        })
      )
      const addedCount = selectedUserIdsToAdd.length
      setSelectedUserIdsToAdd([])
      showToast(
        addedCount === 1 ? 'Member added to context.' : `${addedCount} members added to context.`,
        { tone: 'success' }
      )
      const refreshed = await getContextUsers(resolvedContextId)
      setContextUsers(Array.isArray(refreshed.items) ? refreshed.items : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add members')
    } finally {
      setBusy(false)
    }
  }

  async function removeUserFromContext(userId: string) {
    if (!resolvedContextId) return
    const user = contextUsers.find(item => item.id === userId)
    const shouldRemove = await confirm({
      title: 'Remove Member From Context',
      message: `Remove ${user?.displayName || user?.name || user?.email || 'this member'} from ${resolvedContextId}?`,
      confirmLabel: 'Remove member',
      tone: 'danger',
    })
    if (!shouldRemove) return

    setBusy(true)
    setError('')
    try {
      const current = await getAdminUserContexts(userId)
      const next = (current.contextIds || []).filter(id => id !== resolvedContextId)
      await updateAdminUserContexts(userId, next)
      showToast('Member removed from context.', { tone: 'success' })
      setContextUsers(prev => prev.filter(u => u.id !== userId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove member')
    } finally {
      setBusy(false)
    }
  }

  async function addAgentsToContext() {
    if (selectedAgentNamesToAdd.length === 0 || !resolvedContextId.trim()) return

    const hostsByName = new Map(
      allHosts.map(host => [String(host.metadata?.name || '').trim(), host] as const)
    )
    const selectedHosts = selectedAgentNamesToAdd
      .map(agentName => hostsByName.get(agentName))
      .filter((host): host is HostResource => Boolean(host))
    if (selectedHosts.length !== selectedAgentNamesToAdd.length) {
      setError('One or more selected agents could not be loaded. Please refresh and try again.')
      return
    }

    const movingAgents = selectedHosts
      .map(host => ({
        name: String(host.metadata?.name || '').trim(),
        contextRef: String(host.spec?.contextRef || '').trim(),
      }))
      .filter(agent => agent.contextRef && agent.contextRef !== resolvedContextId)

    setBusy(true)
    setError('')
    try {
      await Promise.all(
        selectedHosts.map(host =>
          apiSend('PUT', `/api/v1/admin/hosts/${encodeURIComponent(host.metadata?.name || '')}`, {
            spec: {
              ...(host.spec || {}),
              contextRef: resolvedContextId,
            },
          })
        )
      )

      const refreshedHostsData = await getHosts()
      const refreshedHosts = (refreshedHostsData.items || []) as HostResource[]
      setAllHosts(refreshedHosts)
      const linked = refreshedHosts
        .filter(item => String(item.spec?.contextRef || '').trim() === resolvedContextId)
        .map(item => ({
          name: item.metadata?.name || '-',
          namespace: item.metadata?.namespace || 'default',
        }))
        .sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`))
      setLinkedHosts(linked)
      setSelectedAgentNamesToAdd([])
      showToast(
        selectedHosts.length === 1
          ? movingAgents.length === 1
            ? 'Agent moved to context.'
            : 'Agent added to context.'
          : `${selectedHosts.length} agents added to context.`,
        { tone: 'success' }
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add agents')
    } finally {
      setBusy(false)
    }
  }

  async function onDelete() {
    if (isNew) return
    const shouldDelete = await confirm({
      title: 'Delete Context',
      message: `Delete context ${routeName}?`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!shouldDelete) return

    setBusy(true)
    setError('')
    try {
      await deleteContext(routeName)
      showToast(`Context ${routeName} deleted.`, { tone: 'success' })
      router.push(CONTROL_ROUTES.contexts.root)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete context')
    } finally {
      setBusy(false)
    }
  }

  const teamIdsInContext = useMemo(() => new Set(contextTeams.map(t => t.id)), [contextTeams])
  const userIdsInContext = useMemo(() => new Set(contextUsers.map(u => u.id)), [contextUsers])
  const teamOptions = useMemo(
    () =>
      allTeams
        .filter(team => !teamIdsInContext.has(team.id))
        .map(team => ({ value: team.id, label: team.name })),
    [allTeams, teamIdsInContext]
  )
  const memberOptions = useMemo(
    () =>
      allUsers
        .filter(user => !userIdsInContext.has(user.id))
        .map(user => ({
          value: user.id,
          label: user.displayName || user.name || user.email || user.id,
          description: user.email || user.id,
          badge: user.activeTeamCount === 1 ? '1 team' : `${user.activeTeamCount} teams`,
        })),
    [allUsers, userIdsInContext]
  )
  const agentOptions = useMemo(
    () =>
      availableAgentsToAttach.map(agent => ({
        value: agent.name,
        label: agent.displayName,
        description: agent.contextRef ? `Currently in ${agent.contextRef}` : agent.name,
      })),
    [availableAgentsToAttach]
  )
  const connectorOptions = useMemo(
    () =>
      availableServers
        .filter(server => !mcpServersDraft.includes(server))
        .map(server => ({ value: server, label: server })),
    [availableServers, mcpServersDraft]
  )

  if (!loaded && !isNew) {
    return (
      <DashboardLayout isDetailPage>
        <CreateFlowPanel
          className="cu-detail-flow-panel"
          header={
            <CreatePageHeader
              icon={<IconGroupWork />}
              title={routeName || 'Context'}
              subtitle="Loading context details..."
              backLabel="Back to contexts"
              onBack={() => router.push(CONTROL_ROUTES.contexts.root)}
              backDisabled
              actions={
                <div
                  className="cu-skeleton cu-skeleton--cell"
                  style={{ width: '2rem', height: '2rem' }}
                />
              }
            />
          }
        >
          <TabBar<ContextTab>
            ariaLabel="Context sections"
            activeValue={activeTab}
            className="cu-tabs--compact"
            onChange={selectTab}
            options={CONTEXT_TABS.map(tab => ({
              value: tab,
              label: TAB_LABELS[tab],
              href: contextTabHref(tab),
              disabled: true,
            }))}
          />
        </CreateFlowPanel>
        <div className="cu-card">
          <div className="cu-card__body">
            <div
              className="cu-skeleton cu-skeleton--cell"
              style={{ width: '6rem', height: '0.75rem', marginBottom: '1rem' }}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div>
                <div
                  className="cu-skeleton cu-skeleton--cell"
                  style={{ width: '100%', height: '2.5rem', marginBottom: '0.75rem' }}
                />
                <div
                  className="cu-skeleton cu-skeleton--cell"
                  style={{ width: '80%', height: '2.5rem' }}
                />
              </div>
              <div>
                <div
                  className="cu-skeleton cu-skeleton--cell"
                  style={{ width: '90%', height: '2.5rem', marginBottom: '0.75rem' }}
                />
                <div
                  className="cu-skeleton cu-skeleton--cell"
                  style={{ width: '70%', height: '2.5rem' }}
                />
              </div>
            </div>
          </div>
        </div>
      </DashboardLayout>
    )
  }
  if (isNew) {
    return (
      <DashboardLayout isDetailPage>
        <div className="cu-card">
          <div className="cu-card__body">Redirecting to the dedicated create-context page...</div>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout isDetailPage>
      <CreateFlowPanel
        className="cu-detail-flow-panel"
        header={
          <CreatePageHeader
            icon={<IconGroupWork />}
            title={savedDisplayName.trim() || routeName}
            subtitle="Review details, manage connectors, agents, teams, and members."
            backLabel="Back to contexts"
            onBack={() => router.push(CONTROL_ROUTES.contexts.root)}
            titleActions={
              <ContextActionsMenu
                busy={busy}
                editing={editing}
                onEdit={startEditing}
                onDelete={() => void onDelete()}
              />
            }
          />
        }
      >
        <TabBar<ContextTab>
          ariaLabel="Context sections"
          activeValue={activeTab}
          className="cu-tabs--compact"
          onChange={selectTab}
          options={CONTEXT_TABS.map(tab => ({
            value: tab,
            label: TAB_LABELS[tab],
            href: contextTabHref(tab),
          }))}
        />
      </CreateFlowPanel>

      {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
      <div className="cu-card">
        <div className="cu-card__body">
          {activeTab === 'connectors' && (
            <>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginBottom: '1rem',
                }}
              >
                <p className="cu-muted" style={{ fontSize: '0.875rem', margin: 0 }}>
                  connectors attached to this context.
                </p>
                <button
                  type="button"
                  className="cu-btn cu-btn--primary cu-btn--sm"
                  onClick={() => setShowAddMcpServer(true)}
                  disabled={busy}
                >
                  Add connector
                </button>
              </div>
              {mcpServersDraft.length === 0 ? (
                <div className="cu-empty" style={{ padding: '0 0 1rem' }}>
                  No connectors assigned yet.
                </div>
              ) : (
                <div className="cu-table-wrap">
                  <table className="cu-table">
                    <thead>
                      <TableHeaderRow columns={CONNECTOR_COLUMNS} />
                    </thead>
                    <tbody>
                      {mcpServersDraft.map(server => (
                        <tr key={server}>
                          <td>{server}</td>
                          <td className="cu-table__cell-actions">
                            <div className="cu-row-actions">
                              <button
                                type="button"
                                className="cu-btn cu-btn--icon cu-btn--danger-icon"
                                onClick={() =>
                                  void saveMcpServers(mcpServersDraft.filter(s => s !== server))
                                }
                                disabled={busy}
                                aria-label={`Remove connector ${server}`}
                              >
                                <IconX width={16} height={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {activeTab === 'agent-files' && (
            <>
              {sharedFileSystemsDraft.length === 0 ? (
                <div className="cu-empty">No SharedFileSystems attached.</div>
              ) : (
                <div className="cu-table-wrap">
                  <table className="cu-table">
                    <thead>
                      <TableHeaderRow columns={SHARED_FILE_COLUMNS} />
                    </thead>
                    <tbody>
                      {sharedFileSystemsDraft.map(ref => (
                        <tr key={`${ref.name}@${ref.mountPath}`}>
                          <td>
                            <Link
                              className="cu-link"
                              href={CONTROL_ROUTES.agentFiles.detail(ref.name)}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.35rem',
                              }}
                            >
                              <IconFolder />
                              {ref.name}
                            </Link>
                          </td>
                          <td>
                            <code style={{ fontSize: '0.85rem' }}>{ref.mountPath}</code>
                          </td>
                          <td className="cu-table__cell-actions">
                            <div className="cu-row-actions">
                              <button
                                type="button"
                                className="cu-btn cu-btn--icon cu-btn--danger-icon"
                                disabled={busy}
                                onClick={() =>
                                  void saveSharedFileSystems(
                                    sharedFileSystemsDraft.filter(
                                      r => !(r.name === ref.name && r.mountPath === ref.mountPath)
                                    )
                                  )
                                }
                                aria-label={`Detach shared filesystem ${ref.name}`}
                              >
                                <IconX width={16} height={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="cu-divider" />

              <div
                style={{
                  display: 'flex',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                  alignItems: 'flex-end',
                }}
              >
                <div className="cu-field" style={{ flex: '1 1 14rem', marginBottom: 0 }}>
                  <label htmlFor="ctx-sfs-name">SharedFileSystem</label>
                  <select
                    id="ctx-sfs-name"
                    className="cu-input"
                    value={sfsAddName}
                    onChange={e => {
                      const v = e.target.value
                      setSfsAddName(v)
                      if (v && !sfsAddMount.trim()) setSfsAddMount(`/workspace/${v}`)
                    }}
                    disabled={busy}
                  >
                    <option value="">Select…</option>
                    {availableSfses
                      .filter(n => !sharedFileSystemsDraft.some(r => r.name === n))
                      .map(n => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="cu-field" style={{ flex: '2 1 18rem', marginBottom: 0 }}>
                  <label htmlFor="ctx-sfs-mount">Mount path</label>
                  <input
                    id="ctx-sfs-mount"
                    className="cu-input"
                    value={sfsAddMount}
                    placeholder="/workspace/<sfs-name>"
                    onChange={e => setSfsAddMount(e.target.value)}
                    disabled={busy}
                  />
                </div>
                <button
                  type="button"
                  className="cu-btn cu-btn--primary cu-btn--sm"
                  disabled={
                    busy ||
                    !sfsAddName.trim() ||
                    !sfsAddMount.trim() ||
                    sharedFileSystemsDraft.some(r => r.name === sfsAddName.trim())
                  }
                  onClick={() => {
                    const next = [
                      ...sharedFileSystemsDraft,
                      { name: sfsAddName.trim(), mountPath: sfsAddMount.trim() },
                    ]
                    setSfsAddName('')
                    setSfsAddMount('')
                    void saveSharedFileSystems(next)
                  }}
                >
                  Attach
                </button>
              </div>
            </>
          )}

          {activeTab === 'agents' && (
            <>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginBottom: '1rem',
                }}
              >
                <p className="cu-muted" style={{ fontSize: '0.875rem', margin: 0 }}>
                  Agents using this context.
                </p>
                <button
                  type="button"
                  className="cu-btn cu-btn--primary cu-btn--sm"
                  onClick={() => setShowAddAgent(true)}
                  disabled={busy}
                >
                  Add agent
                </button>
              </div>
              {linkedHosts.length === 0 ? (
                <div className="cu-empty" style={{ padding: '0 0 1rem' }}>
                  No agents reference this context.
                </div>
              ) : (
                <div className="cu-table-wrap">
                  <table className="cu-table">
                    <thead>
                      <TableHeaderRow columns={AGENT_COLUMNS} />
                    </thead>
                    <tbody>
                      {linkedHosts.map(host => (
                        <tr key={`${host.namespace}/${host.name}`}>
                          <td>
                            <button
                              type="button"
                              className="cu-link"
                              onClick={() => router.push(CONTROL_ROUTES.agents.detail(host.name))}
                            >
                              {host.name}
                            </button>
                          </td>
                          <td className="cu-table__cell-muted">{host.namespace}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {activeTab === 'teams' && (
            <>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginBottom: '1rem',
                }}
              >
                <p className="cu-muted" style={{ fontSize: '0.875rem', margin: 0 }}>
                  Teams with access to this context.
                </p>
                <button
                  type="button"
                  className="cu-btn cu-btn--primary cu-btn--sm"
                  onClick={() => setShowAddTeam(true)}
                  disabled={busy}
                >
                  Add team
                </button>
              </div>
              {contextTeams.length === 0 ? (
                <div className="cu-empty" style={{ padding: '0 0 1rem' }}>
                  No teams mapped to this context.
                </div>
              ) : (
                <div className="cu-table-wrap">
                  <table className="cu-table">
                    <thead>
                      <TableHeaderRow columns={TEAM_COLUMNS} />
                    </thead>
                    <tbody>
                      {contextTeams.map(team => (
                        <tr key={team.id}>
                          <td>
                            <button
                              type="button"
                              className="cu-link"
                              onClick={() =>
                                router.push(CONTROL_ROUTES.usersAndTeams.team(team.id))
                              }
                            >
                              {team.name}
                            </button>
                          </td>
                          <td className="cu-table__cell-actions">
                            <div className="cu-row-actions">
                              <button
                                type="button"
                                className="cu-btn cu-btn--icon cu-btn--danger-icon"
                                onClick={() => void removeTeamFromContext(team.id)}
                                disabled={busy}
                                aria-label={`Remove team ${team.name}`}
                              >
                                <IconX width={16} height={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {activeTab === 'members' && (
            <>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginBottom: '1rem',
                }}
              >
                <p className="cu-muted" style={{ fontSize: '0.875rem', margin: 0 }}>
                  Members with access to this context.
                </p>
                <button
                  type="button"
                  className="cu-btn cu-btn--primary cu-btn--sm"
                  onClick={() => setShowAddUser(true)}
                  disabled={busy}
                >
                  Add member
                </button>
              </div>
              {contextUsers.length === 0 ? (
                <div className="cu-empty" style={{ padding: '0 0 1rem' }}>
                  No members mapped to this context.
                </div>
              ) : (
                <div className="cu-table-wrap">
                  <table className="cu-table">
                    <thead>
                      <TableHeaderRow columns={MEMBER_COLUMNS} />
                    </thead>
                    <tbody>
                      {contextUsers.map(user => {
                        const memberLabel = user.displayName || user.name || user.email || user.id
                        return (
                          <tr key={user.id}>
                            <td>
                              <button
                                type="button"
                                className="cu-link"
                                onClick={() =>
                                  router.push(CONTROL_ROUTES.usersAndTeams.user(user.id))
                                }
                              >
                                {memberLabel}
                              </button>
                            </td>
                            <td className="cu-table__cell-muted">{user.email || user.id}</td>
                            <td className="cu-table__cell-actions">
                              <div className="cu-row-actions">
                                <button
                                  type="button"
                                  className="cu-btn cu-btn--icon cu-btn--danger-icon"
                                  onClick={() => void removeUserFromContext(user.id)}
                                  disabled={busy}
                                  aria-label={`Remove member ${memberLabel}`}
                                >
                                  <IconX width={16} height={16} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {editing ? (
        <div
          className="cu-modal-backdrop"
          role="presentation"
          onClick={event => {
            if (event.target === event.currentTarget && !busy) cancelEditing()
          }}
        >
          <div
            className="cu-modal-panel cu-modal-panel--narrow"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-context-title"
            onClick={event => event.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <h3 id="edit-context-title" className="cu-modal-panel__title">
                Edit context
              </h3>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={cancelEditing}
                disabled={busy}
                aria-label="Close edit context"
              >
                <IconX width={16} height={16} />
              </button>
            </div>
            <div className="cu-modal-panel__body">
              <div className="cu-field" style={{ marginBottom: 0 }}>
                <label htmlFor="ctx-name">Name</label>
                <input id="ctx-name" className="cu-input" value={contextNameDraft} readOnly />
                <span className="cu-field__hint">
                  This is the context identifier, not editable.
                </span>
              </div>
              <div className="cu-field" style={{ marginBottom: 0 }}>
                <label htmlFor="ctx-display">Display name</label>
                <input
                  id="ctx-display"
                  className="cu-input"
                  value={displayNameDraft}
                  onChange={event => setDisplayNameDraft(event.target.value)}
                  disabled={busy}
                  placeholder="Human-readable name"
                  autoFocus
                />
              </div>
              <div className="cu-field" style={{ marginBottom: 0 }}>
                <label htmlFor="ctx-desc">Description</label>
                <textarea
                  id="ctx-desc"
                  className="cu-input"
                  value={descriptionDraft}
                  onChange={event => setDescriptionDraft(event.target.value)}
                  disabled={busy}
                  rows={3}
                  placeholder="Human-readable context description"
                />
              </div>
            </div>
            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={cancelEditing}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary cu-btn--sm"
                onClick={() => void save()}
                disabled={!canSave}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showAddAgent && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--cu-overlay)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
          role="presentation"
          onClick={e => {
            if (e.target === e.currentTarget && !busy) setShowAddAgent(false)
          }}
        >
          <div
            className="cu-modal-panel cu-modal-panel--selection"
            role="dialog"
            aria-labelledby="add-agent-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="add-agent-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Add agent to context
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setShowAddAgent(false)}
                disabled={busy}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>

            <div className="cu-field">
              <label htmlFor="context-agent-picker">Agents</label>
              <SelectionDropdown
                id="context-agent-picker"
                inline
                value={selectedAgentNamesToAdd}
                onChange={setSelectedAgentNamesToAdd}
                options={agentOptions}
                placeholder="Select agents"
                searchPlaceholder="Search agents..."
                selectionLabel="Selected agents"
                emptyLabel="No available agents."
                disabled={busy}
              />
            </div>

            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setShowAddAgent(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                onClick={async () => {
                  await addAgentsToContext()
                  setShowAddAgent(false)
                }}
                disabled={busy || selectedAgentNamesToAdd.length === 0}
              >
                {selectedAgentNamesToAdd.length > 1 ? 'Add agents' : 'Add agent'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddTeam && (
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
          onClick={e => {
            if (e.target === e.currentTarget && !busy) setShowAddTeam(false)
          }}
        >
          <div
            className="cu-modal-panel cu-modal-panel--selection"
            role="dialog"
            aria-labelledby="add-team-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="add-team-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Add team to context
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setShowAddTeam(false)}
                disabled={busy}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>

            <div className="cu-field">
              <label htmlFor="context-team-picker">Team</label>
              <SelectionDropdown
                id="context-team-picker"
                inline
                value={selectedTeamIdsToAdd}
                onChange={setSelectedTeamIdsToAdd}
                options={teamOptions}
                placeholder="Select teams"
                searchPlaceholder="Search teams..."
                selectionLabel="Selected teams"
                emptyLabel="No available teams."
                disabled={busy}
              />
            </div>

            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setShowAddTeam(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                onClick={async () => {
                  await addTeamsToContext()
                  setShowAddTeam(false)
                }}
                disabled={busy || selectedTeamIdsToAdd.length === 0}
              >
                {selectedTeamIdsToAdd.length > 1 ? 'Add teams' : 'Add team'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddUser && (
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
          onClick={e => {
            if (e.target === e.currentTarget && !busy) setShowAddUser(false)
          }}
        >
          <div
            className="cu-modal-panel cu-modal-panel--selection"
            role="dialog"
            aria-labelledby="add-member-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="add-member-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Add member to context
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setShowAddUser(false)}
                disabled={busy}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>

            <div className="cu-field">
              <label htmlFor="context-member-picker">Members</label>
              <SelectionDropdown
                id="context-member-picker"
                inline
                value={selectedUserIdsToAdd}
                onChange={setSelectedUserIdsToAdd}
                options={memberOptions}
                placeholder="Select members"
                searchPlaceholder="Search members..."
                selectionLabel="Selected members"
                emptyLabel="No available members."
                disabled={busy}
              />
            </div>

            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setShowAddUser(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                onClick={async () => {
                  await addUsersToContext()
                  setShowAddUser(false)
                }}
                disabled={busy || selectedUserIdsToAdd.length === 0}
              >
                {selectedUserIdsToAdd.length > 1 ? 'Add members' : 'Add member'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddMcpServer && (
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
          onClick={e => {
            if (e.target === e.currentTarget && !busy) setShowAddMcpServer(false)
          }}
        >
          <div
            className="cu-modal-panel cu-modal-panel--selection"
            role="dialog"
            aria-labelledby="add-mcp-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <strong id="add-mcp-title" style={{ fontSize: '1rem', lineHeight: 1.35 }}>
                Add connector to context
              </strong>
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--ghost"
                onClick={() => setShowAddMcpServer(false)}
                disabled={busy}
                aria-label="Close"
              >
                <IconX width={18} height={18} />
              </button>
            </div>

            <div className="cu-field">
              <label htmlFor="context-connector-picker">Connectors</label>
              <SelectionDropdown
                id="context-connector-picker"
                inline
                value={selectedMcpServerNamesToAdd}
                onChange={setSelectedMcpServerNamesToAdd}
                options={connectorOptions}
                placeholder="Select connectors"
                searchPlaceholder="Search connectors..."
                selectionLabel="Selected connectors"
                emptyLabel="No available connectors."
                disabled={busy}
              />
            </div>

            <div className="cu-modal-panel__foot">
              <button
                type="button"
                className="cu-btn cu-btn--ghost cu-btn--sm"
                onClick={() => setShowAddMcpServer(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cu-btn cu-btn--primary"
                onClick={async () => {
                  if (selectedMcpServerNamesToAdd.length > 0) {
                    await saveMcpServers([...mcpServersDraft, ...selectedMcpServerNamesToAdd])
                    setSelectedMcpServerNamesToAdd([])
                  }
                  setShowAddMcpServer(false)
                }}
                disabled={busy || selectedMcpServerNamesToAdd.length === 0}
              >
                {selectedMcpServerNamesToAdd.length > 1 ? 'Add connectors' : 'Add connector'}
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDialog}
    </DashboardLayout>
  )
}
