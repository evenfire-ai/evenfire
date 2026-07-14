import { useCallback, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
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
    async (wf: WorkflowSummary | null) => {
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
        return
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
      if (seq !== selectWorkflowSeqRef.current) return
      const currentSelection = queryClient.getQueryData<WorkflowSelectionState>(
        desktopQueryKeys.workflowSelection
      )
      if (
        (currentSelection?.selectionVersion ?? EMPTY_WORKFLOW_SELECTION.selectionVersion) !==
        selectionVersion
      ) {
        return
      }
      if (!sameWorkflow(currentSelection?.selectedWorkflow ?? null, wf)) return
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
    },
    [loadWorkflowRunsFor, queryClient, setWorkflowSelection]
  )

  const handleRefreshSelectedWorkflow = useCallback(async () => {
    await handleRefreshWorkflows()
    const detailPromise = selectedWorkflow
      ? queryClient
          .fetchQuery({
            queryKey: desktopQueryKeys.workflowDetail(
              selectedWorkflow.namespace,
              selectedWorkflow.name
            ),
            queryFn: () =>
              window.clerum.workflows.read(
                selectedWorkflow.namespace,
                selectedWorkflow.name
              ) as Promise<WorkflowRecipeResource>,
            staleTime: 0,
          })
          .catch(() => null)
      : Promise.resolve(null)
    const [detail] = await Promise.all([detailPromise, loadWorkflowRunsFor(selectedWorkflow)])
    if (selectedWorkflow && detail) {
      setWorkflowSelection(current => ({
        ...current,
        selectedWorkflow: {
          ...selectedWorkflow,
          triggerableByUser: canTriggerWorkflowAsUser(detail),
        },
      }))
    }
  }, [
    handleRefreshWorkflows,
    loadWorkflowRunsFor,
    queryClient,
    selectedWorkflow,
    setWorkflowSelection,
  ])

  const handleTriggerWorkflow = useCallback(
    async (ns: string, name: string) => {
      setWorkflowTriggerLoading(true)
      try {
        const idempotencyKey =
          globalThis.crypto?.randomUUID?.() ??
          `wf-${Date.now()}-${Math.random().toString(16).slice(2)}`
        const hasInputs = Object.keys(workflowInputValues).length > 0
        const payload = hasInputs ? workflowInputValues : undefined
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
    [handleRefreshWorkflows, handleSelectWorkflow, setStatus, workflowInputValues, workflows]
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
  const selectedWorkflowSdkCapability =
    selectedWorkflowDetailQuery.data &&
    typeof selectedWorkflowDetailQuery.data === 'object' &&
    'status' in selectedWorkflowDetailQuery.data
      ? ((selectedWorkflowDetailQuery.data as WorkflowRecipeResource).status?.pluginWorkloadSdk ??
        null)
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
      selectedWorkflowSdkCapability,
      workflowInputValues,
      workflowRuns,
      workflowRunsLoading,
      workflowTriggerLoading,
      setWorkflowInputValues,
      handleRefreshWorkflows,
      handleSelectWorkflow,
      handleRefreshSelectedWorkflow,
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
      selectedWorkflowSdkCapability,
      workflowInputValues,
      workflowRuns,
      workflowRunsLoading,
      workflowTriggerLoading,
      setWorkflowInputValues,
      handleRefreshWorkflows,
      handleSelectWorkflow,
      handleRefreshSelectedWorkflow,
      handleTriggerWorkflow,
      loadWorkflowRunsFor,
      clearSelectedWorkflow,
      resetWorkflows,
    ]
  )
}
