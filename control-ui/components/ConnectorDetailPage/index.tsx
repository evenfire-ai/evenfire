'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { ConnectorAgentAccessDialog } from '@components/ConnectorAgentAccessDialog'
import { ConnectorDetailAccessPanel } from '@components/ConnectorDetailAccessPanel'
import { useOptionalConnectorDetailAccess } from '@components/ConnectorDetailAccessProvider'
import { useConnectorDetail } from '@components/ConnectorDetailProvider'
import { DetailPageShell } from '@components/DetailPageShell'
import type { ConnectorAgentBinding } from '@components/McpServerTable.types'
import { IconCable } from '@components/Sidebar/icons'
import { IconRefresh } from '@components/icons'
import { Button, FormSection } from '@components/ui'
import {
  CONNECTOR_DETAIL_DEFAULT_TAB,
  CONNECTOR_DETAIL_TABS,
  CONNECTOR_DETAIL_TAB_LABELS,
} from '@constants/connectorDetail'
import type { ConnectorDetailTab } from '@constants/connectorDetail'
import { CONTROL_ROUTES } from '@constants/routes'
import type { McpServerCondition } from '@lib/api'
import { connectorAuthenticationLabel } from '@lib/connectorAuthentication'

function text(value: unknown, fallback = '—'): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function parseConnectorDetailTab(value: string | string[] | undefined): ConnectorDetailTab {
  const candidate = Array.isArray(value) ? value[0] : value
  return CONNECTOR_DETAIL_TABS.find(tab => tab === candidate) ?? CONNECTOR_DETAIL_DEFAULT_TAB
}

function ConnectorReadOnlyField({
  code = false,
  label,
  value,
  wide = false,
}: {
  code?: boolean
  label: string
  value: string
  wide?: boolean
}) {
  return (
    <div className={wide ? 'cu-field cu-connector-detail__field--wide' : 'cu-field'}>
      <span className="cu-field__label">{label}</span>
      <div
        className={
          code
            ? 'cu-readonly-field cu-connector-detail__value cu-connector-detail__value--code'
            : 'cu-readonly-field cu-connector-detail__value'
        }
      >
        {code ? <code>{value}</code> : value}
      </div>
    </div>
  )
}

function ConnectorRuntimeStatus({ conditions }: { conditions: McpServerCondition[] }) {
  return (
    <FormSection
      title="Runtime status"
      description="Current status reported by the connector runtime."
    >
      {conditions.length ? (
        <ul className="cu-connector-detail__conditions" aria-label="Connector runtime conditions">
          {conditions.map(condition => (
            <li className="cu-connector-detail__condition" key={condition.type}>
              <div className="cu-connector-detail__condition-header">
                <strong>{condition.type}</strong>
                <span>{condition.status}</span>
              </div>
              {condition.message ? (
                <p className="cu-connector-detail__condition-message">{condition.message}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="cu-muted">No runtime conditions have been reported.</p>
      )}
    </FormSection>
  )
}

function accessBoundary(tab: ConnectorDetailTab): 'users' | 'teams' | 'agents' | null {
  return tab === 'users' || tab === 'teams' || tab === 'agents' ? tab : null
}

export function ConnectorDetailPage() {
  const router = useRouter()
  const params = useParams<{ name: string; tab?: string | string[] }>()
  const name = decodeURIComponent(params?.name ?? '')
  const { server, loading, error, load } = useConnectorDetail()
  const access = useOptionalConnectorDetailAccess()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [activeTab, setActiveTab] = useState<ConnectorDetailTab>(() =>
    parseConnectorDetailTab(params?.tab)
  )
  const [showAddAgents, setShowAddAgents] = useState(false)

  useEffect(() => {
    setActiveTab(parseConnectorDetailTab(params?.tab))
  }, [params?.tab])

  const activeBoundary = accessBoundary(activeTab)
  const spec = server?.spec ?? {}
  const auth =
    spec.auth && typeof spec.auth === 'object' ? (spec.auth as Record<string, unknown>) : {}
  const conditions = server?.status?.conditions ?? []
  const transport =
    spec.transport && typeof spec.transport === 'object'
      ? (spec.transport as Record<string, unknown>)
      : {}
  const serverRef = {
    name: server?.metadata?.name || name,
    namespace: server?.metadata?.namespace || 'default',
  }

  function selectTab(next: ConnectorDetailTab) {
    setActiveTab(next)
  }

  async function addAgents(
    _server: { name: string; namespace: string },
    agents: Array<{ name: string; contextRef: string }>
  ): Promise<boolean> {
    if (!access) return false
    return access.addAgents(agents)
  }

  async function removeAgentBinding(binding: ConnectorAgentBinding) {
    if (!access) return
    if (binding.agents.length > 1) {
      const sharedNames = binding.agents.map(agent => agent.label).join(', ')
      const shouldRemove = await confirm({
        title: 'Remove Connector Access',
        message: `Remove connector ${serverRef.name} from ${binding.agents.length} agents (${sharedNames})? These agents share one connector set, so the change applies to all of them.`,
        confirmLabel: 'Remove',
        tone: 'danger',
      })
      if (!shouldRemove) return
    }

    await access.removeBinding(binding)
  }

  async function refreshCurrent() {
    void load()
    if (activeBoundary) await access?.refresh()
  }

  const addDialog =
    showAddAgents && activeTab === 'agents' && access ? (
      <ConnectorAgentAccessDialog
        key={serverRef.name}
        server={serverRef}
        connectorSpec={server?.spec}
        agentTargets={access.agentTargets}
        boundAgentNames={access.agentBindings.flatMap(binding =>
          binding.agents.map(agent => agent.id)
        )}
        pending={access.updating}
        onAdd={addAgents}
        onDismiss={() => {
          if (!access.updating) setShowAddAgents(false)
        }}
      />
    ) : null

  return (
    <AuthGate>
      <DetailPageShell
        icon={<IconCable />}
        title={`Connector: ${name}`}
        subtitle="Review connector configuration, access, and runtime status. Edit this connector to make changes."
        backLabel="Back to connectors"
        onBack={() => router.push(CONTROL_ROUTES.connectors.root)}
        activeTab={activeTab}
        onTabChange={selectTab}
        tabAriaLabel="Connector detail sections"
        tabs={CONNECTOR_DETAIL_TABS.map(tab => ({
          value: tab,
          label: CONNECTOR_DETAIL_TAB_LABELS[tab],
          href:
            tab === CONNECTOR_DETAIL_DEFAULT_TAB
              ? CONTROL_ROUTES.connectors.detail(name)
              : CONTROL_ROUTES.connectors.detailTab(name, tab),
          onLinkActivate: () => selectTab(tab),
        }))}
        contentMode="plain"
        contentClassName="cu-detail-content-stack--panel-continuation"
        actions={
          <>
            <Button
              icon
              toolbar
              variant="secondary"
              aria-label={loading ? 'Refreshing connector' : 'Refresh connector'}
              disabled={loading || Boolean(access?.updating)}
              onClick={() => void refreshCurrent()}
            >
              <IconRefresh className={loading ? 'cu-spin' : undefined} width={18} height={18} />
            </Button>
            {activeTab === 'agents' ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={
                  loading ||
                  !server ||
                  !access?.snapshot ||
                  Boolean(access.loading || access.updating)
                }
                onClick={() => setShowAddAgents(true)}
              >
                Add agent
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="primary"
              disabled={loading || !server}
              onClick={() => router.push(CONTROL_ROUTES.connectors.edit(name))}
            >
              Edit connector
            </Button>
          </>
        }
        error={error || undefined}
        overlays={
          <>
            {addDialog}
            {confirmDialog}
          </>
        }
      >
        {loading ? (
          <div
            className="cu-body-loading-skeleton"
            role="status"
            aria-busy="true"
            aria-label="Loading connector details"
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
        ) : server && activeTab === 'configuration' ? (
          <FormSection
            title="Configuration"
            description="Connector settings are shown here for review. Use Edit connector to change them."
          >
            <div className="cu-form-grid cu-form-grid--2 cu-connector-detail__grid">
              <ConnectorReadOnlyField label="Name" value={name} />
              <ConnectorReadOnlyField
                label="Namespace"
                value={text(server.metadata?.namespace, 'default')}
              />
              <ConnectorReadOnlyField label="Description" value={text(spec.description)} wide />
              <ConnectorReadOnlyField code label="Image" value={text(spec.image)} wide />
              <ConnectorReadOnlyField
                label="Managed"
                value={spec.managed === false ? 'No' : 'Yes'}
              />
              <ConnectorReadOnlyField
                label="Enabled"
                value={spec.enabled === false ? 'No' : 'Yes'}
              />
              <ConnectorReadOnlyField label="Transport" value={text(transport.type)} />
              <ConnectorReadOnlyField
                label="Authentication"
                value={connectorAuthenticationLabel(auth.type)}
              />
              <ConnectorReadOnlyField code label="Endpoint" value={text(transport.url)} wide />
            </div>
          </FormSection>
        ) : server && activeTab === 'runtime' ? (
          <ConnectorRuntimeStatus conditions={conditions} />
        ) : server && activeBoundary ? (
          <ConnectorDetailAccessPanel
            boundary={activeBoundary}
            server={serverRef}
            snapshot={access?.snapshot ?? null}
            agentBindings={access?.agentBindings ?? []}
            loading={access?.loading ?? true}
            updating={access?.updating ?? false}
            error={access?.error ?? ''}
            notice={access?.notice ?? ''}
            onRemove={binding => void removeAgentBinding(binding)}
          />
        ) : null}
      </DetailPageShell>
    </AuthGate>
  )
}
