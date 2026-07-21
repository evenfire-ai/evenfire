'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { CredentialSchema, RegistryEntry } from '../lib/api'
import { getContexts, getRegistryCredentialSchema, installFromRegistry } from '../lib/api'
import { registryEntryToEgressBindings } from '../lib/egressModel'
import type { EgressBinding, EgressEditorStatus } from '../lib/egressModel'
import { isValidK8sName, toK8sName } from '../lib/k8sValidation'
import { buildPastedValue } from '../lib/pasteUtils'
import { trustBgColor, trustColor } from '../lib/trustLevel'
import { EgressEditor } from './EgressEditor'
import { useToast } from './Toast'
import { getEmbeddedCredentialSchema, getExternalEgressNotice } from './registryInstallHelpers'

interface Props {
  entry: RegistryEntry
  isOpen: boolean
  onClose: () => void
  onInstalled: () => void
}

export function RegistryInstallModal({ entry, isOpen, onClose, onInstalled }: Props) {
  const { showToast } = useToast()
  // Default to a K8s-valid name derived from the scoped registry name (e.g.
  // `@org/name` → `org-name`); `entry.name` itself is not a valid resource name.
  const [serverName, setServerName] = useState(toK8sName(entry.name))
  const [contextRef, setContextRef] = useState('')
  const [contexts, setContexts] = useState<Array<{ name: string }>>([])
  const [credSchema, setCredSchema] = useState<CredentialSchema | null>(null)
  const [credValues, setCredValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const [egressBindings, setEgressBindings] = useState<EgressBinding[] | undefined>(undefined)
  const [egressStatus, setEgressStatus] = useState<EgressEditorStatus | null>(null)
  const installInFlightRef = useRef(false)
  const registryInitialEgressBindings = useMemo(() => registryEntryToEgressBindings(entry), [entry])

  // Load credential schema + contexts on open
  useEffect(() => {
    if (!isOpen) return
    installInFlightRef.current = false
    setServerName(toK8sName(entry.name))
    setError('')
    setCredValues({})
    setEgressBindings(registryInitialEgressBindings)
    setEgressStatus(null)
    setLoading(true)
    ;(async () => {
      try {
        const [schema, ctxResult] = await Promise.all([
          getRegistryCredentialSchema(entry.name, entry.version).catch(() =>
            getEmbeddedCredentialSchema(entry)
          ),
          getContexts(),
        ])
        setCredSchema(schema)
        const ctxItems = (ctxResult.items ?? [])
          .map(c => ({
            name: (c.metadata as Record<string, string>)?.name ?? '',
          }))
          .filter(c => c.name)
        setContexts(ctxItems)
        if (ctxItems.length > 0) {
          setContextRef(prev => prev || ctxItems[0].name)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load configuration')
      } finally {
        setLoading(false)
      }
    })()
  }, [isOpen, entry.name, entry.version, registryInitialEgressBindings])

  if (!isOpen) return null

  const nameValid = isValidK8sName(serverName)
  const credHasKeys = (credSchema?.keys?.length ?? 0) > 0
  const credRequired = !!credSchema?.required && credHasKeys
  const credStarted =
    credRequired && credSchema!.keys.some(k => (credValues[k.name] ?? '').trim() !== '')
  const missingCredentialKeys =
    credRequired && credStarted
      ? credSchema!.keys.filter(k => !(credValues[k.name] ?? '').trim()).map(k => k.label || k.name)
      : []
  const credComplete = !credStarted || missingCredentialKeys.length === 0
  const externalEgressNotice = getExternalEgressNotice(entry)
  const remoteRequiresEgress = entry.server_mode === 'remote'
  const egressValid =
    egressStatus !== null &&
    egressStatus.errors.length === 0 &&
    !(remoteRequiresEgress && egressStatus.mode === 'none')
  const canSubmit =
    nameValid && contextRef.trim() !== '' && credComplete && egressValid && !installing
  const externalTargetsText = externalEgressNotice?.targets.length
    ? externalEgressNotice.targets.join(', ')
    : 'public internet'
  const externalPortsText = externalEgressNotice?.ports.join(', ') ?? ''

  async function handleInstall() {
    if (!canSubmit || installInFlightRef.current) return

    installInFlightRef.current = true
    setInstalling(true)
    setError('')

    try {
      const filled = credHasKeys
        ? Object.fromEntries(
            credSchema!.keys
              .map(k => [k.name, credValues[k.name] ?? ''])
              .filter(([, v]) => (v as string).trim() !== '')
          )
        : {}
      const credentials: Record<string, string> | undefined =
        Object.keys(filled).length > 0 ? filled : undefined
      const selectedEgressBindings =
        egressStatus?.mode === 'none' && (registryInitialEgressBindings?.length ?? 0) > 0
          ? []
          : egressBindings

      await installFromRegistry({
        serverName: serverName || undefined,
        contextRef,
        registryEntryName: entry.name,
        registryEntryVersion: entry.version,
        credentials,
        egressBindings: selectedEgressBindings,
      })

      showToast(`"${serverName}" was installed and added to context "${contextRef}".`, {
        tone: 'success',
      })
      setCredValues({})
      onInstalled()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Installation failed')
    } finally {
      installInFlightRef.current = false
      setInstalling(false)
    }
  }

  function pasteCredentialValue(keyName: string, event: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData('text')
    if (!pasted) return
    event.preventDefault()

    const current = credValues[keyName] ?? ''
    const nextValue = buildPastedValue(current, pasted, event.currentTarget)
    setCredValues(previous => ({ ...previous, [keyName]: nextValue }))
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1100,
        padding: '1rem',
      }}
      role="presentation"
      onClick={e => {
        if (e.target === e.currentTarget) {
          setCredValues({})
          onClose()
        }
      }}
    >
      <div
        className="cu-modal-panel"
        style={{
          width: 'min(36rem, 96vw)',
          maxHeight: '90vh',
          overflow: 'auto',
          padding: '1.5rem',
        }}
        role="dialog"
        aria-modal="true"
        onClick={e => e.stopPropagation()}
      >
        <h3
          style={{
            margin: '0 0 1rem',
            fontSize: '1.125rem',
            fontWeight: 600,
            color: 'var(--cu-text)',
          }}
        >
          Install Connector from Marketplace
        </h3>

        {externalEgressNotice && (
          <div
            role="alert"
            style={{
              background: '#3a3a1a',
              border: '1px solid #996a3a',
              borderRadius: 'var(--cu-radius-sm)',
              padding: '0.75rem 1rem',
              marginBottom: '0.75rem',
              fontSize: '0.8rem',
              color: '#fff8a0',
              display: 'flex',
              gap: '0.5rem',
              alignItems: 'flex-start',
              lineHeight: 1.4,
            }}
          >
            <span aria-hidden="true" style={{ fontSize: '1rem', lineHeight: 1 }}>
              ⚠️
            </span>
            <span>
              {externalEgressNotice.isRemote
                ? 'Remote connector.'
                : externalEgressNotice.wideCidr
                  ? 'Public web egress required.'
                  : 'External API access required.'}{' '}
              {externalEgressNotice.wideCidr
                ? 'Installing this CRD explicitly authorizes public web egress via NetworkPolicy rules on TCP ports '
                : 'Installing this CRD explicitly authorizes outbound egress via NetworkPolicy rules to '}
              {!externalEgressNotice.wideCidr && <strong>{externalTargetsText}</strong>}
              {!externalEgressNotice.wideCidr && ' on port'}
              {!externalEgressNotice.wideCidr &&
                (externalEgressNotice.ports.length > 1 ? 's ' : ' ')}
              {externalEgressNotice.wideCidr && (
                <>
                  <strong>{externalPortsText}</strong>. Private, metadata, cluster-internal,
                  link-local, multicast, and reserved ranges remain blocked.
                  {externalEgressNotice.targets.length > 0 && (
                    <>
                      {' '}
                      Listed domains ({externalTargetsText}) are examples and not the complete
                      enforcement boundary.
                    </>
                  )}
                </>
              )}
              {!externalEgressNotice.wideCidr && <strong>{externalPortsText}</strong>}
              {!externalEgressNotice.wideCidr && '.'} This expands to{' '}
              <strong>{externalEgressNotice.bindingCount}</strong> egress binding
              {externalEgressNotice.bindingCount === 1 ? '' : 's'}.
              {externalEgressNotice.isRemote && (
                <>
                  {' '}
                  Credentials will be securely stored in K8s and forwarded via the egress proxy. The
                  pod runs nginx in our cluster, NOT the vendor&rsquo;s image.
                </>
              )}
              {externalEgressNotice.blockingError && (
                <span style={{ display: 'block', marginTop: 8, color: '#ff8ea7', fontWeight: 700 }}>
                  {externalEgressNotice.blockingError}
                </span>
              )}
            </span>
          </div>
        )}

        {/* Entry details */}
        <div
          style={{
            background: 'var(--cu-bg-elevated)',
            borderRadius: 'var(--cu-radius-sm)',
            padding: '0.75rem 1rem',
            marginBottom: '1rem',
            fontSize: '0.875rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              alignItems: 'baseline',
              marginBottom: '0.25rem',
            }}
          >
            <strong style={{ color: 'var(--cu-text)' }}>{entry.name}</strong>
            <span style={{ color: 'var(--cu-text-muted)' }}>v{entry.version}</span>
            <span
              style={{
                fontSize: '0.75rem',
                padding: '1px 6px',
                borderRadius: 4,
                background: trustBgColor(entry.trust_level),
                color: trustColor(entry.trust_level),
              }}
            >
              {entry.trust_level}
            </span>
          </div>
          {entry.description && (
            <p style={{ margin: 0, color: 'var(--cu-text-muted)', lineHeight: 1.4 }}>
              {entry.description}
            </p>
          )}
          {entry.mcp_server_meta?.tools && entry.mcp_server_meta.tools.length > 0 && (
            <div style={{ marginTop: '0.5rem', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {entry.mcp_server_meta.tools.slice(0, 8).map(t => (
                <span
                  key={t}
                  style={{
                    fontSize: '0.7rem',
                    padding: '1px 5px',
                    borderRadius: 3,
                    background: 'var(--cu-bg-surface)',
                    color: 'var(--cu-text-muted)',
                  }}
                >
                  {t}
                </span>
              ))}
              {entry.mcp_server_meta.tools.length > 8 && (
                <span style={{ fontSize: '0.7rem', color: 'var(--cu-text-muted)' }}>
                  +{entry.mcp_server_meta.tools.length - 8} more
                </span>
              )}
            </div>
          )}
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--cu-text-muted)' }}>
            Loading configuration...
          </div>
        ) : (
          <form
            onSubmit={e => {
              e.preventDefault()
              handleInstall()
            }}
          >
            {/* Server name */}
            <div className="cu-field">
              <label htmlFor="ri-name">Server Name</label>
              <input
                id="ri-name"
                className="cu-input"
                value={serverName}
                onChange={e =>
                  setServerName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                }
                placeholder="my-mcp-server"
              />
              {serverName && !nameValid && (
                <p
                  style={{ fontSize: '0.75rem', color: 'var(--cu-danger)', margin: '0.25rem 0 0' }}
                >
                  Must be a valid K8s name (lowercase, alphanumeric, hyphens, max 63 chars)
                </p>
              )}
            </div>

            {/* Context selector */}
            <div className="cu-field">
              <label htmlFor="ri-context">Context</label>
              <select
                id="ri-context"
                className="cu-input"
                value={contextRef}
                onChange={e => setContextRef(e.target.value)}
              >
                <option value="">Select a context...</option>
                {contexts.map(c => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            {/* API key / token credential form */}
            {credHasKeys && (
              <fieldset
                style={{
                  border: '1px solid var(--cu-border)',
                  borderRadius: 'var(--cu-radius-sm)',
                  padding: '0.75rem 1rem',
                  marginBottom: '1rem',
                }}
              >
                <legend
                  style={{
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    color: 'var(--cu-text-muted)',
                    padding: '0 0.25rem',
                  }}
                >
                  Credentials ({credSchema!.authType}
                  {credRequired ? '' : ' — optional'})
                </legend>
                {credSchema!.keys.map(key => (
                  <div className="cu-field" key={key.name}>
                    <label htmlFor={`ri-cred-${key.name}`}>{key.label}</label>
                    <input
                      id={`ri-cred-${key.name}`}
                      className="cu-input"
                      type={key.kind === 'api-key' || key.kind === 'password' ? 'password' : 'text'}
                      value={credValues[key.name] ?? ''}
                      onChange={e =>
                        setCredValues(prev => ({ ...prev, [key.name]: e.target.value }))
                      }
                      onPaste={event => pasteCredentialValue(key.name, event)}
                      autoComplete="new-password"
                      placeholder={key.description}
                    />
                  </div>
                ))}
                {credRequired ? (
                  <div
                    className={`cu-banner ${credStarted && !credComplete ? 'cu-banner--error' : 'cu-banner--info'}`}
                    style={{ marginTop: '0.75rem' }}
                  >
                    {credStarted && !credComplete
                      ? `Complete all credential fields or clear them all to install pending. Missing: ${missingCredentialKeys.join(', ')}.`
                      : 'Leave all credential fields empty to install now and add this connector secret later from Secrets, or fill every field to create it during install.'}
                  </div>
                ) : null}
              </fieldset>
            )}

            <EgressEditor
              allowCidr
              description="Review and adjust the egress contract that will be installed from this Marketplace entry. The final CRD is created from this selection, not from the Marketplace warning alone."
              initialBindings={registryInitialEgressBindings}
              key={`${entry.name}-${entry.version}-${JSON.stringify(registryInitialEgressBindings ?? [])}`}
              onChange={(nextBindings, status) => {
                setEgressBindings(nextBindings)
                setEgressStatus(status)
              }}
            />
            {remoteRequiresEgress && egressStatus?.mode === 'none' ? (
              <div className="cu-banner cu-banner--error" role="alert">
                Remote connectors must keep exact-host egress to the selected vendor endpoint.
              </div>
            ) : null}

            {error && (
              <div className="cu-banner cu-banner--error" style={{ marginBottom: '1rem' }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button type="button" className="cu-btn" onClick={onClose} disabled={installing}>
                Cancel
              </button>
              <button type="submit" className="cu-btn cu-btn--primary" disabled={!canSubmit}>
                {installing ? 'Installing...' : 'Install'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
