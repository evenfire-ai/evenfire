'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { DashboardLayout } from '@components/DashboardLayout'
import { HostTable } from '@components/HostTable'
import { useToast } from '@components/Toast'
import { CONTROL_ROUTES } from '@constants/routes'
import { apiSend, getContexts, getHosts, isSilentApiError } from '@lib/api'
import type { HostResource } from '@lib/api'

type HostRef = { name: string; namespace: string }

export default function HostsPage() {
  const router = useRouter()
  const [hosts, setHosts] = useState<HostResource[]>([])
  const [contextsByRef, setContextsByRef] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deletingKey, setDeletingKey] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()

  async function loadAll() {
    setLoading(true)
    setError('')
    try {
      // Hosts are the primary resource for this page. Contexts only enrich the
      // connector hover card, so an optional enrichment failure must not hide
      // the table or its primary actions.
      const hostsResponse = await getHosts()
      setHosts(hostsResponse.items || [])
      // Clear stale enrichment before refreshing it. If the optional request
      // fails, rows still render with their raw context reference and a
      // degraded connector count/hover card.
      setContextsByRef({})

      let contextsResponse
      try {
        contextsResponse = await getContexts()
      } catch {
        return
      }

      const map: Record<string, string[]> = {}
      for (const ctx of contextsResponse.items || []) {
        const ref = String(ctx.spec?.contextId || ctx.metadata?.name || '').trim()
        if (!ref) continue
        const servers = Array.isArray(ctx.spec?.mcpServers)
          ? ctx.spec.mcpServers
              .map(String)
              .map(v => v.trim())
              .filter(Boolean)
          : []
        map[ref] = servers
      }
      setContextsByRef(map)
    } catch (nextError) {
      if (isSilentApiError(nextError)) return
      setError(nextError instanceof Error ? nextError.message : 'Failed to load agents')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

  async function handleDeleteHost(host: HostRef) {
    const key = `${host.namespace}/${host.name}`
    const shouldDelete = await confirm({
      title: 'Delete Agent',
      message: `Delete agent ${key}?`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!shouldDelete) return

    setDeletingKey(key)
    setError('')
    try {
      await apiSend('DELETE', `/api/v1/admin/hosts/${encodeURIComponent(host.name)}`, undefined, {
        namespace: host.namespace,
      })
      await loadAll()
      showToast(`Agent ${key} deleted.`, { tone: 'success' })
    } catch (nextError) {
      if (isSilentApiError(nextError)) return
      setError(nextError instanceof Error ? nextError.message : `Failed to delete agent ${key}`)
    } finally {
      setDeletingKey(null)
    }
  }

  const stableContextsByRef = useMemo(() => contextsByRef, [contextsByRef])

  return (
    <AuthGate>
      <DashboardLayout>
        {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
        <HostTable
          items={hosts}
          onOpen={host => router.push(CONTROL_ROUTES.agents.detail(host.name))}
          onOpenContext={contextName => {
            const trimmed = contextName.trim()
            if (trimmed) router.push(CONTROL_ROUTES.contexts.connectors(trimmed))
          }}
          onDelete={handleDeleteHost}
          deletingKey={deletingKey}
          onRefresh={loadAll}
          onCreateHost={() => router.push(CONTROL_ROUTES.agents.new)}
          refreshing={loading}
          loading={loading}
          contextsByRef={stableContextsByRef}
        />
        {confirmDialog}
      </DashboardLayout>
    </AuthGate>
  )
}
