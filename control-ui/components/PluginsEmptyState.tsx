'use client'

import { useEffect, useState } from 'react'
import { CONTROL_ROUTES } from '@constants/routes'
import { listRegistryApiKeys } from '../lib/api'

const PLUGIN_DOCS_URL =
  'https://github.com/evenfire-ai/evenfire/blob/main/docs/how-to/publish-plugin-to-registry.md'

// A single listRegistryApiKeys() answers everything the copy needs: success
// means this deployment is connected to an org (and whether it already has
// keys); a 403 means the org is connected but this admin isn't an owner (keys
// unknown); a 409 (no_org / auth_disabled / url_not_configured) means there is
// no org yet, so we show the onboarding path.
type Setup =
  | { kind: 'loading' }
  | { kind: 'onboarding' }
  | { kind: 'connected'; org?: string; hasKeys: boolean | null }

/**
 * Empty-state explainer for the Plugins list. Explains what a plugin is, and
 * adapts the call to action: an already-connected org with keys is told it is
 * ready to publish, rather than being walked through setup it has done.
 */
export function PluginsEmptyState() {
  const [setup, setSetup] = useState<Setup>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    listRegistryApiKeys().then(
      ({ org, keys }) => {
        if (!cancelled) setSetup({ kind: 'connected', org, hasKeys: keys.length > 0 })
      },
      (e: unknown) => {
        if (cancelled) return
        if ((e as { status?: number }).status === 403) {
          setSetup({ kind: 'connected', org: (e as { org?: string }).org, hasKeys: null })
        } else {
          setSetup({ kind: 'onboarding' })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  const orgTag = setup.kind === 'connected' && setup.org ? `@${setup.org}` : null

  return (
    <div className="cu-empty__explainer">
      <p>
        <strong>Plugins</strong> are packaged, versioned workflows that run in your cluster. A
        plugin bundles one or more workloads and how they fire — on a <strong>schedule</strong>{' '}
        (recurring jobs), from an incoming <strong>webhook</strong>, on a chat message, or on demand
        — and those workloads can serve a <strong>UI</strong>, expose tools to your agents, or run
        background automation.
      </p>

      {setup.kind === 'connected' ? (
        <p>
          {orgTag ? (
            <>
              Your organization <strong>{orgTag}</strong> is connected
            </>
          ) : (
            'Your organization is connected'
          )}
          {setup.hasKeys === true ? ' and already has API keys' : ''}. Publish a plugin
          {orgTag ? (
            <>
              {' '}
              under <strong>{orgTag}</strong>
            </>
          ) : (
            ''
          )}
          , then install it across your cluster with <strong>Install Plugin</strong>.
          {setup.hasKeys === false ? (
            <>
              {' '}
              To publish from CI or scripts, create an{' '}
              <a className="cu-link" href={CONTROL_ROUTES.marketplace.keys}>
                org API key
              </a>
              .
            </>
          ) : null}
        </p>
      ) : (
        <p>
          Plugins here are <strong>private to your organization</strong> and shared across it:
          publish a plugin under your org, then install it across your cluster with{' '}
          <strong>Install Plugin</strong>. First, name your organization in the registry by{' '}
          <a className="cu-link" href={CONTROL_ROUTES.marketplace.connect}>
            connecting
          </a>{' '}
          and creating an{' '}
          <a className="cu-link" href={CONTROL_ROUTES.marketplace.keys}>
            org API key
          </a>
          .
        </p>
      )}

      <p>
        <a className="cu-link" href={PLUGIN_DOCS_URL} target="_blank" rel="noreferrer">
          Learn more about plugins →
        </a>
      </p>
    </div>
  )
}
