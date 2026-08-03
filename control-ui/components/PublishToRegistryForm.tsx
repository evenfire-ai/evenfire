'use client'

import React, { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { CONTROL_ROUTES } from '@constants/routes'
import { getPublishScope, publishToRegistry } from '../lib/api'
import type { PublishScope } from '../lib/api'
import { egressStatusToRegistrySummary } from '../lib/egressModel'
import type { EgressEditorStatus, EgressSummary } from '../lib/egressModel'
import { isValidK8sName } from '../lib/k8sValidation'
import { CreateFlowPanel } from './CreateFlowPanel'
import { CreateStepFlow } from './CreateStepFlow'
import { EgressEditor } from './EgressEditor'
import { SegmentedControl } from './SegmentedControl'
import { TabBar } from './TabBar'
import { useToast } from './Toast'

interface Props {
  initialEntryType?: EntryType
  onPublished: () => void
  onCancel: () => void
  pageHeader?: ReactNode
}

const PUBLISH_STEP_LABELS = ['Entry', 'Metadata', 'Package', 'Review'] as const

const PUBLISH_STEP_DETAILS = [
  {
    description: 'Choose type and name',
    title: 'Marketplace entry',
    subtitle: 'Choose what you are publishing and set its Marketplace name.',
  },
  {
    description: 'Describe the listing',
    title: 'Listing metadata',
    subtitle: 'Add the version, author, category, tags, and description.',
  },
  {
    description: 'Define install details',
    title: 'Package configuration',
    subtitle: 'Provide connector runtime metadata or the plugin manifest.',
  },
  {
    description: 'Confirm and publish',
    title: 'Review publish',
    subtitle: 'Check the Marketplace entry before publishing it.',
  },
] as const

const CATEGORIES = [
  'databases',
  'search',
  'ai-ml',
  'communication',
  'monitoring',
  'storage',
  'devtools',
  'security',
  'analytics',
  'other',
] as const

const ORIGINS = [
  { value: 'human-authored', label: 'Human Authored' },
  { value: 'agent-generated', label: 'Agent Generated' },
  { value: 'community', label: 'Community' },
] as const

const TRANSPORT_TYPES = [
  { value: 'streamableHttp', label: 'StreamableHTTP' },
  { value: 'sse', label: 'SSE' },
  { value: 'stdio', label: 'stdio' },
] as const

const CREDENTIAL_KINDS = [
  'api-key',
  'oauth-token',
  'connection-string',
  'password',
  'text',
] as const

type EntryType = 'mcp-server' | 'recipe'
type ServerMode = 'local' | 'remote'
type CredKeyRow = { name: string; label: string; kind: string }

export function PublishToRegistryForm({
  initialEntryType = 'mcp-server',
  onPublished,
  onCancel,
  pageHeader,
}: Props) {
  const { showToast } = useToast()
  const [step, setStep] = useState(0)
  // Common fields
  const [entryType, setEntryType] = useState<EntryType>(initialEntryType)
  const [name, setName] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [description, setDescription] = useState('')
  const [author, setAuthor] = useState('')
  const [category, setCategory] = useState<string>(CATEGORIES[0])
  const [tagsInput, setTagsInput] = useState('')
  const [origin, setOrigin] = useState<string>('human-authored')

  // Connector fields
  const [serverMode, setServerMode] = useState<ServerMode>('local')
  const [imageRef, setImageRef] = useState('')
  const [transport, setTransport] = useState<string>('streamableHttp')
  const [port, setPort] = useState(3000)
  const [remoteEndpoint, setRemoteEndpoint] = useState('')
  const [egressSummary, setEgressSummary] = useState<EgressSummary | undefined>(undefined)
  const [egressStatus, setEgressStatus] = useState<EgressEditorStatus | null>(null)
  const [useCredentialSchema, setUseCredentialSchema] = useState(false)
  const [credKeys, setCredKeys] = useState<CredKeyRow[]>([])

  // Recipe fields
  const [recipeYaml, setRecipeYaml] = useState('')

  // State
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // Resolved publish target (org scope vs curated catalog). Informational only:
  // control-api applies the scope to the name server-side, so we don't touch the
  // bare `name` input or the payload — we only surface where the entry will land.
  const [publishScope, setPublishScope] = useState<PublishScope | null>(null)

  useEffect(() => {
    let cancelled = false
    getPublishScope()
      .then(scope => {
        if (!cancelled) setPublishScope(scope)
      })
      .catch(() => {
        // Soft-fail: if the target can't be resolved we just omit the indicator
        // rather than blocking the publish flow.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const nameValid = isValidK8sName(name)
  const metadataValid =
    version.trim().length > 0 && description.trim().length > 0 && author.trim().length > 0
  const packageValid =
    (entryType === 'mcp-server' && serverMode === 'local'
      ? imageRef.trim().length > 0 && (!egressStatus || egressStatus.errors.length === 0)
      : true) &&
    (entryType === 'mcp-server' && serverMode === 'remote'
      ? remoteEndpoint.trim().length > 0
      : true) &&
    (entryType === 'recipe' ? recipeYaml.trim().length > 0 : true)
  const canSubmit = name.length > 0 && nameValid && metadataValid && !submitting && packageValid
  const canContinue =
    step === 0 ? name.length > 0 && nameValid : step === 1 ? metadataValid : packageValid

  function canSelectStep(targetStep: number) {
    if (targetStep <= step) return true
    if (targetStep === 1) return name.length > 0 && nameValid
    if (targetStep === 2) return name.length > 0 && nameValid && metadataValid
    return name.length > 0 && nameValid && metadataValid && packageValid
  }

  function addCredKey() {
    setCredKeys(prev => [...prev, { name: '', label: '', kind: 'api-key' }])
  }

  function removeCredKey(idx: number) {
    setCredKeys(prev => prev.filter((_, i) => i !== idx))
  }

  function updateCredKey(idx: number, field: keyof CredKeyRow, val: string) {
    setCredKeys(prev => prev.map((k, i) => (i === idx ? { ...k, [field]: val } : k)))
  }

  function parseTags(input: string): string[] {
    if (!input.trim()) return []
    return input
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  }

  const handleEgressChange = useCallback((_bindings: unknown, status: EgressEditorStatus) => {
    setEgressStatus(status)
    setEgressSummary(egressStatusToRegistrySummary(status))
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return

    setSubmitting(true)
    setError('')

    const tags = parseTags(tagsInput)

    const payload: Record<string, unknown> = {
      name,
      version: version.trim(),
      entryType,
      description: description.trim(),
      author: author.trim(),
      origin,
      category,
      tags,
      contentCreatorTag: 'community',
      configCreatorTag: 'community',
    }

    if (entryType === 'mcp-server') {
      const mcpServer: Record<string, unknown> = {
        serverMode,
      }

      if (serverMode === 'local') {
        mcpServer.imageRef = imageRef.trim()
        mcpServer.transport = transport
        mcpServer.port = port
        if (egressSummary) {
          mcpServer.egressSummary = egressSummary
        }
      } else {
        mcpServer.remoteEndpoints = [{ url: remoteEndpoint.trim() }]
      }

      if (useCredentialSchema && credKeys.length > 0) {
        const validKeys = credKeys.filter(k => k.name.trim() && k.label.trim())
        if (validKeys.length > 0) {
          mcpServer.credentialSchema = {
            required: true,
            authType: 'custom',
            keys: validKeys.map(k => ({
              name: k.name.trim(),
              label: k.label.trim(),
              kind: k.kind,
              semanticType: k.kind,
              description: k.label.trim(),
            })),
          }
        }
      }

      payload.mcpServer = mcpServer
    } else {
      payload.recipe = recipeYaml.trim()
    }

    try {
      await publishToRegistry(payload)
      showToast('Published successfully.', { tone: 'success' })
      setTimeout(() => {
        onPublished()
      }, 800)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to publish entry')
    } finally {
      setSubmitting(false)
    }
  }

  const formContent = (
    <form onSubmit={handleSubmit}>
      <CreateStepFlow
        ariaLabel="Publish to Marketplace steps"
        className="cu-create-step-flow--4"
        currentStep={step}
        onStepChange={setStep}
        canSelectStep={canSelectStep}
        steps={PUBLISH_STEP_DETAILS}
        stepLabels={PUBLISH_STEP_LABELS}
        titleId="publish-marketplace-step-title"
      >
        {step === 0 ? (
          <div className="cu-form-stack cu-agent-form-stack">
            <SegmentedControl<EntryType>
              ariaLabel="Marketplace entry type"
              value={entryType}
              className="cu-segmented-control--flush cu-segmented-control--full"
              onChange={setEntryType}
              options={[
                { value: 'mcp-server', label: 'Connector' },
                { value: 'recipe', label: 'Plugin' },
              ]}
            />
            <div className="cu-field">
              <label htmlFor="pub-name">
                Name <span className="cu-field__required">*</span>
              </label>
              <input
                id="pub-name"
                className="cu-input"
                value={name}
                onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                placeholder="my-mcp-server"
                maxLength={63}
              />
              {name.length > 0 && !nameValid && (
                <p className="cu-field__error">
                  Must be a valid K8s name (lowercase, alphanumeric, hyphens, max 63 chars)
                </p>
              )}
            </div>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="cu-form-stack cu-agent-form-stack">
            <div className="cu-form-grid cu-form-grid--2">
              <div className="cu-field">
                <label htmlFor="pub-version">
                  Version <span className="cu-field__required">*</span>
                </label>
                <input
                  id="pub-version"
                  className="cu-input"
                  value={version}
                  onChange={e => setVersion(e.target.value)}
                  placeholder="1.0.0"
                />
              </div>
              <div className="cu-field">
                <label htmlFor="pub-author">
                  Author <span className="cu-field__required">*</span>
                </label>
                <input
                  id="pub-author"
                  className="cu-input"
                  value={author}
                  onChange={e => setAuthor(e.target.value)}
                  placeholder="Your name or org"
                />
              </div>
            </div>
            <div className="cu-field">
              <label htmlFor="pub-description">
                Description <span className="cu-field__required">*</span>
              </label>
              <textarea
                id="pub-description"
                className="cu-input"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="A brief description of this entry"
                rows={3}
              />
            </div>
            <div className="cu-form-grid cu-form-grid--2">
              <div className="cu-field">
                <label htmlFor="pub-category">Category</label>
                <select
                  id="pub-category"
                  className="cu-input"
                  value={category}
                  onChange={e => setCategory(e.target.value)}
                >
                  {CATEGORIES.map(c => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="cu-field">
                <label htmlFor="pub-origin">Origin</label>
                <select
                  id="pub-origin"
                  className="cu-input"
                  value={origin}
                  onChange={e => setOrigin(e.target.value)}
                >
                  {ORIGINS.map(o => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="cu-field">
              <label htmlFor="pub-tags">Tags</label>
              <input
                id="pub-tags"
                className="cu-input"
                value={tagsInput}
                onChange={e => setTagsInput(e.target.value)}
                placeholder="database, postgres, sql (comma-separated)"
              />
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="cu-form-stack cu-agent-form-stack cu-agent-form-stack--wide">
            {entryType === 'mcp-server' ? (
              <>
                <TabBar<ServerMode>
                  ariaLabel="Connector mode"
                  activeValue={serverMode}
                  className="cu-tabs--flush"
                  onChange={setServerMode}
                  options={[
                    { value: 'local', label: 'Local' },
                    { value: 'remote', label: 'Remote' },
                  ]}
                />
                {serverMode === 'local' ? (
                  <>
                    <div className="cu-field">
                      <label htmlFor="pub-image">
                        Image Ref <span className="cu-field__required">*</span>
                      </label>
                      <input
                        id="pub-image"
                        className="cu-input"
                        value={imageRef}
                        onChange={e => setImageRef(e.target.value)}
                        placeholder="us-central1-docker.pkg.dev/my-project/repo/mcp-server:1.0.0"
                      />
                    </div>
                    <div className="cu-form-grid cu-form-grid--2">
                      <div className="cu-field">
                        <label htmlFor="pub-transport">Transport</label>
                        <select
                          id="pub-transport"
                          className="cu-input"
                          value={transport}
                          onChange={e => setTransport(e.target.value)}
                        >
                          {TRANSPORT_TYPES.map(t => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      {transport !== 'stdio' && (
                        <div className="cu-field">
                          <label htmlFor="pub-port">Port</label>
                          <input
                            id="pub-port"
                            className="cu-input"
                            type="number"
                            value={port}
                            onChange={e => setPort(parseInt(e.target.value, 10) || 3000)}
                            min={1}
                            max={65535}
                          />
                        </div>
                      )}
                    </div>
                    <EgressEditor
                      description="Declare the Marketplace egress intent that Control API will translate into connector egress bindings during install."
                      onChange={handleEgressChange}
                      title="Marketplace Egress Metadata"
                    />
                  </>
                ) : (
                  <div className="cu-field">
                    <label htmlFor="pub-remote-url">
                      Endpoint URL <span className="cu-field__required">*</span>
                    </label>
                    <input
                      id="pub-remote-url"
                      className="cu-input"
                      type="url"
                      value={remoteEndpoint}
                      onChange={e => setRemoteEndpoint(e.target.value)}
                      placeholder="https://mcp.example.com/sse"
                    />
                  </div>
                )}
                <label htmlFor="pub-cred-toggle" className="cu-checkbox-field">
                  <input
                    type="checkbox"
                    id="pub-cred-toggle"
                    checked={useCredentialSchema}
                    onChange={e => setUseCredentialSchema(e.target.checked)}
                  />
                  <span className="cu-checkbox-field__content">
                    <span className="cu-checkbox-field__label">Define Credential Schema</span>
                  </span>
                </label>
                {useCredentialSchema && (
                  <fieldset className="cu-form-section">
                    <legend className="cu-section-title">Credential Keys</legend>
                    {credKeys.length > 0 && (
                      <div className="cu-publish-cred-header">
                        <span>Key Name</span>
                        <span>Label</span>
                        <span>Kind</span>
                        <span />
                      </div>
                    )}
                    {credKeys.map((ck, idx) => (
                      <div key={`${idx}-${ck.name}`} className="cu-publish-cred-row">
                        <input
                          className="cu-input"
                          value={ck.name}
                          onChange={e => updateCredKey(idx, 'name', e.target.value)}
                          placeholder="api-key"
                        />
                        <input
                          className="cu-input"
                          value={ck.label}
                          onChange={e => updateCredKey(idx, 'label', e.target.value)}
                          placeholder="API Key"
                        />
                        <select
                          className="cu-input"
                          value={ck.kind}
                          onChange={e => updateCredKey(idx, 'kind', e.target.value)}
                        >
                          {CREDENTIAL_KINDS.map(k => (
                            <option key={k} value={k}>
                              {k}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="cu-btn cu-btn--danger-icon cu-btn--icon"
                          onClick={() => removeCredKey(idx)}
                        >
                          <span>&#x2715;</span>
                        </button>
                      </div>
                    ))}
                    <button type="button" className="cu-btn cu-btn--sm" onClick={addCredKey}>
                      + Add Key
                    </button>
                  </fieldset>
                )}
              </>
            ) : (
              <div className="cu-field">
                <label htmlFor="pub-recipe-yaml">
                  Plugin YAML / JSON <span className="cu-field__required">*</span>
                </label>
                <textarea
                  id="pub-recipe-yaml"
                  className="cu-input cu-input--monospace cu-publish-recipe-input"
                  value={recipeYaml}
                  onChange={e => setRecipeYaml(e.target.value)}
                  placeholder="Paste your WorkflowRecipe YAML or JSON here..."
                  rows={12}
                />
              </div>
            )}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="cu-form-stack cu-agent-form-stack">
            <div className="cu-agent-review">
              Publishing <b>{name || '-'}</b> as a{' '}
              <b>{entryType === 'mcp-server' ? 'connector' : 'plugin'}</b> at version{' '}
              <b>{version || '-'}</b>.
            </div>
            <div className="cu-agent-option-meta">{description || 'No description yet.'}</div>
            {/* Publish target — where this entry lands. Informational only: control-api
                scopes the name server-side, so the bare `name` input and the payload are
                unchanged. Curator (or no resolved scope) → the public @clerum catalog;
                otherwise the caller's bound org, with a preview of the scoped name. */}
            {publishScope &&
              (publishScope.curator || publishScope.scope === null ? (
                <div className="cu-field">
                  <label htmlFor="pub-target">Publish target</label>
                  <div className="cu-field__readonly" id="pub-target" aria-readonly="true">
                    Publishing to the public catalog (@clerum)
                  </div>
                  <p className="cu-field__hint">Curated catalog entries are always public.</p>
                </div>
              ) : (
                <div className="cu-field">
                  <label htmlFor="pub-target">Publish target</label>
                  <div className="cu-field__readonly" id="pub-target" aria-readonly="true">
                    Publishing to your org: <code>{publishScope.scope}</code>
                  </div>
                  <p className="cu-field__hint">
                    Published as{' '}
                    <code>
                      {publishScope.scope}/{name || '<name>'}
                    </code>{' '}
                    — discoverable by your tenant.
                  </p>
                  <p className="cu-field__hint">
                    Need a key to publish from CI or a script?{' '}
                    <Link href={CONTROL_ROUTES.marketplace.keys}>Manage API keys →</Link>
                  </p>
                </div>
              ))}
            {/* Visibility is fixed for the curated @clerum catalog — the registry forces
                public, so we surface a locked, read-only indicator rather than a toggle.
                This is informational only and does not affect the submitted payload. */}
            <div className="cu-field">
              <label htmlFor="pub-visibility">Visibility</label>
              <div className="cu-field__readonly" id="pub-visibility" aria-readonly="true">
                <span className="cu-registry-chip cu-registry-chip--visibility-public">Public</span>
              </div>
              <p className="cu-field__hint">Curated catalog entries are always public.</p>
            </div>
          </div>
        ) : null}

        {error && <div className="cu-banner cu-banner--error">{error}</div>}

        <div className="cu-create-actions">
          <button
            type="button"
            className="cu-btn cu-btn--ghost cu-btn--sm"
            onClick={() => (step === 0 ? onCancel() : setStep(current => current - 1))}
            disabled={submitting}
          >
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {step < PUBLISH_STEP_LABELS.length - 1 ? (
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={() =>
                setStep(current => Math.min(PUBLISH_STEP_LABELS.length - 1, current + 1))
              }
              disabled={submitting || !canContinue}
            >
              Continue
            </button>
          ) : (
            <button
              type="submit"
              className="cu-btn cu-btn--primary cu-btn--sm"
              disabled={!canSubmit}
            >
              {submitting ? 'Publishing...' : 'Publish to Marketplace'}
            </button>
          )}
        </div>
      </CreateStepFlow>
    </form>
  )

  if (pageHeader) {
    return <CreateFlowPanel header={pageHeader}>{formContent}</CreateFlowPanel>
  }

  return <div className="cu-agent-create-panel">{formContent}</div>
}
