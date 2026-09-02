'use client'

import { useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'
import { getContexts, getHosts } from '@lib/api'
import type { ContextResource } from '@lib/api'
import { contextAliases, contextForAlias } from '@lib/contextIdentity'

// Legacy deep-link resolver for the removed Contexts section.
//
// The k8s Context resource still exists (agents keep their private connector
// scopes), but it has no UI of its own anymore. Old links land here and are
// forwarded to the closest user-facing destination:
//   /contexts, /contexts/new              → the Agents list
//   /contexts/<private-slug>[/any/tab]    → the owning agent's Connectors tab
//   /contexts/<unknown-slug>[/any/tab]    → the Agents list (fail-safe)
//
// Lookup failures also fall back to the Agents list so a bookmark never dead-
// ends. The write model is untouched: this page only navigates.
export default function LegacyContextRedirectPage() {
  const router = useRouter()
  const params = useParams<{ slug?: string[] | string }>()

  useEffect(() => {
    let cancelled = false

    const fallback = () => {
      if (!cancelled) router.replace(CONTROL_ROUTES.agents.root)
    }

    void (async () => {
      try {
        const raw = Array.isArray(params?.slug) ? params.slug[0] : params?.slug
        const slug = decodeURIComponent(raw ?? '').trim()
        if (!slug || slug === 'new') {
          fallback()
          return
        }

        const [hostsResponse, contextsResponse] = await Promise.all([getHosts(), getContexts()])
        const context = contextForAlias((contextsResponse.items ?? []) as ContextResource[], slug)
        const aliases = new Set(context ? contextAliases(context) : [slug])
        const owner = (
          (hostsResponse.items ?? []) as Array<{
            metadata?: { name?: string }
            spec?: { contextRef?: string }
          }>
        ).find(host => aliases.has(String(host.spec?.contextRef ?? '').trim()))

        if (!owner?.metadata?.name) {
          fallback()
          return
        }
        if (!cancelled) {
          router.replace(CONTROL_ROUTES.agents.tab(owner.metadata.name, 'connectors'))
        }
      } catch {
        fallback()
      }
    })()

    return () => {
      cancelled = true
    }
  }, [params?.slug, router])

  return (
    <div
      role="status"
      aria-label="Redirecting"
      className="cu-empty"
      style={{ margin: '2rem auto', maxWidth: '24rem', textAlign: 'center' }}
    >
      Taking you to the right place…
    </div>
  )
}
