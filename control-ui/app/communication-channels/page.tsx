'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { CommunicationChannelsTable } from '@components/CommunicationChannelsTable'
import { DashboardLayout } from '@components/DashboardLayout'
import { apiGet, isSilentApiError } from '@lib/api'
import type { CommunicationChannelItem } from '@lib/communicationChannels'

export default function CommunicationChannelsPage() {
  const router = useRouter()
  const [channels, setChannels] = useState<CommunicationChannelItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function loadAll() {
    setLoading(true)
    setError('')
    try {
      const channelsResponse = (await apiGet('/api/v1/admin/communication-channels')) as {
        items?: CommunicationChannelItem[]
      }
      setChannels(channelsResponse.items || [])
    } catch (nextError) {
      if (isSilentApiError(nextError)) return
      setError(
        nextError instanceof Error ? nextError.message : 'Failed to load communication channels'
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

  return (
    <AuthGate>
      <DashboardLayout>
        {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
        <CommunicationChannelsTable
          items={channels}
          onChanged={loadAll}
          loading={loading}
          onRefresh={loadAll}
          refreshing={loading}
          onCreateChannel={() => router.push('/communication-channels/new')}
          onOpenChannel={name =>
            router.push(`/communication-channels/${encodeURIComponent(name)}/edit`)
          }
          onEditChannel={name =>
            router.push(`/communication-channels/${encodeURIComponent(name)}/edit`)
          }
        />
      </DashboardLayout>
    </AuthGate>
  )
}
