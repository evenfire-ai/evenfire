import { useCallback, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  WorkflowInputContractSchema,
  WorkflowInputValues,
  WorkflowRecipeListResult,
  WorkflowRecipeResource,
  WorkflowRunsResult,
} from '../../../../src/types'
import { buildInitialInputValues } from '../../components/InputContractForm'
import { canTriggerWorkflowAsUser, summarizeWorkflowResource } from '../../lib/workflows'
import type { WorkflowSummary } from '../../workflows.types'
import { desktopQueryKeys } from './queryKeys'
import {
  EMPTY_WORKFLOW_SELECTION,
  type UseWorkflowControllerParams,
  type WorkflowSelectionState,
  createResetWorkflowSelection,
} from './useWorkflowController.types'

const EMPTY_WORKFLOW_RUNS: WorkflowRunsResult['items'] = []

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isWorkflowApprovalRequestResult(
  value: unknown
): value is { approvalRequired: true; approvalRequestId: string } {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.approvalRequired === true && typeof record.approvalRequestId === 'string'
}

function toWorkflowSummaries(raw: WorkflowRecipeListResult | undefined): WorkflowSummary[] {
  const items = Array.isArray(raw?.items) ? raw.items : []
  return items.map((item: WorkflowRecipeResource) => summarizeWorkflowResource(item))
}

async function loadRunsWithArtifacts(wf: WorkflowSummary): Promise<WorkflowRunsResult> {
  const raw = (await window.clerum.workflows.runs(wf.namespace, wf.name, 20)) as WorkflowRunsResult
  const runs = Array.isArray(raw?.items) ? raw.items : []
  const enrichedRuns = await Promise.all(
    runs.map(async run => {
      if (!run.executionRef) return run
      try {
        const result = await window.clerum.workflows.listRunArtifacts(wf.namespace, wf.name, run.id)
        return { ...run, artifacts: result.artifacts ?? [] }
      } catch {
        return { ...run, artifacts: [] }
      }
    })
  )
  return { ...raw, items: enrichedRuns }
}

function sameWorkflow(left: WorkflowSummary | null, right: WorkflowSummary | null): boolean {
  if (!left || !right) return left === right
  return left.namespace === right.namespace && left.name === right.name
}

// The flat Plugins table (spec 12 §5.F) shows a compact "Recent Runs" cell per
// row: the latest run's phase/time plus a run count. We fetch a small window
// and enrich only the latest run with artifacts (the download affordance lives
// on that most-recent run) so the cell stays cheap relative to the old
// accordion, which enriched every run of the one selected workflow.
export const RECENT_RUNS_LIMIT = 5

async function loadRecentRunsWithLatestArtifacts(
  wf: WorkflowSummary,
  limit: number
): Promise<WorkflowRunsResult> {
  const raw = (await window.clerum.workflows.runs(
    wf.namespace,
    wf.name,
    limit
  )) as WorkflowRunsResult
  const items = Array.isArray(raw?.items) ? raw.items : []
  const [latest, ...rest] = items
  if (!latest || !latest.executionRef) {
    return { ...raw, items }
  }
  try {
    const result = await window.clerum.workflows.listRunArtifacts(wf.namespace, wf.name, latest.id)
    return { ...raw, items: [{ ...latest, artifacts: result.artifacts ?? [] }, ...rest] }
  } catch {
    return { ...raw, items: [{ ...latest, artifacts: [] }, ...rest] }
  }
}

export type WorkflowRecentRuns = {
  latestRun: WorkflowRunsResult['items'][number] | null
  runCount: number
  loading: boolean
  refreshing: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * Per-row recent-runs source for the flat Plugins table. Uses the shared runs
 * query key so navigating back to Plugins reads cache (staleTime: Infinity)
 * instead of refetching; the per-row Refresh button forces a re-fetch.
 */
export function useWorkflowRecentRuns(wf: WorkflowSummary): WorkflowRecentRuns {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: desktopQueryKeys.workflowRuns(wf.namespace, wf.name, RECENT_RUNS_LIMIT),
    queryFn: () => loadRecentRunsWithLatestArtifacts(wf, RECENT_RUNS_LIMIT),
    staleTime: Infinity,
    gcTime: Infinity,
  })

  const items =
    query.data && Array.isArray(query.data.items) ? query.data.items : EMPTY_WORKFLOW_RUNS
  const namespace = wf.namespace
  const name = wf.name

  const refresh = useCallback(async () => {
    try {
      await queryClient.fetchQuery({
        queryKey: desktopQueryKeys.workflowRuns(namespace, name, RECENT_RUNS_LIMIT),
        queryFn: () =>
          loadRecentRunsWithLatestArtifacts({ ...wf, namespace, name }, RECENT_RUNS_LIMIT),
        staleTime: 0,
      })
    } catch {
      // Query state already records the error for consumers.
    }
  }, [queryClient, namespace, name, wf])

  return {
    latestRun: items[0] ?? null,
    runCount: typeof query.data?.count === 'number' ? query.data.count : items.length,
    loading: query.isFetching && items.length === 0,
    refreshing: query.isFetching,
    error: query.error ? toErrorMessage(query.error) : null,
    refresh,
  }
}

export function useWorkflowController(params: UseWorkflowControllerParams) {
  const { setStatus } = params
  const queryClient = useQueryClient()
  const selectWorkflowSeqRef = useRef(0)

  const workflowSelectionQuery = useQuery({
    queryKey: desktopQueryKeys.workflowSelection,
    queryFn: () =>
      queryClient.getQueryData<WorkflowSelectionState>(desktopQueryKeys.workflowSelection) ??
      EMPTY_WORKFLOW_SELECTION,
    enabled: false,
    initialData: () =>
      queryClient.getQueryData<WorkflowSelectionState>(desktopQueryKeys.workflowSelection) ??
      EMPTY_WORKFLOW_SELECTION,
    staleTime: Infinity,
    gcTime: Infinity,
  })

  const workflowSelection = workflowSelectionQuery.data ?? EMPTY_WORKFLOW_SELECTION
  const selectedWorkflow = workflowSelection.selectedWorkflow
  const workflowInputValues = workflowSelection.workflowInputValues
  const workflowTriggerLoading = workflowSelection.workflowTriggerLoading

  const setWorkflowSelection = useCallback(
    (
      updater:
        | WorkflowSelectionState
        | ((current: WorkflowSelectionState) => WorkflowSelectionState)
    ) => {
      queryClient.setQueryData<WorkflowSelectionState>(
        desktopQueryKeys.workflowSelection,
        current => {
          const previous = current ?? EMPTY_WORKFLOW_SELECTION
          return typeof updater === 'function' ? updater(previous) : updater
        }
      )
    },
    [queryClient]
  )

  const setWorkflowInputValues = useCallback(
    (next: WorkflowInputValues) => {
      setWorkflowSelection(current => ({
        ...current,
        workflowInputValues: next,
      }))
    },
    [setWorkflowSelection]
  )

  const setWorkflowTriggerLoading = useCallback(
    (workflowTriggerLoading: boolean) => {
      setWorkflowSelection(current => ({
        ...current,
        workflowTriggerLoading,
      }))
    },
    [setWorkflowSelection]
  )

  const workflowsQuery = useQuery({
    queryKey: desktopQueryKeys.workflows,
    queryFn: () => window.clerum.workflows.list() as Promise<WorkflowRecipeListResult>,
    enabled: false,
  })

  const selectedWorkflowDetailQuery = useQuery({
    queryKey: selectedWorkflow
      ? desktopQueryKeys.workflowDetail(selectedWorkflow.namespace, selectedWorkflow.name)
      : desktopQueryKeys.workflowDetail('', ''),
    queryFn: () => {
      if (!selectedWorkflow) return Promise.resolve(null)
      return window.clerum.workflows.read(
        selectedWorkflow.namespace,
        selectedWorkflow.name
      ) as Promise<WorkflowRecipeResource>
    },
    enabled: false,
  })

  const workflowRunsQuery = useQuery({
    queryKey: selectedWorkflow
      ? desktopQueryKeys.workflowRuns(selectedWorkflow.namespace, selectedWorkflow.name, 20)
      : desktopQueryKeys.workflowRuns('', '', 20),
    queryFn: () => {
      if (!selectedWorkflow) return Promise.resolve({ items: [], count: 0 } as WorkflowRunsResult)
      return loadRunsWithArtifacts(selectedWorkflow)
    },
    enabled: false,
  })

  const workflows = useMemo(() => toWorkflowSummaries(workflowsQuery.data), [workflowsQuery.data])

  const handleRefreshWorkflows = useCallback(async () => {
    try {
      await queryClient.fetchQuery({
        queryKey: desktopQueryKeys.workflows,
        queryFn: () => window.clerum.workflows.list() as Promise<WorkflowRecipeListResult>,
        staleTime: 0,
      })
    } catch {
      // Query state already records the error for consumers.
    }
  }, [queryClient])

  const loadWorkflowRunsFor = useCallback(
    async (wf: WorkflowSummary | null) => {
      if (!wf) return
      try {
        await queryClient.fetchQuery({
          queryKey: desktopQueryKeys.workflowRuns(wf.namespace, wf.name, 20),
          queryFn: () => loadRunsWithArtifacts(wf),
          staleTime: 0,
        })
      } catch {
        // Query state already records the error for consumers.
      }
    },
    [queryClient]
  )

  const handleSelectWorkflow = useCallback(
    async (wf: WorkflowSummary | null): Promise<WorkflowInputContractSchema | null> => {
      const seq = ++selectWorkflowSeqRef.current
      const selectionVersion =
        queryClient.getQueryData<WorkflowSelectionState>(desktopQueryKeys.workflowSelection)
          ?.selectionVersion ?? EMPTY_WORKFLOW_SELECTION.selectionVersion
      setWorkflowSelection(current => ({
        ...current,
        selectedWorkflow: wf,
        workflowInputValues: EMPTY_WORKFLOW_SELECTION.workflowInputValues,
      }))
      if (!wf) {
        return null
      }

      const detailPromise = queryClient
        .fetchQuery({
          queryKey: desktopQueryKeys.workflowDetail(wf.namespace, wf.name),
          queryFn: () =>
            window.clerum.workflows.read(wf.namespace, wf.name) as Promise<WorkflowRecipeResource>,
          staleTime: 0,
        })
        .catch(() => null)
      const runsPromise = loadWorkflowRunsFor(wf)

      const detail = await detailPromise
      if (seq !== selectWorkflowSeqRef.current) return null
      const currentSelection = queryClient.getQueryData<WorkflowSelectionState>(
        desktopQueryKeys.workflowSelection
      )
      if (
        (currentSelection?.selectionVersion ?? EMPTY_WORKFLOW_SELECTION.selectionVersion) !==
        selectionVersion
      ) {
        return null
      }
      if (!sameWorkflow(currentSelection?.selectedWorkflow ?? null, wf)) return null
      const schema = detail?.spec?.inputContract ?? null
      const nextWorkflow = detail
        ? {
            ...wf,
            triggerableByUser: canTriggerWorkflowAsUser(detail),
          }
        : wf
      const nextInputValues = buildInitialInputValues(schema ?? undefined)
      setWorkflowSelection(current => ({
        ...current,
        selectedWorkflow: nextWorkflow,
        workflowInputValues: nextInputValues,
      }))
      await runsPromise
      return schema
    },
    [loadWorkflowRunsFor, queryClient, setWorkflowSelection]
  )

  const handleTriggerWorkflow = useCallback(
    async (ns: string, name: string, explicitInputs?: WorkflowInputValues) => {
      setWorkflowTriggerLoading(true)
      try {
        const idempotencyKey =
          globalThis.crypto?.randomUUID?.() ??
          `wf-${Date.now()}-${Math.random().toString(16).slice(2)}`
        // The flat table's direct-trigger path (a recipe with no input contract)
        // passes `{}` explicitly so a stale render-time closure over the last
        // selection's inputs can never leak into a contract-less trigger. The
        // modal path omits the argument and uses the live edited values.
        const values = explicitInputs ?? workflowInputValues
        const hasInputs = Object.keys(values).length > 0
        const payload = hasInputs ? values : undefined
        const result = await window.clerum.workflows.trigger(ns, name, payload, idempotencyKey)
        if (isWorkflowApprovalRequestResult(result)) {
          setStatus('Approval requested. Open notifications to approve.', 'success', undefined, {
            global: false,
            toast: true,
          })
        } else {
          setStatus('Workflow triggered.', 'success', undefined, { global: false, toast: true })
        }
        await handleRefreshWorkflows()
        // The flat Plugins table reads recent runs from the RECENT_RUNS_LIMIT
        // key (see useWorkflowRecentRuns), a different cache entry than the
        // selection path's limit-20 query. Invalidate that key so the row's
        // "Recent Runs" cell shows the just-created run without a manual Refresh
        // (both trigger paths — direct and modal — flow through here).
        await queryClient.invalidateQueries({
          queryKey: desktopQueryKeys.workflowRuns(ns, name, RECENT_RUNS_LIMIT),
        })
        const wf = workflows.find(workflow => workflow.namespace === ns && workflow.name === name)
        if (wf) await handleSelectWorkflow(wf)
      } catch (error) {
        setStatus(
          `Trigger failed: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
      } finally {
        setWorkflowTriggerLoading(false)
      }
    },
    [
      handleRefreshWorkflows,
      handleSelectWorkflow,
      queryClient,
      setStatus,
      workflowInputValues,
      workflows,
    ]
  )

  const clearSelectedWorkflow = useCallback(() => {
    selectWorkflowSeqRef.current += 1
    setWorkflowSelection(current => ({
      ...current,
      selectedWorkflow: null,
      workflowInputValues: EMPTY_WORKFLOW_SELECTION.workflowInputValues,
    }))
  }, [setWorkflowSelection])

  const resetWorkflows = useCallback(() => {
    selectWorkflowSeqRef.current += 1
    setWorkflowSelection(createResetWorkflowSelection)
    queryClient.removeQueries({ queryKey: desktopQueryKeys.workflows })
    queryClient.removeQueries({ queryKey: ['desktop-app', 'workflow-detail'] })
    queryClient.removeQueries({ queryKey: ['desktop-app', 'workflow-runs'] })
  }, [queryClient, setWorkflowSelection])

  const selectedWorkflowInputContract =
    selectedWorkflowDetailQuery.data &&
    typeof selectedWorkflowDetailQuery.data === 'object' &&
    'spec' in selectedWorkflowDetailQuery.data
      ? ((selectedWorkflowDetailQuery.data as WorkflowRecipeResource).spec?.inputContract ?? null)
      : null
  const workflowRuns =
    workflowRunsQuery.data && Array.isArray(workflowRunsQuery.data.items)
      ? workflowRunsQuery.data.items
      : EMPTY_WORKFLOW_RUNS

  const workflowsLoading =
    workflowsQuery.fetchStatus === 'fetching' || workflowsQuery.status === 'pending'
  const workflowsError = workflowsQuery.error ? toErrorMessage(workflowsQuery.error) : null
  const workflowRunsLoading =
    workflowRunsQuery.fetchStatus === 'fetching' || workflowRunsQuery.status === 'pending'

  return useMemo(
    () => ({
      workflows,
      workflowsLoading,
      workflowsError,
      selectedWorkflow,
      selectedWorkflowInputContract,
      workflowInputValues,
      workflowRuns,
      workflowRunsLoading,
      workflowTriggerLoading,
      setWorkflowInputValues,
      handleRefreshWorkflows,
      handleSelectWorkflow,
      handleTriggerWorkflow,
      loadWorkflowRunsFor,
      clearSelectedWorkflow,
      resetWorkflows,
    }),
    [
      workflows,
      workflowsLoading,
      workflowsError,
      selectedWorkflow,
      selectedWorkflowInputContract,
      workflowInputValues,
      workflowRuns,
      workflowRunsLoading,
      workflowTriggerLoading,
      setWorkflowInputValues,
      handleRefreshWorkflows,
      handleSelectWorkflow,
      handleTriggerWorkflow,
      loadWorkflowRunsFor,
      clearSelectedWorkflow,
      resetWorkflows,
    ]
  )
}
