'use client'

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreateFlowSkeleton } from '@components/CreateFlowSkeleton'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { DashboardLayout } from '@components/DashboardLayout'
import { LlmCredentialFields } from '@components/LlmCredentialFields'
import { IconKey } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { IconX } from '@components/icons'
import { Button, Field, FormSection, SelectInput, TextInput } from '@components/ui'
import { CREATE_FLOW_LOADING } from '@constants/createFlowLoading'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type CredentialSchema,
  type RecipeSecretOwnership,
  apiSend,
  createMcpSecret,
  createRecipeSecret,
  getRecipes,
  getRegistryCredentialSchema,
} from '@lib/api'
import { createEmptyLlmKeyDraft, validateLlmSecretData } from '@lib/llm'

const HOST_SECRET_LABEL_KEY = 'clerum.io/host-secret'
const HOST_SECRET_LABEL_VALUE = 'true'
const MCP_SECRET_NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

type SecretScope = 'llm' | 'mcp' | 'recipe'
type SecretDraftRow = { id: string; secretKey: string; value: string; label?: string }

const STEPS = ['Secret', 'Values'] as const

const STEP_DETAILS = [
  {
    description: 'Name and ownership',
    title: 'Secret identity',
    subtitle: 'Set the Kubernetes secret name and any ownership boundary.',
  },
  {
    description: 'Add secret values',
    title: 'Secret values',
    subtitle: 'Add the keys and credential values that will be stored.',
  },
] as const

function createSecretDraftRow(id: string, secretKey = '', value = '', label?: string): SecretDraftRow {
  return { id, secretKey, value, label }
}

function CreateSecretPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()

  const rawScope = searchParams.get('scope')
  const scope: SecretScope = rawScope === 'mcp' ? 'mcp' : rawScope === 'recipe' ? 'recipe' : 'llm'
  const secretsListPath =
    scope === 'mcp'
      ? CONTROL_ROUTES.secrets.connector
      : scope === 'recipe'
        ? CONTROL_ROUTES.secrets.recipe
        : CONTROL_ROUTES.secrets.llm

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [step, setStep] = useState(0)

  const [llmName, setLlmName] = useState('')
  const [llmKeyDraft, setLlmKeyDraft] = useState<Record<string, string>>(createEmptyLlmKeyDraft)

  const prefillMcpName = scope === 'mcp' ? (searchParams.get('name') ?? '').trim() : ''
  const registryEntryName = scope === 'mcp' ? (searchParams.get('registryEntry') ?? '').trim() : ''
  const registryEntryVersion =
    scope === 'mcp' ? (searchParams.get('registryVersion') ?? '').trim() : ''
  const [mcpName, setMcpName] = useState(prefillMcpName)
  const [mcpRows, setMcpRows] = useState<SecretDraftRow[]>(() => [
    createSecretDraftRow('mcp-secret-row-0'),
  ])
  const mcpNextRowId = useRef(1)
  const [mcpCredentialSchema, setMcpCredentialSchema] = useState<CredentialSchema | null>(null)
  const [mcpCredentialSchemaLoading, setMcpCredentialSchemaLoading] = useState(false)

  const prefillRecipeName = scope === 'recipe' ? (searchParams.get('name') ?? '').trim() : ''
  const prefillRecipeNamespace =
    scope === 'recipe' ? (searchParams.get('namespace') ?? 'sandbox-recipes').trim() : ''
  const prefillRecipeKeys = useMemo(() => {
    if (scope !== 'recipe') return [] as string[]
    const raw = searchParams.get('keys') ?? ''
    return raw
      .split(',')
      .map(k => k.trim())
      .filter(k => k.length > 0)
  }, [scope, searchParams])

  const [recipeName, setRecipeName] = useState(prefillRecipeName)
  const [recipeRows, setRecipeRows] = useState<SecretDraftRow[]>(
    prefillRecipeKeys.length > 0
      ? prefillRecipeKeys.map((key, index) =>
          createSecretDraftRow(`recipe-secret-row-${index}`, key)
        )
      : [createSecretDraftRow('recipe-secret-row-0')]
  )
  const recipeNextRowId = useRef(recipeRows.length)

  // Ownership controls the security boundary, not just a label — see
  // workflow-recipes/src/reconciler/secretOwnership.ts. Default to owner-recipe
  // since "shared" is a deliberate operator decision (multi-recipe credential
  // like a single Anthropic key reused across recipes), not the safer default.
  const prefillOwnerRecipe =
    scope === 'recipe' ? (searchParams.get('ownerRecipe') ?? '').trim() : ''
  const [recipeOwnershipKind, setRecipeOwnershipKind] = useState<'owner-recipe' | 'shared'>(
    prefillOwnerRecipe ? 'owner-recipe' : 'owner-recipe'
  )
  const [recipeOwnerName, setRecipeOwnerName] = useState(prefillOwnerRecipe)
  const [availableRecipes, setAvailableRecipes] = useState<string[]>([])

  useEffect(() => {
    if (scope !== 'recipe') return
    let cancelled = false
    void (async () => {
      try {
        const res = await getRecipes()
        if (cancelled) return
        const names = (res.items ?? [])
          .map(r => (r as { metadata?: { name?: string } }).metadata?.name ?? '')
          .filter(n => n.length > 0)
          .sort((a, b) => a.localeCompare(b))
        setAvailableRecipes(names)
        // Pre-fill the dropdown if there's exactly one recipe and no prefill.
        if (!prefillOwnerRecipe && names.length === 1) {
          setRecipeOwnerName(names[0])
        }
      } catch {
        // Non-fatal: the form still works; the operator just has to type the
        // recipe name. WRC will reject the Secret on POST if it doesn't match.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [scope, prefillOwnerRecipe])

  useEffect(() => {
    if (!registryEntryName || !registryEntryVersion) {
      setMcpCredentialSchema(null)
      setMcpCredentialSchemaLoading(false)
      return
    }

    let cancelled = false
    setMcpCredentialSchemaLoading(true)
    void getRegistryCredentialSchema(registryEntryName, registryEntryVersion)
      .then(schema => {
        if (cancelled) return
        setMcpCredentialSchema(schema)
        if (schema.keys.length === 0) return
        setMcpRows(current => {
          if (current.some(row => row.secretKey.trim() || row.value.trim())) return current
          return schema.keys.map((key, index) =>
            createSecretDraftRow(`mcp-schema-row-${index}`, key.name, '', key.label || key.name)
          )
        })
      })
      .catch(() => {
        if (!cancelled) setMcpCredentialSchema(null)
      })
      .finally(() => {
        if (!cancelled) setMcpCredentialSchemaLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [registryEntryName, registryEntryVersion])

  const llmCanSubmit = useMemo(() => {
    if (!llmName.trim()) return false
    return Object.values(llmKeyDraft).some(value => value.trim().length > 0) && !saving
  }, [llmKeyDraft, llmName, saving])

  const mcpCanSubmit = useMemo(() => {
    if (!mcpName.trim()) return false
    if (!MCP_SECRET_NAME_PATTERN.test(mcpName.trim()) || mcpName.trim().length > 253) return false
    const hasValues = mcpRows.some(
      row => row.secretKey.trim().length > 0 && row.value.trim().length > 0
    )
    const schemaComplete =
      !mcpCredentialSchema?.required ||
      mcpRows.length === mcpCredentialSchema.keys.length &&
        mcpRows.every(row => row.secretKey.trim().length > 0 && row.value.trim().length > 0)
    return hasValues && schemaComplete && !saving
  }, [mcpCredentialSchema, mcpName, mcpRows, saving])

  const recipeCanSubmit = useMemo(() => {
    if (!recipeName.trim()) return false
    if (!MCP_SECRET_NAME_PATTERN.test(recipeName.trim()) || recipeName.trim().length > 253)
      return false
    if (recipeOwnershipKind === 'owner-recipe' && !recipeOwnerName.trim()) return false
    return (
      recipeRows.some(row => row.secretKey.trim().length > 0 && row.value.trim().length > 0) &&
      !saving
    )
  }, [recipeName, recipeOwnerName, recipeOwnershipKind, recipeRows, saving])

  const activeSecretName =
    scope === 'llm' ? llmName.trim() : scope === 'mcp' ? mcpName.trim() : recipeName.trim()
  const activeRows =
    scope === 'llm'
      ? Object.entries(llmKeyDraft).filter(([, value]) => value.trim().length > 0)
      : scope === 'mcp'
        ? mcpRows.filter(row => row.secretKey.trim().length > 0 && row.value.trim().length > 0)
        : recipeRows.filter(row => row.secretKey.trim().length > 0 && row.value.trim().length > 0)
  const currentCanSubmit =
    scope === 'llm' ? llmCanSubmit : scope === 'mcp' ? mcpCanSubmit : recipeCanSubmit
  const activeNameInvalid =
    activeSecretName.length > 0 &&
    scope !== 'llm' &&
    (!MCP_SECRET_NAME_PATTERN.test(activeSecretName) || activeSecretName.length > 253)
  const canContinue =
    step === 0
      ? activeSecretName.length > 0 &&
        (scope === 'llm' ||
          (MCP_SECRET_NAME_PATTERN.test(activeSecretName) && activeSecretName.length <= 253)) &&
        (scope !== 'recipe' ||
          recipeOwnershipKind === 'shared' ||
          recipeOwnerName.trim().length > 0)
      : step === 1
        ? activeRows.length > 0
        : true

  function canSelectStep(targetStep: number) {
    if (targetStep <= step) return true
    if (targetStep === 1) return canContinue
    return currentCanSubmit
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (step < STEPS.length - 1) {
      if (canContinue) setStep(current => Math.min(STEPS.length - 1, current + 1))
      return
    }

    void (scope === 'llm'
      ? saveLlmSecret()
      : scope === 'mcp'
        ? saveMcpSecretResource()
        : saveRecipeSecretResource())
  }

  async function saveLlmSecret() {
    const secretName = llmName.trim()
    if (!secretName) {
      setError('Secret name is required.')
      return
    }
    const stringData = Object.fromEntries(
      Object.entries(llmKeyDraft)
        .map(([key, value]) => [key, value.trim()])
        .filter(([, value]) => value.length > 0)
    )
    if (Object.keys(stringData).length === 0) {
      setError('Provide at least one API key.')
      return
    }
    // Slot-aware validation (spec R4.5.3): reject a half-written Bedrock pair or
    // a malformed Vertex service-account JSON before writing. control-api
    // enforces the same rules server-side.
    const slotErrors = validateLlmSecretData(stringData)
    if (slotErrors.length > 0) {
      setError(slotErrors[0])
      return
    }

    setSaving(true)
    setError('')
    try {
      await apiSend('POST', '/api/v1/admin/secrets', {
        name: secretName,
        labels: {
          [HOST_SECRET_LABEL_KEY]: HOST_SECRET_LABEL_VALUE,
        },
        stringData,
      })
      showToast(`Secret ${secretName} created.`, { tone: 'success' })
      router.push(secretsListPath)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to create secret')
    } finally {
      setSaving(false)
    }
  }

  async function saveMcpSecretResource() {
    const secretName = mcpName.trim()
    if (!secretName) {
      setError('Secret name is required.')
      return
    }
    if (!MCP_SECRET_NAME_PATTERN.test(secretName) || secretName.length > 253) {
      setError(
        'Secret name must be lowercase alphanumeric and hyphens, and must start/end with an alphanumeric character.'
      )
      return
    }
    const data = Object.fromEntries(
      mcpRows
        .map(row => [row.secretKey.trim(), row.value.trim()])
        .filter(([secretKey, value]) => secretKey.length > 0 && value.length > 0)
    )
    if (Object.keys(data).length === 0) {
      setError('Provide at least one key and value.')
      return
    }

    setSaving(true)
    setError('')
    try {
      await createMcpSecret(secretName, data)
      showToast(`Secret ${secretName} created.`, { tone: 'success' })
      router.push(secretsListPath)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to create secret')
    } finally {
      setSaving(false)
    }
  }

  function addMcpDraftRow() {
    const nextId = mcpNextRowId.current
    mcpNextRowId.current += 1
    setMcpRows(current => [...current, createSecretDraftRow(`mcp-secret-row-${nextId}`)])
  }

  function removeMcpDraftRow(index: number) {
    setMcpRows(current => current.filter((_, itemIndex) => itemIndex !== index))
  }

  function updateMcpDraftRow(index: number, field: 'secretKey' | 'value', value: string) {
    setMcpRows(current =>
      current.map((row, itemIndex) => (itemIndex === index ? { ...row, [field]: value } : row))
    )
  }

  async function saveRecipeSecretResource() {
    const secretName = recipeName.trim()
    if (!secretName) {
      setError('Secret name is required.')
      return
    }
    if (!MCP_SECRET_NAME_PATTERN.test(secretName) || secretName.length > 253) {
      setError(
        'Secret name must be lowercase alphanumeric and hyphens, and must start/end with an alphanumeric character.'
      )
      return
    }
    const data = Object.fromEntries(
      recipeRows
        .map(row => [row.secretKey.trim(), row.value.trim()])
        .filter(([secretKey, value]) => secretKey.length > 0 && value.length > 0)
    )
    if (Object.keys(data).length === 0) {
      setError('Provide at least one key and value.')
      return
    }

    const ownership: Exclude<RecipeSecretOwnership, { kind: 'unlabeled' }> =
      recipeOwnershipKind === 'shared'
        ? { kind: 'shared' }
        : { kind: 'owner-recipe', recipeName: recipeOwnerName.trim() }
    if (ownership.kind === 'owner-recipe' && !ownership.recipeName) {
      setError('Owner recipe is required when ownership is "Owned by recipe".')
      return
    }

    setSaving(true)
    setError('')
    try {
      await createRecipeSecret(secretName, data, ownership, prefillRecipeNamespace)
      showToast(`Secret ${secretName} created.`, { tone: 'success' })
      router.push(secretsListPath)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to create secret')
    } finally {
      setSaving(false)
    }
  }

  function addRecipeDraftRow() {
    const nextId = recipeNextRowId.current
    recipeNextRowId.current += 1
    setRecipeRows(current => [...current, createSecretDraftRow(`recipe-secret-row-${nextId}`)])
  }

  function removeRecipeDraftRow(index: number) {
    setRecipeRows(current => current.filter((_, itemIndex) => itemIndex !== index))
  }

  function updateRecipeDraftRow(index: number, field: 'secretKey' | 'value', value: string) {
    setRecipeRows(current =>
      current.map((row, itemIndex) => (itemIndex === index ? { ...row, [field]: value } : row))
    )
  }

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CreateFlowPanel
          header={
            <CreatePageHeader
              icon={<IconKey />}
              title={
                scope === 'llm'
                  ? 'Create LLM secret'
                  : scope === 'mcp'
                    ? 'Create connector secret'
                    : 'Create recipe secret'
              }
              subtitle={
                scope === 'llm'
                  ? 'Store provider credentials for agent host secrets.'
                  : scope === 'mcp'
                    ? 'Create a Kubernetes secret for connector credential injection.'
                    : `Create a Kubernetes secret in ${prefillRecipeNamespace || 'sandbox-recipes'} for recipe credential injection.`
              }
              backLabel="Back to secrets"
              onBack={() => router.push(secretsListPath)}
              backDisabled={saving}
            />
          }
        >
          <form onSubmit={handleSubmit}>
            <CreateStepFlow
              ariaLabel="Create secret steps"
              className="cu-create-step-flow--2"
              currentStep={step}
              onStepChange={setStep}
              canSelectStep={canSelectStep}
              steps={STEP_DETAILS}
              stepLabels={STEPS}
              titleId="create-secret-step-title"
            >
              {step === 0 && scope === 'llm' ? (
                <div className="cu-form-stack cu-agent-form-stack">
                  <Field htmlFor="llm-secret-name" label="Secret name" required>
                    <TextInput
                      id="llm-secret-name"
                      value={llmName}
                      onChange={event => setLlmName(event.target.value)}
                      placeholder="secret-name"
                      disabled={saving}
                      autoFocus
                    />
                  </Field>
                </div>
              ) : null}

              {step === 1 && scope === 'llm' ? (
                <div className="cu-form-stack cu-agent-form-stack cu-agent-form-stack--wide">
                  <LlmCredentialFields
                    draft={llmKeyDraft}
                    onChange={(dataKey, value) =>
                      setLlmKeyDraft(prev => ({ ...prev, [dataKey]: value }))
                    }
                    disabled={saving}
                  />
                </div>
              ) : null}

              {step === 0 && scope === 'mcp' ? (
                <div className="cu-form-stack cu-agent-form-stack">
                  <Field
                    description="Kubernetes resource name: lowercase alphanumeric and hyphens, max 253 chars."
                    error={
                      activeNameInvalid
                        ? 'Name must match the Kubernetes DNS name format.'
                        : undefined
                    }
                    htmlFor="mcp-secret-name"
                    label="Secret name"
                    required
                  >
                    <TextInput
                      id="mcp-secret-name"
                      invalid={activeNameInvalid}
                      monospace
                      value={mcpName}
                      onChange={event => setMcpName(event.target.value)}
                      placeholder="airtable-credentials"
                      disabled={saving}
                      autoFocus
                    />
                  </Field>
                </div>
              ) : null}

              {step === 1 && scope === 'mcp' ? (
                <div className="cu-form-stack cu-agent-form-stack cu-agent-form-stack--wide">
                  <FormSection title="Secret values">
                    {mcpCredentialSchemaLoading ? (
                      <p className="cu-muted">Loading connector credential fields…</p>
                    ) : mcpCredentialSchema?.keys.length ? (
                      <div className="cu-form-stack">
                        {mcpRows.map((row, index) => (
                          <Field key={row.id} label={row.label || row.secretKey}>
                            <TextInput
                              value={row.value}
                              onChange={event =>
                                updateMcpDraftRow(index, 'value', event.target.value)
                              }
                              placeholder={row.label || 'Credential value'}
                              type="password"
                              autoComplete="off"
                              disabled={saving}
                            />
                          </Field>
                        ))}
                      </div>
                    ) : (
                      <>
                        <div className="cu-form-grid">
                          {mcpRows.map((row, index) => (
                            <div className="cu-form-inline" key={row.id}>
                              <TextInput
                                monospace
                                value={row.secretKey}
                                onChange={event =>
                                  updateMcpDraftRow(index, 'secretKey', event.target.value)
                                }
                                placeholder="API_KEY"
                                disabled={saving}
                              />
                              <TextInput
                                monospace
                                value={row.value}
                                onChange={event =>
                                  updateMcpDraftRow(index, 'value', event.target.value)
                                }
                                placeholder="secret value"
                                type="password"
                                autoComplete="off"
                                disabled={saving}
                              />
                              <button
                                type="button"
                                className="cu-btn cu-btn--icon cu-btn--danger-icon"
                                onClick={() => removeMcpDraftRow(index)}
                                disabled={saving || mcpRows.length === 1}
                                aria-label={`Remove MCP secret key row ${index + 1}`}
                                title={`Remove MCP secret key row ${index + 1}`}
                              >
                                <IconX width={16} height={16} />
                              </button>
                            </div>
                          ))}
                        </div>

                        <Button type="button" size="sm" onClick={addMcpDraftRow} disabled={saving}>
                          Add key
                        </Button>
                      </>
                    )}
                  </FormSection>
                </div>
              ) : null}

              {step === 0 && scope === 'recipe' ? (
                <div className="cu-form-stack cu-agent-form-stack">
                  <Field
                    description="Kubernetes resource name: lowercase alphanumeric and hyphens, max 253 chars."
                    error={
                      activeNameInvalid
                        ? 'Name must match the Kubernetes DNS name format.'
                        : undefined
                    }
                    htmlFor="recipe-secret-name"
                    label="Secret name"
                    required
                  >
                    <TextInput
                      id="recipe-secret-name"
                      invalid={activeNameInvalid}
                      monospace
                      value={recipeName}
                      onChange={event => setRecipeName(event.target.value)}
                      placeholder="my-recipe-credentials"
                      disabled={saving}
                      autoFocus
                    />
                  </Field>

                  <div className="cu-banner cu-banner--info">
                    This secret will be created in{' '}
                    <code>{prefillRecipeNamespace || 'sandbox-recipes'}</code>, matching the
                    namespace where the recipe workload will read it.
                  </div>

                  <FormSection title="Ownership">
                    <div className="cu-form-grid">
                      <label className="cu-form-inline">
                        <input
                          type="radio"
                          name="recipe-secret-ownership"
                          value="owner-recipe"
                          checked={recipeOwnershipKind === 'owner-recipe'}
                          onChange={() => setRecipeOwnershipKind('owner-recipe')}
                          disabled={saving}
                        />
                        <span>Owned by a specific recipe (only that recipe can read it)</span>
                      </label>
                      {recipeOwnershipKind === 'owner-recipe' ? (
                        availableRecipes.length > 0 ? (
                          <SelectInput
                            value={recipeOwnerName}
                            onChange={event => setRecipeOwnerName(event.target.value)}
                            disabled={saving}
                            aria-label="Owner recipe"
                          >
                            <option value="">-- select a recipe --</option>
                            {availableRecipes.map(name => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </SelectInput>
                        ) : (
                          <TextInput
                            value={recipeOwnerName}
                            onChange={event => setRecipeOwnerName(event.target.value)}
                            placeholder="recipe-name"
                            disabled={saving}
                            aria-label="Owner recipe name"
                          />
                        )
                      ) : null}
                      <label className="cu-form-inline">
                        <input
                          type="radio"
                          name="recipe-secret-ownership"
                          value="shared"
                          checked={recipeOwnershipKind === 'shared'}
                          onChange={() => setRecipeOwnershipKind('shared')}
                          disabled={saving}
                        />
                        <span>
                          Shared across all recipes (e.g. one Anthropic key reused by many)
                        </span>
                      </label>
                    </div>
                  </FormSection>
                </div>
              ) : null}

              {step === 1 && scope === 'recipe' ? (
                <div className="cu-form-stack cu-agent-form-stack cu-agent-form-stack--wide">
                  <FormSection title="Secret values">
                    <div className="cu-form-grid">
                      {recipeRows.map((row, index) => (
                        <div className="cu-form-inline" key={row.id}>
                          <TextInput
                            monospace
                            value={row.secretKey}
                            onChange={event =>
                              updateRecipeDraftRow(index, 'secretKey', event.target.value)
                            }
                            placeholder="API_KEY"
                            disabled={saving}
                          />
                          <TextInput
                            monospace
                            value={row.value}
                            onChange={event =>
                              updateRecipeDraftRow(index, 'value', event.target.value)
                            }
                            placeholder="secret value"
                            type="password"
                            autoComplete="off"
                            disabled={saving}
                          />
                          <button
                            type="button"
                            className="cu-btn cu-btn--icon cu-btn--danger-icon"
                            onClick={() => removeRecipeDraftRow(index)}
                            disabled={saving || recipeRows.length === 1}
                            aria-label={`Remove recipe secret key row ${index + 1}`}
                            title={`Remove recipe secret key row ${index + 1}`}
                          >
                            <IconX width={16} height={16} />
                          </button>
                        </div>
                      ))}
                    </div>

                    <Button type="button" size="sm" onClick={addRecipeDraftRow} disabled={saving}>
                      Add key
                    </Button>
                  </FormSection>
                </div>
              ) : null}

              {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

              <div className="cu-create-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => (step === 0 ? router.push(secretsListPath) : setStep(step - 1))}
                  disabled={saving}
                >
                  {step === 0 ? 'Cancel' : 'Back'}
                </Button>
                {step < STEPS.length - 1 ? (
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    disabled={saving || !canContinue}
                  >
                    Continue
                  </Button>
                ) : (
                  <Button type="submit" variant="primary" size="sm" disabled={!currentCanSubmit}>
                    {saving ? 'Saving…' : 'Create secret'}
                  </Button>
                )}
              </div>
            </CreateStepFlow>
          </form>
        </CreateFlowPanel>
      </DashboardLayout>
    </AuthGate>
  )
}

export default function CreateSecretPage() {
  const router = useRouter()

  return (
    <Suspense
      fallback={
        <AuthGate>
          <DashboardLayout isDetailPage>
            <CreateFlowSkeleton
              {...CREATE_FLOW_LOADING.createSecret}
              onBack={() => router.push(CONTROL_ROUTES.secrets.root)}
              backDisabled={false}
            />
          </DashboardLayout>
        </AuthGate>
      }
    >
      <CreateSecretPageContent />
    </Suspense>
  )
}
