'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { DashboardLayout } from '@components/DashboardLayout'
import { HostTable } from '@components/HostTable'
import { useToast } from '@components/Toast'
import { apiSend, getHosts, isSilentApiError } from '@lib/api'
import type { HostResource } from '@lib/api'

type HostRef = { name: string; namespace: string }

export default function HostsPage() {
  const router = useRouter()
  const [hosts, setHosts] = useState<HostResource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deletingKey, setDeletingKey] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()

  async function loadAll() {
    setLoading(true)
    setError('')
    try {
      const response = await getHosts()
      setHosts(response.items || [])
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

  return (
    <AuthGate>
      <DashboardLayout>
        {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
        <HostTable
          items={hosts}
          onOpen={host => router.push(`/hosts/${encodeURIComponent(host.name)}`)}
          onOpenContext={contextName => {
            const trimmed = contextName.trim()
            if (trimmed) router.push(`/contexts/${encodeURIComponent(trimmed)}`)
          }}
          onDelete={handleDeleteHost}
          deletingKey={deletingKey}
          onRefresh={loadAll}
          onCreateHost={() => router.push('/hosts/new')}
          refreshing={loading}
          loading={loading}
        />
        {confirmDialog}
      </DashboardLayout>
    </AuthGate>
  )
}
