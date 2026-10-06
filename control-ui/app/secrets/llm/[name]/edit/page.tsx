'use client'

import React, { Suspense, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { BodyLoadingSkeleton, FormSectionsSkeleton } from '@components/BodyLoadingSkeleton'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { LlmSecretEditor } from '@components/LlmSecretEditor'
import { IconKey } from '@components/Sidebar/icons'
import { CONTROL_ROUTES } from '@constants/routes'
import { getHosts, listLlmHostSecrets } from '@lib/api'
import { normalizeLlmPolicy } from '@lib/llm'

// Credential slots (Secret data-key names) that persisted Host fallback
// policies still reference through this Secret. Retiring one would break a
// live fallback, so the editor refuses the removal upfront. Scanning every
// Host keeps the guard whole regardless of which surface linked here — the
// list flow previously shipped without it because the table had no Host data.
function collectProtectedCredentialSlots(
  hosts: Awaited<ReturnType<typeof getHosts>>['items'],
  secretName: string
): string[] {
  const slots = new Set<string>()
  for (const host of hosts ?? []) {
    const spec = (host.spec ?? {}) as Record<string, unknown>
    if (String(spec.secretRef || '').trim() !== secretName) continue
    for (const fallback of normalizeLlmPolicy(spec.llmPolicy)?.fallbacks ?? []) {
      const slot = String(fallback.credentialSlot || '').trim()
      if (slot) slots.add(slot)
    }
  }
  return Array.from(slots)
}

function EditLlmSecretContent() {
  const router = useRouter()
  const params = useParams<{ name: string }>()
  const searchParams = useSearchParams()
  const secretName = useMemo(() => {
    const raw = params?.name
    const value = Array.isArray(raw) ? raw[0] : raw
    try {
      return decodeURIComponent(value ?? '')
    } catch {
      return value ?? ''
    }
  }, [params])

  // Optional return context for flows that linked here from another surface
  // (the agent Models & creds editor). Only same-app paths are honored so the
  // param can never aim the back action off-site.
  const fromParam = (searchParams.get('from') ?? '').trim()
  const backTarget =
    fromParam.startsWith('/') && !fromParam.startsWith('//')
      ? fromParam
      : CONTROL_ROUTES.secrets.llm

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [existingKeys, setExistingKeys] = useState<string[]>([])
  const [protectedCredentialSlots, setProtectedCredentialSlots] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    if (!secretName) {
      setLoadError('Missing secret name in URL.')
      setLoading(false)
      return
    }
    void (async () => {
      try {
        // Fail closed: the fallback-slot guard is only sound when the Host
        // read succeeds, so a failed listing blocks editing instead of
        // silently shipping an unguarded retirement surface.
        const [secretsRes, hostsRes] = await Promise.all([listLlmHostSecrets(), getHosts()])
        if (cancelled) return
        const match = (secretsRes.items ?? []).find(
          secret => String(secret.name || '').trim() === secretName
        )
        if (!match) {
          setNotFound(true)
          setLoading(false)
          return
        }
        setExistingKeys(Array.isArray(match.keys) ? match.keys : [])
        setProtectedCredentialSlots(collectProtectedCredentialSlots(hostsRes.items, secretName))
        setLoading(false)
      } catch (e) {
        if (cancelled) return
        setLoadError(e instanceof Error ? e.message : 'Failed to load LLM secret')
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [secretName])

  function goBack() {
    router.push(backTarget)
  }

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CreatePageHeader
          icon={<IconKey />}
          title={`Edit LLM secret${secretName ? `: ${secretName}` : ''}`}
          subtitle="Stored values are never returned by the API. Type a new value to overwrite a key, or remove it to delete that key on save."
          backLabel="Back to secrets"
          onBack={goBack}
        />

        <div className="cu-create-panel">
          <div className="cu-create-content">
            {loading ? (
              <FormSectionsSkeleton
                label="LLM secret"
                primaryActionLabel="Update secret"
                sections={2}
              />
            ) : loadError ? (
              <div className="cu-banner cu-banner--error">{loadError}</div>
            ) : notFound ? (
              <div className="cu-banner cu-banner--error">
                LLM secret <code>{secretName}</code> was not found.
              </div>
            ) : (
              <LlmSecretEditor
                secretName={secretName}
                existingKeys={existingKeys}
                protectedCredentialSlots={protectedCredentialSlots}
                onClose={goBack}
              />
            )}
          </div>
        </div>
      </DashboardLayout>
    </AuthGate>
  )
}

export default function EditLlmSecretPage() {
  return (
    <Suspense
      fallback={
        <BodyLoadingSkeleton
          backLabel="Back to secrets"
          icon={<IconKey />}
          primaryActionLabel="Update secret"
          sections={2}
          subtitle="Load the saved key metadata before editing stored values."
          title="Edit LLM secret"
        />
      }
    >
      <EditLlmSecretContent />
    </Suspense>
  )
}
