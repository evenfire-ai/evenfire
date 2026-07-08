import { Fragment, useState } from 'react'
import { Button, EmptyState, Pill, StatusBanner } from '@components/Common'
import { IconWorkflows } from '@components/SidebarNav/icons'
import type { WorkflowRunArtifact } from '../../../src/types'
import { InputContractForm } from '../components/InputContractForm'
import { useAuthContext } from '../contexts/AuthContext'
import { useWorkflowController } from '../hooks/domain/useWorkflowController'
import { formatRelativeTime } from '../lib/format'
import { describePluginWorkloadSdkCapability, workflowStatusTone } from '../lib/workflowStatus'

export function WorkflowsPage() {
  const { setStatus } = useAuthContext()
  const [downloadingArtifact, setDownloadingArtifact] = useState<string | null>(null)
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const {
    workflowsLoading: loading,
    workflows,
    selectedWorkflow,
    selectedWorkflowInputContract,
    selectedWorkflowSdkCapability,
    workflowInputValues,
    setWorkflowInputValues,
    workflowRuns,
    workflowRunsLoading,
    workflowTriggerLoading,
    workflowsError: error,
    handleSelectWorkflow,
    handleTriggerWorkflow,
    handleRefreshSelectedWorkflow,
  } = useWorkflowController({ setStatus })

  async function handleDownloadRunArtifact(runId: string, artifact: WorkflowRunArtifact) {
    if (!selectedWorkflow) return
    const downloadKey = `${runId}:${artifact.name}`
    setDownloadingArtifact(downloadKey)
    setDownloadNotice(null)
    setDownloadError(null)
    try {
      const result = await window.clerum.workflows.downloadRunArtifact(
        selectedWorkflow.namespace,
        selectedWorkflow.name,
        runId,
        artifact.name
      )
      setDownloadNotice(`Saved ${result.filename || artifact.name} to Downloads.`)
    } catch (downloadError) {
      setDownloadError(
        `Download failed: ${
          downloadError instanceof Error ? downloadError.message : String(downloadError)
        }`
      )
    } finally {
      setDownloadingArtifact(null)
    }
  }

  if (loading && !workflows.length) {
    return (
      <section className="page">
        <div className="page-header">
          <h2>Plugins</h2>
          <p className="muted">
            View deployed recipes. Select one to see recent runs or trigger it.
          </p>
        </div>
        <section className="page-card">
          <EmptyState title="Loading" body="Fetching plugins..." />
        </section>
      </section>
    )
  }

  if (error && !workflows.length) {
    return (
      <section className="page">
        <div className="page-header">
          <h2>Plugins</h2>
          <p className="muted">
            View deployed recipes. Select one to see recent runs or trigger it.
          </p>
        </div>
        <section className="page-card" role="alert">
          <div className="composer-error">
            <p className="error-text">{error}</p>
          </div>
        </section>
      </section>
    )
  }

  if (!workflows.length) {
    return (
      <section className="page">
        <div className="page-header">
          <h2>Plugins</h2>
          <p className="muted">
            View deployed recipes. Select one to see recent runs or trigger it.
          </p>
        </div>
        <section className="page-card">
          <EmptyState title="No recipes" body="No recipes are deployed in this cluster." />
        </section>
      </section>
    )
  }

  return (
    <section className="page">
      <div className="page-header">
        <h2>Plugins</h2>
        <p className="muted">View deployed recipes. Select one to see recent runs or trigger it.</p>
      </div>

      {error && (
        <section className="page-card" role="alert">
          <div className="composer-error">
            <p className="error-text">{error}</p>
          </div>
        </section>
      )}

      <div className="page-layout">
        <section className="page-card workflows-list-card">
          <div
            className="da-grid"
            style={{
              '--da-grid-cols': 'minmax(0, 1fr) minmax(112px, 0.18fr)',
            }}
          >
            <div className="da-grid__head">
              <span className="da-grid__col-header">Name</span>
              <span className="da-grid__col-header da-grid__col-header--center">Status</span>
            </div>
            <div className="da-grid__body">
              {workflows.map(wf => {
                const isSelected =
                  selectedWorkflow?.namespace === wf.namespace && selectedWorkflow?.name === wf.name
                return (
                  <Fragment key={`${wf.namespace}/${wf.name}`}>
                    <button
                      type="button"
                      className={`da-grid__row da-grid__row--clickable${
                        isSelected ? ' da-grid__row--selected workflow-row--expanded' : ''
                      }`}
                      onClick={() => void handleSelectWorkflow(wf)}
                    >
                      <span className="context-id-cell workflow-plugin-title">
                        <span className="agent-row-icon" aria-hidden="true">
                          <IconWorkflows />
                        </span>
                        <strong>{wf.name}</strong>
                      </span>
                      <span className={`context-access-pill ${workflowStatusTone(wf.status)}`}>
                        {wf.status || 'Unknown'}
                      </span>
                    </button>

                    {isSelected && selectedWorkflow && (
                      <section
                        className="workflows-detail-card workflows-detail-extension"
                        aria-label={`${selectedWorkflow.name} details`}
                      >
                        <div className="workflows-detail-extension__header">
                          <div className="workflows-detail-extension__title-group">
                            <h3 className="workflows-detail-extension__title">Details</h3>
                            {(() => {
                              const sdk = describePluginWorkloadSdkCapability(
                                selectedWorkflowSdkCapability
                              )
                              return sdk ? (
                                <Pill tone={sdk.tone} size="xs" title={sdk.title}>
                                  {sdk.label}
                                </Pill>
                              ) : null
                            })()}
                          </div>
                          <div className="action-row">
                            <Button
                              onClick={() => {
                                if (!selectedWorkflow.triggerableByUser) return
                                void handleTriggerWorkflow(
                                  selectedWorkflow.namespace,
                                  selectedWorkflow.name
                                )
                              }}
                              disabled={
                                workflowTriggerLoading || !selectedWorkflow.triggerableByUser
                              }
                              color="neutral"
                              size="xs"
                              title={
                                selectedWorkflow.triggerableByUser
                                  ? 'Trigger recipe'
                                  : 'This recipe does not declare an on-demand user trigger'
                              }
                              variant="ghost"
                            >
                              {workflowTriggerLoading ? 'Triggering...' : 'Trigger'}
                            </Button>
                            <Button
                              onClick={() => void handleRefreshSelectedWorkflow()}
                              disabled={loading}
                              color="neutral"
                              size="xs"
                              variant="ghost"
                            >
                              Refresh
                            </Button>
                          </div>
                        </div>

                        {selectedWorkflowInputContract && (
                          <InputContractForm
                            schema={selectedWorkflowInputContract}
                            values={workflowInputValues}
                            onChange={setWorkflowInputValues}
                            disabled={workflowTriggerLoading}
                          />
                        )}

                        {downloadNotice && <StatusBanner text={downloadNotice} tone="success" />}
                        {downloadError && <StatusBanner text={downloadError} tone="error" />}

                        <div className="workflows-detail-extension__section">
                          <h4>Recent Runs</h4>
                          {workflowRunsLoading && !workflowRuns.length && (
                            <p className="muted">Loading runs...</p>
                          )}
                          {!workflowRunsLoading && !workflowRuns.length && (
                            <p className="muted">No runs recorded yet.</p>
                          )}
                          {workflowRuns.length > 0 && (
                            <div className="context-resource-list">
                              {workflowRuns.map(run => (
                                <div
                                  key={run.id}
                                  className="context-resource-row workflow-run-row"
                                  data-testid="workflow-run-row"
                                >
                                  <div className="workflow-run-main">
                                    <div>
                                      <strong>{run.id.slice(0, 8)}</strong>
                                      <p className="muted">
                                        {run.startedAt
                                          ? formatRelativeTime(run.startedAt)
                                          : run.triggeredAt
                                            ? formatRelativeTime(run.triggeredAt)
                                            : 'Pending'}
                                      </p>
                                    </div>
                                    {run.artifacts && run.artifacts.length > 0 && (
                                      <div
                                        className="workflow-run-artifacts"
                                        aria-label="Run artifacts"
                                      >
                                        {run.artifacts.map(artifact => {
                                          const downloadKey = `${run.id}:${artifact.name}`
                                          return (
                                            <Button
                                              key={artifact.name}
                                              className="workflow-run-artifact-btn"
                                              onClick={() =>
                                                void handleDownloadRunArtifact(run.id, artifact)
                                              }
                                              disabled={downloadingArtifact === downloadKey}
                                              color="neutral"
                                              size="xs"
                                              variant="ghost"
                                            >
                                              {downloadingArtifact === downloadKey
                                                ? 'Downloading...'
                                                : artifact.name}
                                            </Button>
                                          )
                                        })}
                                      </div>
                                    )}
                                  </div>
                                  <span
                                    className={`context-access-pill ${workflowStatusTone(
                                      run.phase
                                    )}`}
                                  >
                                    {run.phase}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </section>
                    )}
                  </Fragment>
                )
              })}
            </div>
          </div>
        </section>
      </div>
    </section>
  )
}
