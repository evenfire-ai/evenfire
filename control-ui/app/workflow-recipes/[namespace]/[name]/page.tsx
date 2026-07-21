'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { CreateFlowSkeleton } from '@components/CreateFlowSkeleton'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { DetailPageShell } from '@components/DetailPageShell'
import { LoadingScreen } from '@components/LoadingScreen'
import { RecipeEditor } from '@components/RecipeEditor'
import { RecipeIntegrationsPanel } from '@components/RecipeIntegrationsPanel'
import { RecipeSecretsPanel } from '@components/RecipeSecretsPanel'
import { GrantsReadonlyPanel, RecipeStatusContent } from '@components/RecipeStatusContent'
import { IconWorkflow } from '@components/Sidebar/icons'
import { SkeletonTableRows } from '@components/SkeletonTableRows'
import { TableHeaderRow } from '@components/TableHeaderRow'
import type { TableHeaderColumn } from '@components/TableHeaderRow/types'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { useToast } from '@components/Toast'
import { WorkflowRunModal } from '@components/WorkflowRunModal'
import type { InputContractProperties } from '@components/WorkflowRunModal/types'
import { CREATE_FLOW_LOADING } from '@constants/createFlowLoading'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  WORKFLOW_RECIPE_DEFAULT_DETAIL_TAB,
  WORKFLOW_RECIPE_DETAIL_TABS,
  type WorkflowRecipeDetailTab,
} from '@constants/workflowRecipeDetails'
import { DEFAULT_WORKFLOW_RECIPE_NAMESPACE } from '@constants/workflowRecipes'
import {
  deleteRecipe,
  getRecipe,
  getRecipePods,
  getRecipeStatus,
  getWorkflowRuns,
  retryRecipe,
} from '@lib/api'
import type {
  RecipePod,
  WorkflowRecipeResource,
  WorkflowRecipeStatus,
  WorkflowRunSummary,
} from '@lib/api'
import {
  RECIPE_STATUS_LOADING_REASON,
  getRecipeRunDisabledReason,
  getVisibleWorkflowRuns,
  isRecipeReadyToRun,
  isWorkflowExecutionLive,
  shouldPollWorkflowRecipe,
  workflowOnDemandRequiresApproval,
} from '@lib/workflowRecipeRunState'

const RUNS_COLUMNS: TableHeaderColumn[] = [
  { key: 'runId', label: 'Run' },
  { key: 'phase', label: 'Phase' },
  { key: 'triggeredAt', label: 'Triggered' },
  { key: 'startedAt', label: 'Started' },
  { key: 'completedAt', label: 'Completed' },
  { key: 'triggerer', label: 'Triggered by' },
  { key: 'arrow', label: '' },
]

const STATUS_POLL_MS = 5000

function extractInputs(recipe: WorkflowRecipeResource | null): InputContractProperties | undefined {
  const spec = recipe?.spec
  if (!spec || typeof spec !== 'object') return undefined
  const contract = (spec as { inputContract?: unknown }).inputContract
  if (!contract || typeof contract !== 'object') return undefined
  const properties = (contract as { properties?: unknown }).properties
  if (!properties || typeof properties !== 'object') return undefined
  return properties as InputContractProperties
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function formatTriggerer(run: WorkflowRunSummary): string {
  if (run.actor?.userId) return `user ${run.actor.userId.slice(0, 8)}`
  if (run.actor?.hostRef) return `host ${run.actor.hostRef}`
  if (run.actor?.type) return run.actor.type
  const t = run.triggerer
  if (!t) return '—'
  if (t.userId) return `user ${t.userId.slice(0, 8)}`
  if (t.hostRef) return `host ${t.hostRef}`
  if (t.kind) return t.kind
  return '—'
}

type DetailTab = WorkflowRecipeDetailTab

function parseDetailTab(tabParam: string | undefined): DetailTab {
  return WORKFLOW_RECIPE_DETAIL_TABS.includes(tabParam as DetailTab)
    ? (tabParam as DetailTab)
    : WORKFLOW_RECIPE_DEFAULT_DETAIL_TAB
}

function hasBackgroundOauthClients(recipe: WorkflowRecipeResource | null): boolean {
  const spec = recipe?.spec
  if (!spec || typeof spec !== 'object') return false
  const clients = (spec as { oauthClients?: unknown }).oauthClients
  if (!Array.isArray(clients)) return false
  return clients.some(
    c =>
      c && typeof c === 'object' && (c as { backgroundAccess?: unknown }).backgroundAccess === true
  )
}

const WORKLOAD_COLUMNS: TableHeaderColumn[] = [
  { key: 'workloadId', label: 'Workload' },
  { key: 'kind', label: 'Kind' },
  { key: 'namespace', label: 'Namespace' },
  { key: 'reconcile', label: 'Reconcile' },
  { key: 'pod', label: 'Pod' },
  { key: 'restarts', label: 'Restarts' },
  { key: 'age', label: 'Age' },
  { key: 'detail', label: 'Detail' },
]

type WorkloadStatusEntry = {
  id?: string
  type?: string
  phase?: string
  ready?: boolean
  message?: string
}

type RecipeCondition = {
  type?: string
  status?: string
  reason?: string
  message?: string
  lastTransitionTime?: string
}

function extractWorkloads(status: Record<string, unknown> | null): WorkloadStatusEntry[] {
  const wls = (status?.workloads as unknown) ?? []
  if (!Array.isArray(wls)) return []
  return wls as WorkloadStatusEntry[]
}

function buildWorkloadRowIds(workloads: WorkloadStatusEntry[], pods: RecipePod[]): string[] {
  const rowIds: string[] = []
  const knownIds = new Set<string>()

  for (const workload of workloads) {
    const id = workload.id?.trim()
    if (!id || knownIds.has(id)) continue
    knownIds.add(id)
    rowIds.push(id)
  }

  for (const pod of pods) {
    const id = pod.workloadId?.trim()
    if (!id || knownIds.has(id)) continue
    knownIds.add(id)
    rowIds.push(id)
  }

  return rowIds
}

function extractConditions(status: Record<string, unknown> | null): RecipeCondition[] {
  const cs = (status?.conditions as unknown) ?? []
  if (!Array.isArray(cs)) return []
  return cs as RecipeCondition[]
}

function conditionTone(cond: RecipeCondition): 'ok' | 'warn' | 'error' | 'info' {
  // Convention: "<Thing>Missing/Failed/Invalid"-style condition types are
  // problem conditions — status:True is bad. Dormant is informational.
  const t = String(cond.type ?? '')
  const s = String(cond.status ?? '')
  if (t === 'WebhookDormant') return s === 'True' ? 'info' : 'ok'
  const isProblem =
    /Missing$|Failed$|Invalid$|NotReady$/.test(t) || /Failure|Failed|Invalid|Missing/.test(t)
  if (isProblem) return s === 'True' ? 'error' : 'ok'
  return s === 'True' ? 'ok' : 'warn'
}

function podTone(pod: RecipePod): 'ok' | 'warn' | 'error' {
  if (pod.phase === 'Running' && pod.containers.every(c => c.ready)) return 'ok'
  if (pod.phase === 'Succeeded') return 'ok'
  if (pod.phase === 'Failed') return 'error'
  if (pod.reason && /BackOff|Error|Invalid|Failed/.test(pod.reason)) return 'error'
  return 'warn'
}

function formatRelativeAge(iso: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return '—'
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 48) return `${hrs}h${mins % 60 ? ` ${mins % 60}m` : ''}`
  const days = Math.floor(hrs / 24)
  return `${days}d`
}

function chipStyle(tone: 'ok' | 'warn' | 'error' | 'info'): React.CSSProperties {
  switch (tone) {
    case 'ok':
      return {
        color: 'var(--cu-ok-text, var(--cu-text))',
        borderColor: 'var(--cu-ok-border, var(--cu-border-subtle))',
      }
    case 'warn':
      return {
        color: 'var(--cu-warn-text, var(--cu-text-soft))',
        borderColor: 'var(--cu-warn-border, var(--cu-border-subtle))',
      }
    case 'error':
      return {
        color: 'var(--cu-error)',
        borderColor: 'var(--cu-error)',
      }
    case 'info':
      return {
        color: 'var(--cu-text-soft)',
        borderColor: 'var(--cu-border-subtle)',
      }
  }
}

type KebabItem = {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}

function KebabMenu({ items, ariaLabel }: { items: KebabItem[]; ariaLabel: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function handleDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleDocClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleDocClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open])
  return (
    <div ref={ref} className="cu-kebab">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        className="cu-btn cu-btn--ghost cu-btn--sm cu-kebab__trigger"
        onClick={() => setOpen(v => !v)}
      >
        ⋯
      </button>
      {open ? (
        <div role="menu" className="cu-kebab__menu">
          {items.map(item => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={`cu-kebab__item${item.danger ? ' cu-kebab__item--danger' : ''}`}
              onClick={() => {
                setOpen(false)
                item.onClick()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export const dynamic = 'force-dynamic'

export default function WorkflowRecipeDetailPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <WorkflowRecipeDetailContent />
    </Suspense>
  )
}

function WorkflowRecipeDetailContent() {
  const router = useRouter()
  const params = useParams<{ namespace: string; name: string; tab?: string }>()
  const searchParams = useSearchParams()
  const mountedRef = useRef(true)
  const namespace = decodeURIComponent(params?.namespace ?? DEFAULT_WORKFLOW_RECIPE_NAMESPACE)
  const name = decodeURIComponent(params?.name ?? '')
  const editMode = searchParams.get('edit') === '1'
  const activeTab: DetailTab = parseDetailTab(params?.tab)

  const detailTabHref = useCallback(
    (next: DetailTab) => {
      const url = new URLSearchParams(searchParams.toString())
      url.delete('tab')
      const qs = url.toString()
      const path = CONTROL_ROUTES.plugins.tab(namespace, name, next)
      return qs ? `${path}?${qs}` : path
    },
    [name, namespace, searchParams]
  )

  const selectTab = useCallback(
    (next: DetailTab) => {
      router.replace(detailTabHref(next))
    },
    [detailTabHref, router]
  )

  const [recipe, setRecipe] = useState<WorkflowRecipeResource | null>(null)
  const [recipeStatus, setRecipeStatus] = useState<WorkflowRecipeStatus | null>(null)
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([])
  const [pods, setPods] = useState<RecipePod[]>([])
  const [loadingRecipe, setLoadingRecipe] = useState(true)
  const [loadingRuns, setLoadingRuns] = useState(true)
  const [loadingPods, setLoadingPods] = useState(true)
  const [recipeError, setRecipeError] = useState('')
  const [runsError, setRunsError] = useState('')
  const [podsError, setPodsError] = useState('')

  const [runModalOpen, setRunModalOpen] = useState(false)
  const [uninstalling, setUninstalling] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [actionError, setActionError] = useState('')
  const [editorReady, setEditorReady] = useState(false)
  const editorTimerRef = useRef<number | null>(null)
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()
  const editorRecipeKey = recipe
    ? `${recipe.metadata?.namespace ?? namespace}/${recipe.metadata?.name ?? name}`
    : ''

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!editMode || !editorRecipeKey) {
      setEditorReady(false)
      if (editorTimerRef.current !== null) {
        window.clearTimeout(editorTimerRef.current)
        editorTimerRef.current = null
      }
      return
    }

    setEditorReady(false)
    // Keep the edit skeleton visible briefly after recipe resolution so the
    // editor mounts after the route transition settles instead of flashing in.
    editorTimerRef.current = window.setTimeout(() => {
      setEditorReady(true)
      editorTimerRef.current = null
    }, 120)

    return () => {
      if (editorTimerRef.current !== null) {
        window.clearTimeout(editorTimerRef.current)
        editorTimerRef.current = null
      }
    }
  }, [editMode, editorRecipeKey])

  const loadRecipe = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLoadingRecipe(true)
        setRecipeError('')
      }
      try {
        const [resource, status] = await Promise.all([getRecipe(name), getRecipeStatus(name)])
        if (!mountedRef.current) return
        setRecipe(resource as WorkflowRecipeResource)
        setRecipeStatus(status)
      } catch (err) {
        if (!mountedRef.current) return
        if (!silent) {
          setRecipeError(err instanceof Error ? err.message : 'Failed to load recipe')
        }
      } finally {
        if (mountedRef.current && !silent) setLoadingRecipe(false)
      }
    },
    [name]
  )

  const loadRuns = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLoadingRuns(true)
        setRunsError('')
      }
      try {
        const response = await getWorkflowRuns(namespace, name, 50)
        if (!mountedRef.current) return
        setRuns(response.items)
      } catch (err) {
        if (!mountedRef.current) return
        if (!silent) {
          setRunsError(err instanceof Error ? err.message : 'Failed to load runs')
        }
      } finally {
        if (mountedRef.current && !silent) setLoadingRuns(false)
      }
    },
    [namespace, name]
  )

  const loadPods = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLoadingPods(true)
        setPodsError('')
      }
      try {
        const response = await getRecipePods(name)
        if (!mountedRef.current) return
        setPods(response.pods)
      } catch (err) {
        if (!mountedRef.current) return
        if (!silent) {
          setPodsError(err instanceof Error ? err.message : 'Failed to load pods')
        }
      } finally {
        if (mountedRef.current && !silent) setLoadingPods(false)
      }
    },
    [name]
  )

  useEffect(() => {
    if (!name) return
    void loadRecipe()
    void loadRuns()
    void loadPods()
  }, [name, loadRecipe, loadRuns, loadPods])

  const visibleRuns = useMemo(
    () => getVisibleWorkflowRuns(recipe, recipeStatus, runs),
    [recipe, recipeStatus, runs]
  )
  const shouldPoll = useMemo(
    () => shouldPollWorkflowRecipe(recipe, recipeStatus, runs),
    [recipe, recipeStatus, runs]
  )
  // Always poll pods when on the workloads tab — a pod can flap between
  // CrashLoopBackOff and Running while the recipe phase is settled, so we
  // can't gate on phase here. Stop polling when the user is somewhere else.
  const podsTabActive = activeTab === 'workloads'
  useEffect(() => {
    if (!name) return
    if (!shouldPoll && !podsTabActive) return
    const t = setInterval(() => {
      void loadRecipe(true)
      void loadRuns(true)
      if (podsTabActive) void loadPods(true)
    }, STATUS_POLL_MS)
    return () => clearInterval(t)
  }, [name, shouldPoll, podsTabActive, loadRecipe, loadRuns, loadPods])

  function backToList() {
    router.push(CONTROL_ROUTES.plugins.root)
  }

  async function handleUninstall() {
    const shouldUninstall = await confirm({
      title: 'Uninstall Plugin',
      message: `Uninstall plugin "${name}" from namespace "${namespace}"?`,
      confirmLabel: 'Uninstall',
      tone: 'danger',
    })
    if (!shouldUninstall) return

    setUninstalling(true)
    setActionError('')
    try {
      await deleteRecipe(name)
      showToast(`Plugin ${name} uninstalled.`, { tone: 'success' })
      router.push(CONTROL_ROUTES.plugins.root)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to uninstall plugin')
      setUninstalling(false)
    }
  }

  async function handleRetry() {
    setRetrying(true)
    setActionError('')
    try {
      await retryRecipe(name)
      // The patch lands as candidate; WRC's next reconcile transitions it
      // through to active. Refresh now so the operator sees the change.
      await loadRecipe(true)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to retry plugin')
    } finally {
      setRetrying(false)
    }
  }

  const workloadRowCount = useMemo(
    () => buildWorkloadRowIds(extractWorkloads(recipeStatus), pods).length,
    [recipeStatus, pods]
  )

  if (editMode) {
    const backToPlugin = () => {
      router.replace(CONTROL_ROUTES.plugins.detail(namespace, name))
    }
    const loadFailedBeforeRecipeResolved = !recipe && Boolean(recipeError)
    const showEditorSkeleton = !recipe || !editorReady

    return (
      <AuthGate>
        <DashboardLayout isDetailPage>
          {recipeError ? (
            <div className="cu-banner cu-banner--error" role="alert">
              {recipeError}
            </div>
          ) : null}
          {/* The error banner above owns failed loads that never resolved a recipe. */}
          {loadFailedBeforeRecipeResolved ? null : showEditorSkeleton ? (
            <CreateFlowSkeleton
              {...CREATE_FLOW_LOADING.editPlugin}
              onBack={backToPlugin}
              backDisabled={false}
            />
          ) : (
            <RecipeEditor
              key={editorRecipeKey}
              initial={recipe}
              onSaved={() => {
                backToPlugin()
                void loadRecipe()
              }}
              onCancel={backToPlugin}
              pageHeader={
                <CreatePageHeader
                  icon={<IconWorkflow />}
                  title="Edit Plugin"
                  subtitle="Update the plugin manifest, review policy, and redeploy it."
                  backLabel="Back to plugin"
                  onBack={backToPlugin}
                />
              }
            />
          )}
        </DashboardLayout>
      </AuthGate>
    )
  }

  const inputs = extractInputs(recipe)
  const runnable = isRecipeReadyToRun(recipe, recipeStatus, runs)
  const runDisabledReason = getRecipeRunDisabledReason(recipe, recipeStatus, runs)
  const showLiveStatusContent = isWorkflowExecutionLive(recipeStatus)
  const normalizedRunDisabledReason =
    runDisabledReason === RECIPE_STATUS_LOADING_REASON ? '' : runDisabledReason
  // Keep the Run affordance while the recipe or its status is still resolving
  // (so the header doesn't flicker during load). Once we have a concrete
  // not-usable reason — degraded, no steps, trigger-disabled, wrong phase —
  // hide the button entirely instead of showing it disabled.
  const runStatusStillLoading = !recipe || runDisabledReason === RECIPE_STATUS_LOADING_REASON
  const hideRunButton = !runStatusStillLoading && !runnable
  const conditionsCount = extractConditions(recipeStatus).length
  const showIntegrations = hasBackgroundOauthClients(recipe)
  const pluginTitleActions = (
    <>
      {!hideRunButton && (
        <button
          type="button"
          className="cu-btn cu-btn--primary cu-btn--sm"
          disabled={!recipe || !runnable}
          title={normalizedRunDisabledReason || undefined}
          onClick={() => setRunModalOpen(true)}
        >
          Run…
        </button>
      )}
      <KebabMenu
        ariaLabel="More plugin actions"
        items={[
          {
            label: 'Edit',
            disabled: !recipe,
            onClick: () => router.push(CONTROL_ROUTES.plugins.edit(namespace, name)),
          },
          ...(String(recipeStatus?.phase ?? '') === 'failed'
            ? [
                {
                  label: retrying ? 'Retrying…' : 'Retry',
                  disabled: retrying,
                  onClick: handleRetry,
                },
              ]
            : []),
          {
            label: uninstalling ? 'Uninstalling…' : 'Uninstall',
            disabled: uninstalling,
            danger: true,
            onClick: handleUninstall,
          },
        ]}
      />
    </>
  )
  const detailTabs = [
    {
      label: `Workloads${workloadRowCount ? ` (${workloadRowCount})` : ''}`,
      value: 'workloads' as DetailTab,
      href: detailTabHref('workloads'),
    },
    {
      label: `Conditions${conditionsCount ? ` (${conditionsCount})` : ''}`,
      value: 'conditions' as DetailTab,
      href: detailTabHref('conditions'),
    },
    {
      label: `Runs${visibleRuns.length ? ` (${visibleRuns.length})` : ''}`,
      value: 'runs' as DetailTab,
      href: detailTabHref('runs'),
    },
    {
      label: 'Secrets',
      value: 'secrets' as DetailTab,
      href: detailTabHref('secrets'),
    },
    ...(showIntegrations
      ? [
          {
            label: 'Integrations',
            value: 'integrations' as DetailTab,
            href: detailTabHref('integrations'),
          },
        ]
      : []),
    {
      label: 'Members',
      value: 'members' as DetailTab,
      href: detailTabHref('members'),
    },
    {
      label: 'Teams',
      value: 'teams' as DetailTab,
      href: detailTabHref('teams'),
    },
    {
      label: 'Approval targets',
      value: 'approval-targets' as DetailTab,
      href: detailTabHref('approval-targets'),
    },
  ]
  const detailNotice = (
    <>
      {recipeError ? (
        <div className="cu-banner cu-banner--error" role="alert">
          {recipeError}
        </div>
      ) : null}
      {actionError ? (
        <div className="cu-banner cu-banner--error" role="alert">
          {actionError}
        </div>
      ) : null}
    </>
  )
  const detailOverlays = (
    <>
      {runModalOpen ? (
        <WorkflowRunModal
          name={name}
          namespace={namespace}
          inputs={inputs}
          requiresApproval={workflowOnDemandRequiresApproval(recipe)}
          onClose={() => setRunModalOpen(false)}
          onStarted={info => {
            showToast(info.runId ? `Run started: ${info.runId}.` : 'Run started.', {
              tone: 'success',
            })
            void loadRuns(true)
          }}
        />
      ) : null}
      {confirmDialog}
    </>
  )

  return (
    <AuthGate>
      <DetailPageShell<DetailTab>
        activeTab={activeTab}
        backLabel="Back to plugins"
        contentMode="plain"
        eyebrow={recipe?.metadata?.namespace ?? namespace}
        icon={<IconWorkflow />}
        notice={detailNotice}
        onBack={backToList}
        onTabChange={selectTab}
        overlays={detailOverlays}
        subtitle="WorkflowRecipe details and runtime status."
        tabAriaLabel="Plugin detail sections"
        tabClassName="cu-tabs--compact"
        tabs={detailTabs}
        title={name || 'Plugin'}
        titleActions={pluginTitleActions}
      >
        {activeTab === 'workloads' ? (
          <WorkloadsTab
            status={recipeStatus}
            pods={pods}
            loading={loadingPods && workloadRowCount === 0}
            error={podsError}
            onRefresh={() => void loadPods()}
          />
        ) : activeTab === 'conditions' ? (
          <ConditionsTab status={recipeStatus} />
        ) : activeTab === 'secrets' ? (
          <RecipeSecretsPanel recipeName={name} />
        ) : activeTab === 'integrations' ? (
          <RecipeIntegrationsPanel recipe={recipe} />
        ) : activeTab === 'members' || activeTab === 'teams' || activeTab === 'approval-targets' ? (
          !loadingRecipe && recipe ? (
            <div className="cu-card">
              <div className="cu-card__body">
                <GrantsReadonlyPanel
                  namespace={namespace}
                  recipeName={name}
                  editable
                  activeSection={
                    activeTab === 'members'
                      ? 'trigger-users'
                      : activeTab === 'teams'
                        ? 'trigger-teams'
                        : 'approval-target-teams'
                  }
                />
              </div>
            </div>
          ) : (
            <div className="cu-card">
              <div className="cu-card__body">
                <span className="cu-muted">Loading recipe…</span>
              </div>
            </div>
          )
        ) : (
          <>
            {showLiveStatusContent ? (
              <div id="live-status" tabIndex={-1}>
                <RecipeStatusContent name={name} namespace={namespace} />
              </div>
            ) : null}

            <div className="cu-card">
              <TablePanelHeader
                title={<>Runs ({visibleRuns.length})</>}
                subtitle="Most recent runs first. Click a row for the full step output."
              />
              {runsError ? (
                <div className="cu-banner cu-banner--error" style={{ padding: '0.85rem 1rem 0' }}>
                  {runsError}
                </div>
              ) : null}
              {loadingRuns && visibleRuns.length === 0 ? (
                <div className="cu-table-wrap">
                  <table className="cu-table">
                    <thead>
                      <TableHeaderRow columns={RUNS_COLUMNS} />
                    </thead>
                    <tbody>
                      <SkeletonTableRows columns={RUNS_COLUMNS.length} rows={3} />
                    </tbody>
                  </table>
                </div>
              ) : visibleRuns.length === 0 ? (
                <div className="cu-empty">
                  No runs yet. Click <strong>Run…</strong> to trigger one.
                </div>
              ) : (
                <div className="cu-table-wrap">
                  <table className="cu-table">
                    <thead>
                      <TableHeaderRow columns={RUNS_COLUMNS} />
                    </thead>
                    <tbody>
                      {visibleRuns.map(run => {
                        const isCurrentExecutionRow = run.isCurrentExecution === true
                        const recipeHref = CONTROL_ROUTES.plugins.detail(namespace, name)
                        const href = isCurrentExecutionRow
                          ? `${recipeHref}#live-status`
                          : CONTROL_ROUTES.plugins.run(namespace, name, run.id)
                        const shortId = run.id.slice(0, 8)
                        const canOpenRun = run.isClickable !== false
                        const openLabel = isCurrentExecutionRow
                          ? 'Open current execution status'
                          : `Open run ${shortId}`
                        const openRun = () => {
                          if (!canOpenRun) return
                          if (isCurrentExecutionRow) {
                            const liveStatus = document.getElementById('live-status')
                            if (liveStatus) {
                              liveStatus.scrollIntoView({ behavior: 'smooth', block: 'start' })
                              window.history.replaceState(null, '', '#live-status')
                              liveStatus.focus({ preventScroll: true })
                              return
                            }
                          }
                          router.push(href)
                        }

                        return (
                          <tr
                            key={run.id}
                            className={`cu-table__row${canOpenRun ? ' cu-table__row--clickable' : ''}`}
                            onClick={openRun}
                            onKeyDown={e => {
                              if (canOpenRun && (e.key === 'Enter' || e.key === ' ')) {
                                e.preventDefault()
                                openRun()
                              }
                            }}
                            tabIndex={canOpenRun ? 0 : undefined}
                            role={canOpenRun ? 'link' : undefined}
                            aria-label={canOpenRun ? openLabel : undefined}
                            style={canOpenRun ? { cursor: 'pointer' } : undefined}
                          >
                            <td style={{ padding: '10px' }}>
                              <span
                                title={run.id}
                                style={{
                                  fontFamily: 'monospace',
                                  fontSize: '0.78rem',
                                  padding: '1px 7px',
                                  borderRadius: 4,
                                  background: 'var(--cu-bg-elevated)',
                                  color: 'var(--cu-text-soft)',
                                  border: '1px solid var(--cu-border-subtle)',
                                }}
                              >
                                {run.isCurrentExecution ? 'current' : shortId}
                              </span>
                              {run.isCurrentExecution ? (
                                <span className="cu-muted" style={{ marginLeft: 8 }}>
                                  current execution
                                </span>
                              ) : null}
                            </td>
                            <td style={{ padding: '10px' }}>{run.phase}</td>
                            <td style={{ padding: '10px' }}>{formatTime(run.triggeredAt)}</td>
                            <td style={{ padding: '10px' }}>{formatTime(run.startedAt)}</td>
                            <td style={{ padding: '10px' }}>{formatTime(run.completedAt)}</td>
                            <td style={{ padding: '10px' }}>{formatTriggerer(run)}</td>
                            <td style={{ padding: '10px', textAlign: 'right' }} aria-hidden>
                              ›
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </DetailPageShell>
    </AuthGate>
  )
}

function WorkloadsTab({
  status,
  pods,
  loading,
  error,
  onRefresh,
}: {
  status: Record<string, unknown> | null
  pods: RecipePod[]
  loading: boolean
  error: string
  onRefresh: () => void
}) {
  const workloads = useMemo(() => extractWorkloads(status), [status])
  const rowIds = useMemo(() => buildWorkloadRowIds(workloads, pods), [workloads, pods])
  const podsByWorkload = useMemo(() => {
    const m = new Map<string, RecipePod[]>()
    for (const p of pods) {
      const k = p.workloadId ?? ''
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(p)
    }
    return m
  }, [pods])

  return (
    <>
      <div className="cu-card">
        <TablePanelHeader
          title={<>Workloads ({rowIds.length})</>}
          subtitle={
            <>
              <code>Reconcile</code> shows the controller-managed workload. <code>Pod</code> shows
              the current runtime pod state.
            </>
          }
          actions={
            <button
              type="button"
              className="cu-btn cu-btn--icon cu-btn--toolbar"
              onClick={onRefresh}
              disabled={loading}
              aria-label={loading ? 'Refreshing…' : 'Reload pods'}
            >
              ↻
            </button>
          }
        />
        {error ? (
          <div className="cu-banner cu-banner--error" style={{ padding: '0.85rem 1rem 0' }}>
            {error}
          </div>
        ) : null}
        {loading && rowIds.length === 0 ? (
          <div className="cu-table-wrap">
            <table className="cu-table">
              <thead>
                <TableHeaderRow columns={WORKLOAD_COLUMNS} />
              </thead>
              <tbody>
                <SkeletonTableRows columns={WORKLOAD_COLUMNS.length} rows={3} />
              </tbody>
            </table>
          </div>
        ) : rowIds.length === 0 ? (
          <div className="cu-empty">This plugin has no workloads or pods yet.</div>
        ) : (
          <div className="cu-table-wrap">
            <table className="cu-table">
              <thead>
                <TableHeaderRow columns={WORKLOAD_COLUMNS} />
              </thead>
              <tbody>
                {rowIds.map(workloadId => {
                  const w = workloads.find(x => x.id === workloadId)
                  const wpods = podsByWorkload.get(workloadId ?? '') ?? []
                  // One row per pod — most workloads have just one pod, but
                  // StatefulSets / replicas / rolling updates can have several.
                  // If a workload has zero pods, render a single row showing
                  // the reconcile state with a dash for pod state.
                  const podRows = wpods.length > 0 ? wpods : [null]
                  return podRows.map((p, i) => {
                    const isFirst = i === 0
                    return (
                      <tr key={`${workloadId}-${p?.name ?? i}`}>
                        <td
                          style={{ padding: '10px', fontFamily: 'monospace', fontSize: '0.85rem' }}
                        >
                          {isFirst ? workloadId || '—' : ''}
                        </td>
                        <td style={{ padding: '10px' }}>{isFirst ? (w?.type ?? '—') : ''}</td>
                        <td style={{ padding: '10px' }}>{p?.namespace ?? '—'}</td>
                        <td style={{ padding: '10px' }}>
                          {isFirst ? (
                            <span
                              className="cu-chip"
                              style={chipStyle(
                                w?.ready ? 'ok' : w?.phase === 'failed' ? 'error' : 'warn'
                              )}
                              title={w?.message ?? ''}
                            >
                              {w?.phase ?? '—'}
                              {w?.ready === true
                                ? ' · ready'
                                : w?.ready === false
                                  ? ' · not ready'
                                  : ''}
                            </span>
                          ) : (
                            ''
                          )}
                        </td>
                        <td style={{ padding: '10px' }}>
                          {p ? (
                            <span
                              className="cu-chip"
                              style={chipStyle(podTone(p))}
                              title={p.message ?? ''}
                            >
                              {p.phase}
                              {p.reason ? ` · ${p.reason}` : ''}
                            </span>
                          ) : (
                            <span className="cu-muted">no pod</span>
                          )}
                        </td>
                        <td style={{ padding: '10px' }}>{p ? p.restarts : '—'}</td>
                        <td style={{ padding: '10px' }}>
                          {formatRelativeAge(p?.createdAt ?? null)}
                        </td>
                        <td
                          style={{
                            padding: '10px',
                            color: 'var(--cu-text-soft)',
                            fontSize: '0.8125rem',
                            maxWidth: '24rem',
                            whiteSpace: 'normal',
                          }}
                        >
                          {p?.message ?? (isFirst ? (w?.message ?? '') : '')}
                        </td>
                      </tr>
                    )
                  })
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

const CONDITION_COLUMNS: TableHeaderColumn[] = [
  { key: 'type', label: 'Type' },
  { key: 'status', label: 'Status' },
  { key: 'reason', label: 'Reason' },
  { key: 'message', label: 'Message' },
  { key: 'age', label: 'Last transition' },
]

function ConditionsTab({ status }: { status: Record<string, unknown> | null }) {
  const conditions = useMemo(() => extractConditions(status), [status])
  return (
    <div className="cu-card">
      <TablePanelHeader
        title={<>Conditions ({conditions.length})</>}
        subtitle="Plugin-level signals reported by the workflow-recipes controller."
      />
      {conditions.length === 0 ? (
        <div className="cu-empty">
          No conditions reported. Everything that the controller checks is healthy.
        </div>
      ) : (
        <div className="cu-table-wrap">
          <table className="cu-table">
            <thead>
              <TableHeaderRow columns={CONDITION_COLUMNS} />
            </thead>
            <tbody>
              {conditions.map((c, i) => {
                const tone = conditionTone(c)
                return (
                  <tr key={`${c.type}-${i}`}>
                    <td style={{ padding: '10px' }}>
                      <span className="cu-chip" style={chipStyle(tone)}>
                        {c.type ?? '—'}
                      </span>
                    </td>
                    <td style={{ padding: '10px' }}>{String(c.status ?? '—')}</td>
                    <td style={{ padding: '10px', color: 'var(--cu-text-soft)' }}>
                      {c.reason ?? '—'}
                    </td>
                    <td
                      style={{
                        padding: '10px',
                        color: 'var(--cu-text-soft)',
                        maxWidth: '32rem',
                        whiteSpace: 'normal',
                      }}
                    >
                      {c.message ?? ''}
                    </td>
                    <td style={{ padding: '10px', color: 'var(--cu-text-soft)' }}>
                      {formatRelativeAge(c.lastTransitionTime ?? null)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
