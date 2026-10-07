'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { DetailPageShell } from '@components/DetailPageShell'
import { IconCable } from '@components/Sidebar/icons'
import { IconRefresh } from '@components/icons'
import { Button, FormSection } from '@components/ui'
import {
  CONNECTOR_DETAIL_DEFAULT_TAB,
  CONNECTOR_DETAIL_TABS,
  CONNECTOR_DETAIL_TAB_LABELS,
  type ConnectorDetailTab,
} from '@constants/connectorDetail'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type McpServerCondition,
  type McpServerResource,
  getMcpServer,
  isSilentApiError,
} from '@lib/api'

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

export default function McpServerDetailPage() {
  const router = useRouter()
  const params = useParams<{ name: string; tab?: string | string[] }>()
  const name = decodeURIComponent(params?.name ?? '')
  const activeTab = parseConnectorDetailTab(params?.tab)
  const [server, setServer] = useState<McpServerResource | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setServer(await getMcpServer(name))
    } catch (caught) {
      if (isSilentApiError(caught)) return
      setServer(null)
      setError(caught instanceof Error ? caught.message : `Connector ${name} was not found.`)
    } finally {
      setLoading(false)
    }
  }, [name])

  function selectTab(next: ConnectorDetailTab) {
    if (next === CONNECTOR_DETAIL_DEFAULT_TAB) {
      router.replace(CONTROL_ROUTES.connectors.detail(name))
    } else {
      router.replace(CONTROL_ROUTES.connectors.detailTab(name, next))
    }
  }

  useEffect(() => {
    if (name) void load()
  }, [load, name])

  const spec = server?.spec ?? {}
  const conditions = server?.status?.conditions ?? []
  const transport =
    spec.transport && typeof spec.transport === 'object'
      ? (spec.transport as Record<string, unknown>)
      : {}

  return (
    <AuthGate>
      <DetailPageShell
        icon={<IconCable />}
        title={loading ? 'Connector details' : `Connector: ${name}`}
        subtitle="Review connector configuration and runtime status. Edit this connector to make changes."
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
              disabled={loading}
              onClick={() => void load()}
            >
              <IconRefresh className={loading ? 'cu-spin' : undefined} width={18} height={18} />
            </Button>
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
        ) : server ? (
          activeTab === 'configuration' ? (
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
                <ConnectorReadOnlyField code label="Endpoint" value={text(transport.url)} wide />
              </div>
            </FormSection>
          ) : (
            <ConnectorRuntimeStatus conditions={conditions} />
          )
        ) : null}
      </DetailPageShell>
    </AuthGate>
  )
}
