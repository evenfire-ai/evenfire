'use client'

import React, { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { parse as parseYaml } from 'yaml'
import { AuthGate } from '@components/AuthGate'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreateFlowSkeleton } from '@components/CreateFlowSkeleton'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { DashboardLayout } from '@components/DashboardLayout'
import { EgressEditor } from '@components/EgressEditor'
import { HookInstallForm } from '@components/HookInstallForm'
import { RegistryInstallForm } from '@components/RegistryInstallForm'
import { IconStore } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { SelectInput } from '@components/ui'
import { CREATE_FLOW_LOADING } from '@constants/createFlowLoading'
import { CONTROL_ROUTES } from '@constants/routes'
import { DEFAULT_WORKFLOW_RECIPE_NAMESPACE } from '@constants/workflowRecipes'
import { getRegistryEntryVersion, installRecipeFromRegistry } from '@lib/api'
import type { LlmAllowedModel, RegistryEntry } from '@lib/api'
import { analyzeWorkflowRecipeEgress } from '@lib/egressModel'
import type { EgressBinding, EgressEditorStatus } from '@lib/egressModel'
import { useLlmAllowedModels } from '@lib/hooks/useLlmAllowedModels'
import { validateRecipe } from '@lib/recipeValidator'

type TransportWorkloadEditorTarget = {
  index: number
  id: string
  bindings?: EgressBinding[]
}

const RECIPE_INSTALL_STEPS = ['Package', 'Security', 'Install'] as const

const RECIPE_INSTALL_STEP_DETAILS = [
  {
    description: 'Review recipe package',
    title: 'Marketplace recipe',
    subtitle: 'Review the recipe package and manifest before installation.',
  },
  {
    description: 'Validate and edit egress',
    title: 'Security review',
    subtitle: 'Resolve manifest validation and external egress requirements.',
  },
  {
    description: 'Confirm install',
    title: 'Install plugin',
    subtitle: 'Check the final manifest and install the WorkflowRecipe.',
  },
] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRegistryRecipeText(recipeText: string): {
  parsed: Record<string, unknown> | null
  error: string
} {
  if (!recipeText.trim()) return { parsed: null, error: 'Marketplace recipe content is empty' }
  try {
    const parsed = JSON.parse(recipeText) as unknown
    if (!isPlainObject(parsed)) return { parsed: null, error: 'Recipe content must be an object' }
    return { parsed, error: '' }
  } catch {
    try {
      const parsed = parseYaml(recipeText) as unknown
      if (!isPlainObject(parsed)) return { parsed: null, error: 'Recipe content must be an object' }
      return { parsed, error: '' }
    } catch (error) {
      return {
        parsed: null,
        error: `Failed to parse Marketplace recipe as YAML or JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }
  }
}

function workflowTransportWorkloads(
  parsed: Record<string, unknown> | null
): TransportWorkloadEditorTarget[] {
  const spec = isPlainObject(parsed?.spec) ? parsed.spec : undefined
  const workloads = Array.isArray(spec?.workloads)
    ? (spec.workloads as Record<string, unknown>[])
    : []
  return workloads.flatMap((workload, index) => {
    if (!workload.transport) return []
    const id = typeof workload.id === 'string' ? workload.id : `workload-${index}`
    const bindings = Array.isArray(workload.egressBindings)
      ? (workload.egressBindings as EgressBinding[])
      : undefined
    return [{ index, id, bindings }]
  })
}

function applyWorkflowWorkloadEgress(
  parsed: Record<string, unknown>,
  workloadIndex: number,
  bindings: EgressBinding[] | undefined
): string {
  const next = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>
  if (!isPlainObject(next.spec)) throw new Error('Recipe spec must be an object')
  const spec = next.spec
  if (!Array.isArray(spec.workloads)) throw new Error('Recipe spec.workloads must be an array')
  const workload = spec.workloads[workloadIndex]
  if (!isPlainObject(workload)) throw new Error(`Workflow workload ${workloadIndex} is invalid`)
  if (bindings && bindings.length > 0) {
    workload.egressBindings = bindings
  } else {
    delete workload.egressBindings
  }
  return JSON.stringify(next, null, 2)
}

// Resolve a model's provider from the operator's authoritative model allowlist
// (useLlmAllowedModels → /admin/llm-models) — the single source of the exact
// model→provider mapping. Returns '' when the model isn't in the catalog so the
// user picks a provider explicitly instead of being handed a wrong guess; this
// follows the "no hardcoded fallback" rule the rest of the LLM UI uses
// (lib/llm.ts, spec R4.5.1). A string heuristic mis-derived roughly half the
// providers (e.g. groq/cerebras/moonshot/perplexity/bailian models → openai).
export function providerForModel(model: string, catalog: LlmAllowedModel[]): string {
  return catalog.find(row => row.model === model)?.provider ?? ''
}

// Distinct providers the operator has enabled, for the override dropdown. Keeps
// the picker honest — only providers with configured credentials are offered,
// instead of a static enum of all 22.
export function enabledProviders(catalog: LlmAllowedModel[]): string[] {
  const seen = new Set<string>()
  for (const row of catalog) {
    if (row.enabled) seen.add(row.provider)
  }
  return Array.from(seen).sort()
}

// A recipe whose plugin SDK enables promptBridge must resolve an agent
// (spec.agent or a step agent with provider + model) or it fails after install.
// Exported for direct unit coverage of the agent-resolution rule.
export function recipeAgentRequirement(parsed: Record<string, unknown> | null): {
  needsAgent: boolean
  allowedModels: string[]
} {
  if (!isPlainObject(parsed) || !isPlainObject(parsed.spec)) {
    return { needsAgent: false, allowedModels: [] }
  }
  const spec = parsed.spec
  const sdk = isPlainObject(spec.pluginWorkloadSdk) ? spec.pluginWorkloadSdk : null
  const promptBridge = sdk && isPlainObject(sdk.promptBridge) ? sdk.promptBridge : null
  if (!promptBridge) return { needsAgent: false, allowedModels: [] }
  const agent = isPlainObject(spec.agent) ? spec.agent : null
  const hasSpecAgent =
    !!agent && typeof agent.provider === 'string' && typeof agent.model === 'string'
  // Steps live at spec.steps in the CRD (charts/clerum-crds/crds/workflowrecipe.yaml),
  // NOT spec.workflow.steps (no such property). Mirror the canonical resolver in
  // workflow-recipes/src/workflow/agentResolution.ts (resolveMcpHostAgent) so this
  // wizard check can't drift from the reconciler and silently override a step agent.
  const steps = Array.isArray(spec.steps) ? spec.steps : []
  const hasStepAgent = steps.some(
    s =>
      isPlainObject(s) &&
      isPlainObject(s.agent) &&
      typeof s.agent.provider === 'string' &&
      typeof s.agent.model === 'string'
  )
  const allowedModels = Array.isArray(promptBridge.allowedModels)
    ? promptBridge.allowedModels.filter((m): m is string => typeof m === 'string')
    : []
  return { needsAgent: !(hasSpecAgent || hasStepAgent), allowedModels }
}

// Inject spec.agent into the parsed recipe, returning the JSON manifest (same
// serialization the egress editor uses).
function applyRecipeAgent(
  parsed: Record<string, unknown>,
  provider: string,
  model: string
): string {
  const next = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>
  if (!isPlainObject(next.spec)) throw new Error('Recipe spec must be an object')
  next.spec.agent = { provider, model }
  return JSON.stringify(next, null, 2)
}

function RegistryRecipeInstallPreview({
  entry,
  onCancel,
  onInstalled,
}: {
  entry: RegistryEntry
  onCancel: () => void
  onInstalled: (recipeName: string) => void
}) {
  const { showToast } = useToast()
  const [step, setStep] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [egressEditError, setEgressEditError] = useState('')
  const [recipeText, setRecipeText] = useState(
    typeof entry.recipe_meta?.recipeYaml === 'string' ? entry.recipe_meta.recipeYaml : ''
  )
  // Agent to inject when the recipe's promptBridge needs one (provider + model).
  const [agentModel, setAgentModel] = useState('')
  const [agentProvider, setAgentProvider] = useState('')
  // Operator-declared model allowlist (/admin/llm-models): the authoritative
  // model→provider map and the set of providers enabled in this deployment.
  const { models: llmCatalog } = useLlmAllowedModels()
  const catalogKey = llmCatalog.map(r => `${r.provider}:${r.model}:${r.enabled}`).join('\n')

  useEffect(() => {
    setRecipeText(
      typeof entry.recipe_meta?.recipeYaml === 'string' ? entry.recipe_meta.recipeYaml : ''
    )
    setEgressEditError('')
    setSubmitError('')
  }, [entry])

  const parseResult = useMemo(() => parseRegistryRecipeText(recipeText), [recipeText])
  const validation = useMemo(
    () => (parseResult.parsed ? validateRecipe(JSON.stringify(parseResult.parsed, null, 2)) : null),
    [parseResult.parsed]
  )
  const parsedRecipe = validation?.parsed ?? parseResult.parsed
  const agentReq = useMemo(
    () => recipeAgentRequirement((parsedRecipe as Record<string, unknown> | null) ?? null),
    [parsedRecipe]
  )
  const allowedModelsKey = agentReq.allowedModels.join('\n')
  useEffect(() => {
    if (agentReq.needsAgent && agentReq.allowedModels.length > 0) {
      const first = agentReq.allowedModels[0]
      setAgentModel(first)
      setAgentProvider(providerForModel(first, llmCatalog))
    } else {
      setAgentModel('')
      setAgentProvider('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentReq.needsAgent, allowedModelsKey, catalogKey])
  const agentProviderOptions = useMemo(() => {
    const opts = enabledProviders(llmCatalog)
    // Keep the derived/selected provider selectable even if the operator has not
    // enabled it yet, so the value is never silently dropped from the picker.
    return agentProvider && !opts.includes(agentProvider) ? [agentProvider, ...opts] : opts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogKey, agentProvider])
  const transportEgressTargets = useMemo(
    () => workflowTransportWorkloads(parsedRecipe as Record<string, unknown> | null),
    [parsedRecipe]
  )
  const egressFindings = useMemo(
    () => (parsedRecipe ? analyzeWorkflowRecipeEgress(parsedRecipe) : []),
    [parsedRecipe]
  )
  const validationErrors = parsedRecipe
    ? (validation?.issues.filter(issue => issue.severity === 'error') ?? [])
    : []
  const egressErrors = egressFindings.filter(finding => finding.severity === 'error')
  // A promptBridge recipe must resolve an agent before install, or it fails
  // after install. When the recipe's allowedModels[0] is not in the operator
  // catalog, providerForModel() returns '' and no spec.agent is injected — so
  // block the submit until a provider + model are actually chosen.
  const agentReady = !agentReq.needsAgent || (Boolean(agentProvider) && Boolean(agentModel))
  const canInstall =
    recipeText.length > 0 &&
    !parseResult.error &&
    validationErrors.length === 0 &&
    egressErrors.length === 0 &&
    !egressEditError &&
    agentReady &&
    !submitting
  const canContinue = step === 0 ? Boolean(recipeText.trim()) && !parseResult.error : canInstall

  function canSelectStep(targetStep: number) {
    if (targetStep <= step) return true
    if (targetStep === 1) return Boolean(recipeText.trim()) && !parseResult.error
    return canInstall
  }

  function updateWorkflowEgress(
    target: TransportWorkloadEditorTarget,
    bindings: EgressBinding[] | undefined
  ) {
    if (!parsedRecipe || !isPlainObject(parsedRecipe)) return
    try {
      setRecipeText(applyWorkflowWorkloadEgress(parsedRecipe, target.index, bindings))
      setEgressEditError('')
    } catch (error) {
      setEgressEditError(error instanceof Error ? error.message : 'Failed to update egress')
    }
  }

  async function handleInstall() {
    if (!canInstall) return
    setSubmitting(true)
    setSubmitError('')
    try {
      // Inject the chosen agent when the recipe's promptBridge requires one.
      const manifest =
        agentReq.needsAgent && agentProvider && agentModel && isPlainObject(parsedRecipe)
          ? applyRecipeAgent(parsedRecipe, agentProvider, agentModel)
          : recipeText
      const result = await installRecipeFromRegistry({
        registryEntryName: entry.name,
        registryEntryVersion: entry.version,
        recipeManifest: manifest,
      })
      showToast(`Installed ${entry.name} v${entry.version}.`, { tone: 'success' })
      onInstalled(result.recipeName)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to install recipe')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <CreateStepFlow
        ariaLabel="Install plugin steps"
        className="cu-create-step-flow--3"
        currentStep={step}
        onStepChange={setStep}
        canSelectStep={canSelectStep}
        steps={RECIPE_INSTALL_STEP_DETAILS}
        stepLabels={RECIPE_INSTALL_STEPS}
        titleId="registry-recipe-install-step-title"
        showHeader={false}
      >
        {step === 0 ? (
          <div className="cu-form-stack cu-agent-form-stack cu-agent-form-stack--wide">
            <div className="cu-form-section">
              <div className="cu-form-section__header">
                <h3 className="cu-form-section__title">Marketplace recipe</h3>
                <p className="cu-form-section__description">
                  Review the recipe package and manifest before installation.
                </p>
              </div>

              <div className="cu-card">
                <div className="cu-card__body">
                  <div className="cu-table-actions cu-registry-install-entry-heading">
                    <strong>
                      {entry.name} v{entry.version}
                    </strong>
                    {entry.visibility ? (
                      <span
                        className={`cu-registry-chip cu-registry-chip--visibility-${entry.visibility}`}
                      >
                        {entry.visibility === 'private' ? 'Private' : 'Public'}
                      </span>
                    ) : null}
                  </div>
                  <p className="cu-muted cu-registry-install-entry-description">
                    {entry.description}
                  </p>
                </div>
              </div>
            </div>

            {agentReq.needsAgent ? (
              <div className="cu-form-section">
                <div className="cu-form-section__header">
                  <h3 className="cu-form-section__title">Agent</h3>
                  <p className="cu-form-section__description">
                    This plugin uses the prompt bridge, so it needs an LLM agent (provider + model).
                  </p>
                </div>
                <p className="cu-banner cu-banner--warn" role="status">
                  Pick an agent for this plugin — without one it will fail after install.
                </p>
                <div className="cu-field">
                  <label htmlFor="install-agent-model">Model</label>
                  <SelectInput
                    id="install-agent-model"
                    value={agentModel}
                    onChange={e => {
                      const m = e.target.value
                      setAgentModel(m)
                      setAgentProvider(providerForModel(m, llmCatalog))
                    }}
                  >
                    {agentReq.allowedModels.length === 0 ? (
                      <option value="">(no models listed)</option>
                    ) : null}
                    {agentReq.allowedModels.map(m => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </SelectInput>
                </div>
                <div className="cu-field">
                  <label htmlFor="install-agent-provider">Provider</label>
                  <SelectInput
                    id="install-agent-provider"
                    value={agentProvider}
                    onChange={e => setAgentProvider(e.target.value)}
                  >
                    {agentProviderOptions.length === 0 ? (
                      <option value="">(no providers enabled)</option>
                    ) : null}
                    {agentProviderOptions.map(p => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </SelectInput>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {step === 1 ? (
          <div className="cu-form-stack cu-agent-form-stack cu-agent-form-stack--wide">
            {validationErrors.length > 0 ? (
              <div className="cu-banner cu-banner--error" role="alert">
                This Marketplace recipe cannot be installed until its manifest validates.
                <ul className="cu-registry-install-validation-list">
                  {validationErrors.slice(0, 5).map(issue => (
                    <li key={`${issue.path}-${issue.message}`}>
                      {issue.path}: {issue.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {parseResult.error ? (
              <div className="cu-banner cu-banner--error" role="alert">
                {parseResult.error}
              </div>
            ) : null}

            {transportEgressTargets.length > 0 ? (
              <div className="cu-form-section">
                <div className="cu-form-section__header">
                  <h3 className="cu-form-section__title">External Egress Editor</h3>
                  <p className="cu-form-section__description">
                    Adjust transport workload egress before the recipe CRD is created.
                  </p>
                </div>
                {transportEgressTargets.map(target => (
                  <EgressEditor
                    key={`${target.index}-${target.id}-${JSON.stringify(target.bindings ?? [])}`}
                    initialBindings={target.bindings}
                    emitInitial={false}
                    title={`Transport workload "${target.id}"`}
                    description="This writes spec.workloads[].egressBindings into the manifest that will be installed."
                    onChange={(
                      bindings: EgressBinding[] | undefined,
                      status: EgressEditorStatus
                    ) => {
                      if (status.errors.length > 0) {
                        setEgressEditError(status.errors[0])
                        return
                      }
                      updateWorkflowEgress(target, bindings)
                    }}
                  />
                ))}
                {egressEditError ? (
                  <div className="cu-banner cu-banner--error" role="alert">
                    {egressEditError}
                  </div>
                ) : null}
              </div>
            ) : null}

            {egressFindings.length > 0 ? (
              <div className="cu-form-section">
                <div className="cu-form-section__header">
                  <h3 className="cu-form-section__title">External Egress Review</h3>
                  <p className="cu-form-section__description">
                    Default-deny is valid, but workloads that need internet must declare exact-host
                    or public-web egress explicitly.
                  </p>
                </div>
                {egressFindings.map(finding => (
                  <div
                    key={finding.key}
                    className={
                      finding.severity === 'error'
                        ? 'cu-banner cu-banner--error'
                        : finding.severity === 'warning'
                          ? 'cu-warning-card'
                          : 'cu-banner cu-banner--info'
                    }
                    role={
                      finding.severity === 'error' || finding.severity === 'warning'
                        ? 'alert'
                        : 'status'
                    }
                  >
                    <strong>{finding.label}</strong>: {finding.message}
                    <div className="cu-registry-install-egress-detail">
                      Bindings: {finding.bindingCount}. Mode: {finding.mode}.
                    </div>
                    {finding.targets && finding.targets.length > 0 ? (
                      <div className="cu-registry-install-egress-detail">
                        Hosts: {finding.targets.join(', ')}
                        {finding.ports && finding.ports.length > 0
                          ? ` · Ports: ${finding.ports.join(', ')}`
                          : ''}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : !parseResult.error ? (
              <div className="cu-banner cu-banner--info" role="status">
                No external egress declarations were found. The installed recipe remains closed to
                public internet by default unless its runtime paths declare egress elsewhere.
              </div>
            ) : null}
          </div>
        ) : null}

        {step === 2 ? (
          <div className="cu-form-stack cu-agent-form-stack">
            <div className="cu-agent-review">
              Recipe <b>{entry.name}</b> v{entry.version} will be installed from the reviewed
              Marketplace manifest.
            </div>
          </div>
        ) : null}

        {submitError ? (
          <div className="cu-banner cu-banner--error" role="alert">
            {submitError}
          </div>
        ) : null}

        <div className="cu-create-actions">
          <button
            className="cu-btn cu-btn--ghost cu-btn--sm"
            disabled={submitting}
            onClick={() => (step === 0 ? onCancel() : setStep(current => current - 1))}
            type="button"
          >
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {step < RECIPE_INSTALL_STEPS.length - 1 ? (
            <button
              className="cu-btn cu-btn--primary cu-btn--sm"
              disabled={!canContinue}
              onClick={() =>
                setStep(current => Math.min(RECIPE_INSTALL_STEPS.length - 1, current + 1))
              }
              type="button"
            >
              Continue
            </button>
          ) : (
            <button
              className="cu-btn cu-btn--primary cu-btn--sm"
              disabled={!canInstall}
              onClick={handleInstall}
              type="button"
            >
              {submitting ? 'Installing...' : 'Install plugin'}
            </button>
          )}
        </div>
      </CreateStepFlow>
    </>
  )
}

function RegistryInstallPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const entryName = useMemo(() => searchParams.get('entry')?.trim() ?? '', [searchParams])
  const entryVersion = useMemo(() => searchParams.get('version')?.trim() ?? '', [searchParams])

  const [entry, setEntry] = useState<RegistryEntry | null>(null)
  const [loadingEntry, setLoadingEntry] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    async function loadEntry() {
      setLoadingEntry(true)
      setError('')
      try {
        const match = await getRegistryEntryVersion(entryName, entryVersion)
        setEntry(match)
      } catch (loadError) {
        setError(
          loadError instanceof Error ? loadError.message : 'Failed to load Marketplace entry'
        )
        setEntry(null)
      } finally {
        setLoadingEntry(false)
      }
    }

    if (!entryName || !entryVersion) {
      setEntry(null)
      setLoadingEntry(false)
      setError(
        'Missing Marketplace entry identifiers. Return to Marketplace and retry installation.'
      )
      return
    }
    void loadEntry()
  }, [entryName, entryVersion])

  const isPrivate = entry?.visibility === 'private'
  const kindLabel =
    entry?.entry_type === 'recipe'
      ? 'plugin'
      : entry?.entry_type === 'llm-hook'
        ? 'guardrail hook'
        : 'connector'
  // Scoped names are stored as `@org/name`; surface the org for a private entry.
  const orgScope = entry ? (entry.name.match(/^(@[^/]+)\//)?.[1] ?? null) : null
  const headerTitle = isPrivate ? `Install a private ${kindLabel}` : 'Install from Marketplace'
  const headerSubtitle = isPrivate
    ? `Install ${entry?.name}, a private ${kindLabel} from your organization${
        orgScope ? ` ${orgScope}` : ''
      }, into your cluster.`
    : 'Install a Marketplace entry into your cluster.'

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        {loadingEntry ? (
          <CreateFlowSkeleton
            {...CREATE_FLOW_LOADING.installRegistryEntry}
            onBack={() => router.push(CONTROL_ROUTES.marketplace.root)}
            backDisabled={false}
          />
        ) : (
          <CreateFlowPanel
            header={
              <CreatePageHeader
                icon={<IconStore />}
                title={headerTitle}
                subtitle={headerSubtitle}
                backLabel="Back to Marketplace"
                onBack={() => router.push(CONTROL_ROUTES.marketplace.root)}
              />
            }
          >
            {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
            {entry?.entry_type === 'recipe' ? (
              <RegistryRecipeInstallPreview
                entry={entry}
                onCancel={() => router.push(CONTROL_ROUTES.marketplace.root)}
                onInstalled={recipeName =>
                  router.push(
                    CONTROL_ROUTES.plugins.detail(DEFAULT_WORKFLOW_RECIPE_NAMESPACE, recipeName)
                  )
                }
              />
            ) : entry?.entry_type === 'llm-hook' ? (
              <HookInstallForm
                entry={entry}
                onCancel={() => router.push(CONTROL_ROUTES.marketplace.root)}
                onInstalled={() => router.push(CONTROL_ROUTES.guardrails.root)}
              />
            ) : entry ? (
              <RegistryInstallForm
                entry={entry}
                onCancel={() => router.push(CONTROL_ROUTES.marketplace.root)}
                onInstalled={() => undefined}
                onViewConnectors={() => router.push(CONTROL_ROUTES.connectors.root)}
              />
            ) : null}
          </CreateFlowPanel>
        )}
      </DashboardLayout>
    </AuthGate>
  )
}

export default function RegistryInstallPage() {
  const router = useRouter()
  return (
    <Suspense
      fallback={
        <AuthGate>
          <DashboardLayout isDetailPage>
            <CreateFlowSkeleton
              {...CREATE_FLOW_LOADING.installRegistryEntry}
              onBack={() => router.push(CONTROL_ROUTES.marketplace.root)}
              backDisabled={false}
            />
          </DashboardLayout>
        </AuthGate>
      }
    >
      <RegistryInstallPageContent />
    </Suspense>
  )
}
