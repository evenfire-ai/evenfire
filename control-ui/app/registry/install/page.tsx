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
import { RegistryInstallForm } from '@components/RegistryInstallForm'
import { IconStore } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { CREATE_FLOW_LOADING } from '@constants/createFlowLoading'
import { CONTROL_ROUTES } from '@constants/routes'
import { DEFAULT_WORKFLOW_RECIPE_NAMESPACE } from '@constants/workflowRecipes'
import { getRegistryEntryVersion, installRecipeFromRegistry } from '@lib/api'
import type { RegistryEntry } from '@lib/api'
import { analyzeWorkflowRecipeEgress } from '@lib/egressModel'
import type { EgressBinding, EgressEditorStatus } from '@lib/egressModel'
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
  const canInstall =
    recipeText.length > 0 &&
    !parseResult.error &&
    validationErrors.length === 0 &&
    egressErrors.length === 0 &&
    !egressEditError &&
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
      const result = await installRecipeFromRegistry({
        registryEntryName: entry.name,
        registryEntryVersion: entry.version,
        recipeManifest: recipeText,
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
                  <strong>
                    {entry.name} v{entry.version}
                  </strong>
                  <p className="cu-muted" style={{ margin: '6px 0 0' }}>
                    {entry.description}
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="cu-form-stack cu-agent-form-stack cu-agent-form-stack--wide">
            {validationErrors.length > 0 ? (
              <div className="cu-banner cu-banner--error" role="alert">
                This Marketplace recipe cannot be installed until its manifest validates.
                <ul style={{ margin: '6px 0 0 18px' }}>
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
                    <div style={{ marginTop: 4 }}>
                      Bindings: {finding.bindingCount}. Mode: {finding.mode}.
                    </div>
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
                title="Install from Marketplace"
                subtitle="Install a Marketplace entry into your cluster and bind it to a context."
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
            ) : entry ? (
              <RegistryInstallForm
                entry={entry}
                onCancel={() => router.push(CONTROL_ROUTES.marketplace.root)}
                onInstalled={() => router.push(CONTROL_ROUTES.marketplace.root)}
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
