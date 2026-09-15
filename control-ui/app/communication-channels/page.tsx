'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { CommunicationChannelsTable } from '@components/CommunicationChannelsTable'
import { DashboardLayout } from '@components/DashboardLayout'
import { CONTROL_ROUTES } from '@constants/routes'
import { apiGet, isSilentApiError } from '@lib/api'
import type { CommunicationChannelProvider } from '@lib/communicationChannelProviders'
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

  function copyChannel(name: string, provider: CommunicationChannelProvider) {
    const params = new URLSearchParams({
      copyFrom: name,
      provider,
    })
    router.push(CONTROL_ROUTES.externalChannels.new(Object.fromEntries(params)))
  }

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
          onCreateChannel={() => router.push(CONTROL_ROUTES.externalChannels.new())}
          onCopyChannel={copyChannel}
          onOpenChannel={name => router.push(CONTROL_ROUTES.externalChannels.edit(name))}
        />
      </DashboardLayout>
    </AuthGate>
  )
}
