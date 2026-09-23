'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { DetailPageShell } from '@components/DetailPageShell'
import { IconCable } from '@components/Sidebar/icons'
import { IconRefresh } from '@components/icons'
import { CONTROL_ROUTES } from '@constants/routes'
import { type McpServerResource, getMcpServer, isSilentApiError } from '@lib/api'

function text(value: unknown, fallback = '—'): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

export default function McpServerDetailPage() {
  const router = useRouter()
  const params = useParams<{ name: string }>()
  const name = decodeURIComponent(params?.name ?? '')
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
        title={loading ? 'Connector details' : name}
        subtitle="Review connector configuration and runtime status before making changes."
        backLabel="Back to connectors"
        onBack={() => router.push(CONTROL_ROUTES.connectors.root)}
        actions={
          <>
            <button
              type="button"
              className="cu-btn cu-btn--icon cu-btn--toolbar"
              aria-label={loading ? 'Refreshing connector' : 'Refresh connector'}
              disabled={loading}
              onClick={() => void load()}
            >
              <IconRefresh className={loading ? 'cu-spin' : undefined} width={18} height={18} />
            </button>
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              disabled={loading || !server}
              onClick={() => router.push(CONTROL_ROUTES.connectors.edit(name))}
            >
              Edit connector
            </button>
          </>
        }
        error={error || undefined}
      >
        {loading ? (
          <div className="cu-body-loading-skeleton" aria-label="Loading connector details">
            Loading connector details…
          </div>
        ) : server ? (
          <div className="cu-form-stack">
            <section className="cu-form-section" aria-labelledby="connector-summary-title">
              <h2 id="connector-summary-title" className="cu-form-section__title">
                Configuration
              </h2>
              <dl className="cu-detail-grid">
                <div>
                  <dt>Name</dt>
                  <dd>{name}</dd>
                </div>
                <div>
                  <dt>Namespace</dt>
                  <dd>{text(server.metadata?.namespace, 'default')}</dd>
                </div>
                <div>
                  <dt>Description</dt>
                  <dd>{text(spec.description)}</dd>
                </div>
                <div>
                  <dt>Image</dt>
                  <dd>{text(spec.image)}</dd>
                </div>
                <div>
                  <dt>Managed</dt>
                  <dd>{spec.managed === false ? 'No' : 'Yes'}</dd>
                </div>
                <div>
                  <dt>Enabled</dt>
                  <dd>{spec.enabled === false ? 'No' : 'Yes'}</dd>
                </div>
                <div>
                  <dt>Transport</dt>
                  <dd>{text(transport.type)}</dd>
                </div>
                <div>
                  <dt>Endpoint</dt>
                  <dd>{text(transport.url)}</dd>
                </div>
              </dl>
            </section>
            <section className="cu-form-section" aria-labelledby="connector-status-title">
              <h2 id="connector-status-title" className="cu-form-section__title">
                Runtime status
              </h2>
              {conditions.length ? (
                <ul className="cu-detail-list">
                  {conditions.map(condition => (
                    <li key={condition.type}>
                      <strong>{condition.type}</strong>: {condition.status}
                      {condition.message ? ` — ${condition.message}` : ''}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="cu-muted">No runtime conditions have been reported.</p>
              )}
            </section>
          </div>
        ) : null}
      </DetailPageShell>
    </AuthGate>
  )
}
