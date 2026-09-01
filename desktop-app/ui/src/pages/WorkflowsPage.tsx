import { useCallback, useState } from 'react'
import { Button, DataTable, EmptyState, Pill, StatusBanner } from '@components/Common'
import { ConfirmDialog } from '@components/ConfirmDialog'
import { IconWorkflows } from '@components/SidebarNav/icons'
import type { WorkflowRunArtifact, WorkflowRunListItem } from '../../../src/types'
import { InputContractForm } from '../components/InputContractForm'
import { useAuthContext } from '../contexts/AuthContext'
import {
  type WorkflowRecentRuns,
  useWorkflowController,
  useWorkflowRecentRuns,
} from '../hooks/domain/useWorkflowController'
import { formatRelativeTime } from '../lib/format'
import { workflowStatusPillTone } from '../lib/workflowStatus'
import type { WorkflowSummary } from '../workflows.types'

function workflowKey(wf: WorkflowSummary): string {
  return `${wf.namespace}/${wf.name}`
}

function hasContractInputs(
  contract: { properties?: Record<string, unknown> } | null | undefined
): boolean {
  return Boolean(contract && Object.keys(contract.properties ?? {}).length > 0)
}

/**
 * Compact "Recent Runs" cell (spec 12 §5.F): the latest run's phase + relative
 * time and a run count — never the full expanded list that lived in the old
 * accordion. The latest run's artifacts stay downloadable inline.
 */
function RecentRunsCell({
  recent,
  onDownload,
  downloadingKey,
}: {
  recent: WorkflowRecentRuns
  onDownload: (run: WorkflowRunListItem, artifact: WorkflowRunArtifact) => void
  downloadingKey: string | null
}) {
  if (recent.loading) {
    return <span className="muted">Loading runs…</span>
  }
  const run = recent.latestRun
  if (!run) {
    return <span className="muted">No runs yet</span>
  }
  const when = run.startedAt ?? run.triggeredAt
  return (
    <span className="workflow-recent-runs">
      <span className="workflow-recent-runs__summary">
        <Pill tone={workflowStatusPillTone(run.phase)} size="xs">
          {run.phase}
        </Pill>
        <span className="muted">{when ? formatRelativeTime(when) : 'Pending'}</span>
        {recent.runCount > 1 ? <span className="muted">· {recent.runCount} runs</span> : null}
      </span>
      {run.artifacts && run.artifacts.length > 0 ? (
        <span className="workflow-recent-runs__artifacts" aria-label="Latest run artifacts">
          {run.artifacts.map(artifact => {
            const key = `${run.id}:${artifact.name}`
            return (
              <Button
                key={artifact.name}
                className="workflow-run-artifact-btn"
                color="neutral"
                disabled={downloadingKey === key}
                onClick={() => onDownload(run, artifact)}
                size="xs"
                variant="ghost"
              >
                {downloadingKey === key ? 'Downloading…' : artifact.name}
              </Button>
            )
          })}
        </span>
      ) : null}
    </span>
  )
}

function WorkflowRow({
  wf,
  pendingTriggerKey,
  onTrigger,
}: {
  wf: WorkflowSummary
  pendingTriggerKey: string | null
  onTrigger: (wf: WorkflowSummary) => void
}) {
  const { setStatus } = useAuthContext()
  const recent = useWorkflowRecentRuns(wf)
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null)

  const rowKey = workflowKey(wf)
  const isTriggering = pendingTriggerKey === rowKey
  const anotherPending = pendingTriggerKey !== null && !isTriggering

  const handleDownload = useCallback(
    async (run: WorkflowRunListItem, artifact: WorkflowRunArtifact) => {
      const key = `${run.id}:${artifact.name}`
      setDownloadingKey(key)
      try {
        const result = await window.clerum.workflows.downloadRunArtifact(
          wf.namespace,
          wf.name,
          run.id,
          artifact.name
        )
        setStatus(`Saved ${result.filename || artifact.name} to Downloads.`, 'success', undefined, {
          global: false,
          toast: true,
        })
      } catch (error) {
        setStatus(
          `Download failed: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
      } finally {
        setDownloadingKey(null)
      }
    },
    [wf.namespace, wf.name, setStatus]
  )

  return (
    <tr>
      <td className="da-table__cell">
        <span className="context-id-cell workflow-plugin-title">
          <span className="agent-row-icon" aria-hidden="true">
            <IconWorkflows />
          </span>
          <strong>{wf.name}</strong>
        </span>
      </td>
      <td className="da-table__cell">
        <Pill tone={workflowStatusPillTone(wf.status)} size="sm">
          {wf.status || 'Unknown'}
        </Pill>
      </td>
      <td className="da-table__cell">
        <RecentRunsCell
          recent={recent}
          onDownload={handleDownload}
          downloadingKey={downloadingKey}
        />
      </td>
      <td className="da-table__cell da-table__cell--right">
        <span className="action-row">
          <Button
            color="primary"
            disabled={!wf.triggerableByUser || anotherPending}
            loading={isTriggering}
            onClick={() => onTrigger(wf)}
            size="sm"
            title={
              wf.triggerableByUser
                ? 'Trigger recipe'
                : 'This recipe does not declare an on-demand user trigger'
            }
            variant="soft"
          >
            Trigger
          </Button>
          <Button
            color="neutral"
            loading={recent.refreshing}
            onClick={() => void recent.refresh()}
            size="sm"
            variant="ghost"
          >
            Refresh
          </Button>
        </span>
      </td>
    </tr>
  )
}

export function WorkflowsPage() {
  const { setStatus } = useAuthContext()
  const {
    workflowsLoading: loading,
    workflows,
    selectedWorkflowInputContract,
    workflowInputValues,
    setWorkflowInputValues,
    workflowTriggerLoading,
    workflowsError: error,
    handleSelectWorkflow,
    handleTriggerWorkflow,
  } = useWorkflowController({ setStatus })

  // Which workflow's Trigger modal is open (a recipe with an input contract).
  // Replaces the old row-selection state that fed the inline accordion.
  const [triggerModalWorkflow, setTriggerModalWorkflow] = useState<WorkflowSummary | null>(null)
  // Which row is mid-trigger, so only that row shows the busy Trigger button.
  const [pendingTriggerKey, setPendingTriggerKey] = useState<string | null>(null)

  const handleTrigger = useCallback(
    async (wf: WorkflowSummary) => {
      if (!wf.triggerableByUser) return
      setPendingTriggerKey(workflowKey(wf))
      let contract: Awaited<ReturnType<typeof handleSelectWorkflow>>
      try {
        // Load the recipe detail so we know whether it declares inputs, and so
        // the modal's InputContractForm binds to the controller's input state.
        contract = await handleSelectWorkflow(wf)
      } catch (error) {
        // handleSelectWorkflow swallows its own read failures today, so this is
        // defensive. Report rather than fail silently if it ever does throw —
        // matching handleTriggerWorkflow's "Trigger failed" feedback.
        setPendingTriggerKey(null)
        setStatus(
          `Trigger failed: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
        return
      }
      if (hasContractInputs(contract)) {
        // Inputs required → open the modal; the trigger fires on confirm.
        setPendingTriggerKey(null)
        setTriggerModalWorkflow(wf)
        return
      }
      // No inputs → trigger directly (no modal). Keep the row busy through it.
      try {
        await handleTriggerWorkflow(wf.namespace, wf.name, {})
      } finally {
        setPendingTriggerKey(null)
      }
    },
    [handleSelectWorkflow, handleTriggerWorkflow, setStatus]
  )

  const confirmModalTrigger = useCallback(() => {
    const wf = triggerModalWorkflow
    setTriggerModalWorkflow(null)
    if (!wf) return
    // Modal path: fire with the live edited input values (omit the explicit
    // argument so handleTriggerWorkflow reads the controller's current inputs).
    setPendingTriggerKey(workflowKey(wf))
    void handleTriggerWorkflow(wf.namespace, wf.name).finally(() => setPendingTriggerKey(null))
  }, [triggerModalWorkflow, handleTriggerWorkflow])

  const header = (
    <div className="page-header">
      <h2>Plugins</h2>
      <p className="muted">View deployed recipes, see their recent runs, and trigger them.</p>
    </div>
  )

  const hasRows = workflows.length > 0

  return (
    <section className="page">
      {header}

      <div className="page-layout">
        {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}

        <section className="page-card mcp-servers-board-card" aria-label="Plugins">
          {loading && !hasRows ? (
            <EmptyState title="Loading" body="Fetching plugins…" />
          ) : !hasRows ? (
            <EmptyState title="No recipes" body="No recipes are deployed in this cluster." />
          ) : (
            <DataTable frameless fullBleed className="mcp-servers-data-table">
              <thead>
                <tr>
                  <th className="da-table__col-header" scope="col">
                    Name
                  </th>
                  <th className="da-table__col-header" scope="col">
                    Status
                  </th>
                  <th className="da-table__col-header" scope="col">
                    Recent Runs
                  </th>
                  <th className="da-table__col-header da-table__col-header--right" scope="col">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {workflows.map(wf => (
                  <WorkflowRow
                    key={workflowKey(wf)}
                    wf={wf}
                    pendingTriggerKey={pendingTriggerKey}
                    onTrigger={w => void handleTrigger(w)}
                  />
                ))}
              </tbody>
            </DataTable>
          )}
        </section>
      </div>

      {triggerModalWorkflow && selectedWorkflowInputContract ? (
        <ConfirmDialog
          title={`Trigger ${triggerModalWorkflow.name}`}
          cancelLabel="Cancel"
          confirmLabel={workflowTriggerLoading ? 'Triggering…' : 'Trigger'}
          onCancel={() => setTriggerModalWorkflow(null)}
          onConfirm={confirmModalTrigger}
          body={
            <InputContractForm
              schema={selectedWorkflowInputContract}
              values={workflowInputValues}
              onChange={setWorkflowInputValues}
              disabled={workflowTriggerLoading}
            />
          }
        />
      ) : null}
    </section>
  )
}
