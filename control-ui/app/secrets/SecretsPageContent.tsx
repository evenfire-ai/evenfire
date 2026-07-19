'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import { SecretsTable } from '@components/SecretsTable'
import { CONTROL_ROUTES } from '@constants/routes'
import { apiGet, isSilentApiError } from '@lib/api'

export type SecretScope = 'llm' | 'mcp' | 'recipe'

type SecretItem = {
  name?: string
  metadata?: { name?: string }
  keys?: string[]
}

export function SecretsPageContent({ activeScope }: { activeScope: SecretScope }) {
  const router = useRouter()
  const [secrets, setSecrets] = useState<SecretItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function loadAll() {
    setLoading(true)
    setError('')
    try {
      const response = (await apiGet('/api/v1/admin/secrets')) as { items?: SecretItem[] }
      setSecrets(response.items || [])
    } catch (nextError) {
      if (isSilentApiError(nextError)) return
      setError(nextError instanceof Error ? nextError.message : 'Failed to load secrets')
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
        <SecretsTable
          activeScope={activeScope}
          items={secrets}
          onChanged={loadAll}
          onRefresh={loadAll}
          refreshing={loading}
          loading={loading}
          onCreateLlmSecret={() => router.push(CONTROL_ROUTES.secrets.new({ scope: 'llm' }))}
          onCreateMcpSecret={() => router.push(CONTROL_ROUTES.secrets.new({ scope: 'mcp' }))}
          onCreateRecipeSecret={() => router.push(CONTROL_ROUTES.secrets.new({ scope: 'recipe' }))}
          onCreateRecipeSecretFor={(name, keys, ownerRecipe, namespace) => {
            const params = new URLSearchParams({ scope: 'recipe', name })
            if (keys.length > 0) params.set('keys', keys.join(','))
            if (ownerRecipe) params.set('ownerRecipe', ownerRecipe)
            if (namespace) params.set('namespace', namespace)
            router.push(CONTROL_ROUTES.secrets.new(Object.fromEntries(params)))
          }}
        />
      </DashboardLayout>
    </AuthGate>
  )
}
