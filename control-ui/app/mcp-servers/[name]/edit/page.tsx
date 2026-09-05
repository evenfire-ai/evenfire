'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { FormSectionsSkeleton } from '@components/BodyLoadingSkeleton'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { EgressEditor } from '@components/EgressEditor'
import { IconCable } from '@components/Sidebar/icons'
import { TabBar } from '@components/TabBar'
import { useToast } from '@components/Toast'
import { UpdateConnectorCredentials } from '@components/UpdateConnectorCredentials'
import {
  isRecipeOwned,
  resolveCredentialSurface,
} from '@components/UpdateConnectorCredentials/resolveCredentialSurface'
import {
  CONNECTOR_EDIT_DEFAULT_TAB,
  CONNECTOR_EDIT_TABS,
  CONNECTOR_EDIT_TAB_LABELS,
  type ConnectorEditTab,
} from '@constants/connectorEdit'
import { CONTROL_ROUTES } from '@constants/routes'
import { getAgentDisplayName } from '@lib/agentName'
import {
  getAgentTeams,
  getAgentUsers,
  getContexts,
  getHosts,
  getMcpServer,
  updateMcpServer,
} from '@lib/api'
import type {
  ContextResource,
  EgressBinding,
  EnvSecret,
  EnvSecretKeyMapping,
  HostResource,
  McpServerResource,
} from '@lib/api'
import {
  hostOwnedContextNamesForConnector,
  mergeAccessSummaries,
  sortAccessPrincipals,
} from '@lib/connectorAccess'
import type { EgressEditorStatus } from '@lib/egressModel'

/**
 * Narrows `server.spec.envSecret` (typed as `unknown` on the generic
 * `AnyRecord` spec) into the shape UpdateConnectorCredentials needs. A
 * malformed or partial envSecret (missing name, keys not an array, or no
 * usable key mappings) is treated the same as "no envSecret" — there is
 * nothing safely rotatable through this form either way.
 */
function resolveEnvSecret(spec: Record<string, unknown> | undefined): EnvSecret | undefined {
  const raw = spec?.envSecret
  if (!raw || typeof raw !== 'object') return undefined
  const candidate = raw as { name?: unknown; keys?: unknown }
  if (typeof candidate.name !== 'string' || !Array.isArray(candidate.keys)) return undefined
  const keys = candidate.keys.filter(
    (k): k is EnvSecretKeyMapping =>
      Boolean(k) &&
      typeof (k as EnvSecretKeyMapping).secretKey === 'string' &&
      typeof (k as EnvSecretKeyMapping).envVar === 'string'
  )
  if (keys.length === 0) return undefined
  return { name: candidate.name, keys }
}

function parseConnectorEditTab(value: string | string[] | undefined): ConnectorEditTab {
  const candidate = Array.isArray(value) ? value[0] : value
  return CONNECTOR_EDIT_TABS.find(tab => tab === candidate) ?? CONNECTOR_EDIT_DEFAULT_TAB
}

type ContextAccess = {
  agents: Array<{ id: string; label: string }>
  teams: Array<{ id: string; label: string }>
  users: Array<{ id: string; label: string }>
}

function resolveRegistryCredentialSource(
  metadata: McpServerResource['metadata'] | undefined
): { name: string; version: string } | undefined {
  const labels = (metadata?.labels ?? {}) as Record<string, unknown>
  const annotations = (metadata?.annotations ?? {}) as Record<string, unknown>
  const name = String(
    annotations['clerum.io/catalog-id'] ?? labels['clerum.io/catalog-id'] ?? ''
  ).trim()
  const version = String(
    annotations['clerum.io/catalog-version'] ?? labels['clerum.io/catalog-version'] ?? ''
  ).trim()
  return name && version ? { name, version } : undefined
}

const EMPTY_CONTEXT_ACCESS: ContextAccess = { agents: [], teams: [], users: [] }

const CONTEXT_ACCESS_GROUPS: Array<{ key: keyof ContextAccess; title: string }> = [
  { key: 'users', title: 'Users' },
  { key: 'teams', title: 'Teams' },
  { key: 'agents', title: 'Agents' },
]

export default function EditMcpServerPage() {
  const router = useRouter()
  const params = useParams<{ name: string; tab?: string | string[] }>()
  const name = decodeURIComponent(params?.name ?? '')
  const { showToast } = useToast()

  const activeTab = parseConnectorEditTab(params?.tab)

  const [server, setServer] = useState<McpServerResource | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [egressBindings, setEgressBindings] = useState<EgressBinding[] | undefined>(undefined)
  const [egressStatus, setEgressStatus] = useState<EgressEditorStatus | null>(null)
  const [contextAccess, setContextAccess] = useState<ContextAccess>(EMPTY_CONTEXT_ACCESS)
  const [contextNames, setContextNames] = useState<string[]>([])
  const [owningAgents, setOwningAgents] = useState<ContextAccess['agents']>([])
  const [loadingContexts, setLoadingContexts] = useState(true)
  const [contextListError, setContextListError] = useState('')
  const [contextAccessError, setContextAccessError] = useState('')
  const [loadingContextAccess, setLoadingContextAccess] = useState(false)

  function backToList() {
    router.push(CONTROL_ROUTES.connectors.root)
  }

  function selectTab(next: ConnectorEditTab) {
    if (next === CONNECTOR_EDIT_DEFAULT_TAB) {
      router.replace(CONTROL_ROUTES.connectors.edit(name))
    } else {
      router.replace(CONTROL_ROUTES.connectors.editTab(name, next))
    }
  }

  const handleEgressChange = useCallback(
    (nextBindings: EgressBinding[] | undefined, nextStatus: EgressEditorStatus) => {
      setEgressBindings(nextBindings)
      setEgressStatus(nextStatus)
    },
    []
  )

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setLoadError('')
      try {
        const result = await getMcpServer(name)
        if (cancelled) return
        setServer(result)
        setEgressBindings((result.spec?.egressBindings as EgressBinding[] | undefined) ?? undefined)
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Failed to load connector')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    if (name) void load()
    return () => {
      cancelled = true
    }
  }, [name])

  useEffect(() => {
    let cancelled = false
    async function loadContexts() {
      setLoadingContexts(true)
      setContextListError('')
      try {
        const [contextsResult, hostsResult] = await Promise.all([getContexts(), getHosts()])
        if (cancelled) return
        const contexts = (contextsResult.items ?? []) as ContextResource[]
        const hosts = (hostsResult.items ?? []) as HostResource[]
        const nextContextNames = hostOwnedContextNamesForConnector(contexts, hosts, name)
        const contextNameSet = new Set(nextContextNames)
        const agentsById = new Map<string, ContextAccess['agents'][number]>()
        for (const host of hosts) {
          const contextRef = String(host.spec?.contextRef ?? '').trim()
          const id = String(host.metadata?.name ?? '').trim()
          if (!contextNameSet.has(contextRef) || !id) continue
          agentsById.set(id, { id, label: getAgentDisplayName(id, hosts) })
        }
        setContextNames(nextContextNames)
        setOwningAgents(sortAccessPrincipals([...agentsById.values()]))
      } catch {
        if (!cancelled) {
          setContextNames([])
          setOwningAgents([])
          setContextListError('Agent access data is unavailable. Try again later.')
        }
      } finally {
        if (!cancelled) setLoadingContexts(false)
      }
    }
    if (name) void loadContexts()
    return () => {
      cancelled = true
    }
  }, [name])

  useEffect(() => {
    if (contextNames.length === 0) {
      setContextAccess(EMPTY_CONTEXT_ACCESS)
      setContextAccessError('')
      setLoadingContextAccess(false)
      return
    }

    let cancelled = false
    setLoadingContextAccess(true)
    setContextAccessError('')

    void (async () => {
      // Resolve the AGENTS whose scopes carry this connector, then read their
      // user/team grants — the same mappings operators manage in Users &
      // Teams — instead of the legacy scope-centric context sub-resources.
      const agentResults = await Promise.all(
        owningAgents.map(async agent => {
          const [usersResult, teamsResult] = await Promise.allSettled([
            getAgentUsers(agent.id),
            getAgentTeams(agent.id),
          ])
          return { agent, usersResult, teamsResult }
        })
      )
      if (cancelled) return

      const failed = agentResults.some(
        result =>
          result.usersResult.status === 'rejected' || result.teamsResult.status === 'rejected'
      )
      setContextAccess(
        mergeAccessSummaries(
          agentResults.map(({ agent, usersResult, teamsResult }) => ({
            users:
              usersResult.status === 'fulfilled'
                ? sortAccessPrincipals(
                    (usersResult.value.items ?? []).map(user => ({
                      id: user.id,
                      label: user.displayName || user.name || user.email || user.id,
                    }))
                  )
                : [],
            teams:
              teamsResult.status === 'fulfilled'
                ? sortAccessPrincipals(
                    (teamsResult.value.items ?? []).map(team => ({
                      id: team.id,
                      label: team.name || team.id,
                    }))
                  )
                : [],
            agents: [agent],
          }))
        )
      )
      setContextAccessError(
        failed
          ? 'Some access information could not be loaded. The lists below may be incomplete.'
          : ''
      )
      setLoadingContextAccess(false)
    })()

    return () => {
      cancelled = true
    }
  }, [contextNames, owningAgents])

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!server?.spec || saving || egressStatus?.errors.length) return
    setSaving(true)
    setSaveError('')
    try {
      const nextSpec = { ...(server.spec as Record<string, unknown>) }
      if (egressBindings && egressBindings.length > 0) {
        nextSpec.egressBindings = egressBindings
      } else {
        delete nextSpec.egressBindings
      }
      await updateMcpServer(name, { spec: nextSpec })
      showToast(`Connector ${name} updated.`, { tone: 'success' })
      backToList()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to update connector')
    } finally {
      setSaving(false)
    }
  }

  const envSecret = server?.spec
    ? resolveEnvSecret(server.spec as Record<string, unknown>)
    : undefined
  const registryCredentialSource = useMemo(
    () => resolveRegistryCredentialSource(server?.metadata),
    [server?.metadata]
  )

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CreateFlowPanel
          header={
            <CreatePageHeader
              icon={<IconCable />}
              title={`Edit Connector: ${name}`}
              subtitle="Review agent access, rotate credentials, and update external egress for this connector."
              backLabel="Back to connectors"
              onBack={backToList}
            />
          }
        >
          <TabBar<ConnectorEditTab>
            ariaLabel="Connector edit sections"
            activeValue={activeTab}
            className="cu-tabs--compact cu-connector-edit-tabs"
            onChange={selectTab}
            options={CONNECTOR_EDIT_TABS.map(tab => ({
              value: tab,
              label: CONNECTOR_EDIT_TAB_LABELS[tab],
              href:
                tab === CONNECTOR_EDIT_DEFAULT_TAB
                  ? CONTROL_ROUTES.connectors.edit(name)
                  : CONTROL_ROUTES.connectors.editTab(name, tab),
            }))}
          />

          {loadError ? <div className="cu-banner cu-banner--error">{loadError}</div> : null}

          {loading ? (
            activeTab === 'credentials' ? (
              <div
                role="status"
                aria-busy="true"
                aria-label="Loading connector credentials"
                className="cu-connector-edit-form cu-body-loading-skeleton"
              >
                <section className="cu-body-loading-skeleton__section">
                  <span className="cu-skeleton cu-body-loading-skeleton__heading" />
                  <span className="cu-skeleton cu-body-loading-skeleton__line" />
                  <div className="cu-body-loading-skeleton__fields">
                    <span className="cu-skeleton cu-body-loading-skeleton__field" />
                    <span className="cu-skeleton cu-body-loading-skeleton__field" />
                  </div>
                </section>
              </div>
            ) : (
              <div className="cu-connector-edit-form">
                <FormSectionsSkeleton
                  label="Connector"
                  primaryActionLabel="Save egress"
                  sections={2}
                />
              </div>
            )
          ) : server ? (
            activeTab === 'credentials' ? (
              <div className="cu-connector-edit-form">
                <UpdateConnectorCredentials
                  serverName={name}
                  envSecret={envSecret}
                  registryCredentialSource={registryCredentialSource}
                  surface={resolveCredentialSurface(
                    server.status?.conditions,
                    server.spec as { managed?: boolean } | undefined
                  )}
                  // Ownership is a spec fact, independent of observed status.
                  recipeOwned={isRecipeOwned(server.spec as { managed?: boolean } | undefined)}
                />
              </div>
            ) : activeTab === 'access' ? (
              <div className="cu-connector-edit-form cu-connector-edit-content">
                <section className="cu-form-section" aria-labelledby="connector-access-title">
                  <div className="cu-form-section__header">
                    <h2 id="connector-access-title" className="cu-form-section__title">
                      Agent access
                    </h2>
                    <p className="cu-form-section__description">
                      This connector is available to the agents, teams, and users shown below.
                      Assignments are derived from the current access setup and cannot be changed
                      here yet.
                    </p>
                  </div>

                  {loadingContexts ? (
                    <p className="cu-muted" role="status">
                      Loading agent access…
                    </p>
                  ) : contextListError ? (
                    <div className="cu-banner cu-banner--warn" role="alert">
                      {contextListError}
                    </div>
                  ) : contextNames.length === 0 ? (
                    <p className="cu-muted">No agents have access to this connector yet.</p>
                  ) : null}

                  {!loadingContexts && !contextListError && contextNames.length > 0 ? (
                    loadingContextAccess ? (
                      <p className="cu-muted">Loading agent access…</p>
                    ) : (
                      <>
                        {contextAccessError ? (
                          <p className="cu-banner cu-banner--warn" role="status">
                            {contextAccessError}
                          </p>
                        ) : null}
                        <section className="cu-entity-access" aria-label="Agent access">
                          {CONTEXT_ACCESS_GROUPS.map(group => (
                            <section
                              className="cu-entity-access__group"
                              data-kind={group.key}
                              key={group.key}
                            >
                              <div className="cu-entity-access__heading">
                                <h4>{group.title}</h4>
                                <span>{contextAccess[group.key].length}</span>
                              </div>
                              {contextAccess[group.key].length > 0 ? (
                                <ul className="cu-entity-access__list">
                                  {contextAccess[group.key].map(principal => (
                                    <li key={principal.id}>
                                      <span>{principal.label}</span>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="cu-muted">
                                  No {group.title.toLowerCase()} have access.
                                </p>
                              )}
                            </section>
                          ))}
                        </section>
                      </>
                    )
                  ) : null}
                </section>
              </div>
            ) : (
              <form
                className="cu-connector-edit-form cu-connector-edit-content"
                onSubmit={handleSave}
              >
                <div className="cu-connector-edit-meta">
                  <div>
                    <strong>Image:</strong>{' '}
                    <code>{typeof server.spec?.image === 'string' ? server.spec.image : '-'}</code>
                  </div>
                </div>

                <EgressEditor
                  allowCidr
                  key={`${name}-${JSON.stringify(server.spec?.egressBindings ?? [])}`}
                  initialBindings={server.spec?.egressBindings as EgressBinding[] | undefined}
                  onChange={handleEgressChange}
                  title="External Egress"
                  description="Adjust only the external egress contract. Other connector settings are preserved."
                />

                {saveError ? (
                  <div className="cu-banner cu-banner--error" role="alert">
                    {saveError}
                  </div>
                ) : null}

                <div className="cu-create-actions">
                  <button
                    type="button"
                    className="cu-btn cu-btn--ghost"
                    disabled={saving}
                    onClick={backToList}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="cu-btn cu-btn--primary"
                    disabled={saving || Boolean(egressStatus?.errors.length)}
                  >
                    {saving ? 'Saving...' : 'Save egress'}
                  </button>
                </div>
              </form>
            )
          ) : null}
        </CreateFlowPanel>
      </DashboardLayout>
    </AuthGate>
  )
}
