'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { ContextTable } from '@components/ContextTable'
import { DashboardLayout } from '@components/DashboardLayout'
import { useToast } from '@components/Toast'
import { CONTROL_ROUTES } from '@constants/routes'
import { apiSend, getContexts, isSilentApiError } from '@lib/api'
import type { ContextResource } from '@lib/api'

type ContextRef = { name: string }

export default function ContextsPage() {
  const router = useRouter()
  const [contexts, setContexts] = useState<ContextResource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deletingKey, setDeletingKey] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()

  async function loadAll() {
    setLoading(true)
    setError('')
    try {
      const response = await getContexts()
      setContexts(response.items || [])
    } catch (nextError) {
      if (isSilentApiError(nextError)) return
      setError(nextError instanceof Error ? nextError.message : 'Failed to load contexts')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

  async function handleDeleteContext(context: ContextRef) {
    const shouldDelete = await confirm({
      title: 'Delete Context',
      message: `Delete context ${context.name}?`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!shouldDelete) return

    setDeletingKey(context.name)
    setError('')
    try {
      await apiSend('DELETE', `/api/v1/admin/contexts/${encodeURIComponent(context.name)}`)
      await loadAll()
      showToast(`Context ${context.name} deleted.`, { tone: 'success' })
    } catch (nextError) {
      if (isSilentApiError(nextError)) return
      setError(
        nextError instanceof Error ? nextError.message : `Failed to delete context ${context.name}`
      )
    } finally {
      setDeletingKey(null)
    }
  }

  return (
    <AuthGate>
      <DashboardLayout>
        {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
        <ContextTable
          items={contexts}
          onView={context => router.push(CONTROL_ROUTES.contexts.detail(context.name))}
          onEdit={context => router.push(CONTROL_ROUTES.contexts.connectors(context.name))}
          onDelete={handleDeleteContext}
          deletingKey={deletingKey}
          onRefresh={loadAll}
          onCreate={() => router.push(CONTROL_ROUTES.contexts.new)}
          refreshing={loading}
          loading={loading}
        />
        {confirmDialog}
      </DashboardLayout>
    </AuthGate>
  )
}
