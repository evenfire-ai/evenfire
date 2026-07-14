import { useCallback, useEffect, useState } from 'react'
import type { WorkflowRunArtifact } from '../../../src/types'

type WorkflowRunArtifactActionsProps = {
  workflow: {
    namespace: string
    name: string
    label: string
    runId: string
    requestedAt?: number
  }
}

type RunArtifacts = {
  runId: string
  artifacts: WorkflowRunArtifact[]
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function WorkflowRunArtifactActions({ workflow }: WorkflowRunArtifactActionsProps) {
  const [runArtifacts, setRunArtifacts] = useState<RunArtifacts | null>(null)
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const loadArtifacts = useCallback(async () => {
    setLoading(true)
    setMessage(null)
    try {
      const result = await window.clerum.workflows.listRunArtifacts(
        workflow.namespace,
        workflow.name,
        workflow.runId
      )
      setRunArtifacts({ runId: workflow.runId, artifacts: result.artifacts || [] })
    } catch (error) {
      setRunArtifacts(null)
      setMessage(`Could not load workflow artifacts: ${getErrorMessage(error)}`)
    } finally {
      setLoading(false)
    }
  }, [workflow.name, workflow.namespace, workflow.runId])

  useEffect(() => {
    void loadArtifacts()
  }, [loadArtifacts])

  async function downloadArtifact(artifact: WorkflowRunArtifact) {
    if (!runArtifacts) return
    setDownloading(artifact.name)
    setMessage(null)
    try {
      const result = await window.clerum.workflows.downloadRunArtifact(
        workflow.namespace,
        workflow.name,
        runArtifacts.runId,
        artifact.name
      )
      setMessage(`Saved ${result.filename} to Downloads.`)
    } catch (error) {
      setMessage(`Could not download ${artifact.name}: ${getErrorMessage(error)}`)
    } finally {
      setDownloading(null)
    }
  }

  return (
    <section
      className="workflow-run-artifacts"
      aria-label={`${workflow.label} artifacts`}
      data-testid="workflow-chat-artifacts"
    >
      <header className="workflow-run-artifacts__header">
        <span>Workflow results</span>
        {runArtifacts ? (
          <span className="muted" data-testid="workflow-chat-run-id">
            Results ready
          </span>
        ) : null}
        <button
          type="button"
          className="ghost-btn mini-btn"
          onClick={() => void loadArtifacts()}
          disabled={loading}
        >
          {loading ? 'Checking...' : 'Refresh'}
        </button>
      </header>
      {runArtifacts?.artifacts.length ? (
        <div className="workflow-run-artifacts__list">
          {runArtifacts.artifacts.map(artifact => (
            <button
              key={artifact.name}
              type="button"
              className="workflow-run-artifact-btn"
              data-testid="workflow-chat-artifact-download"
              onClick={() => void downloadArtifact(artifact)}
              disabled={downloading === artifact.name}
            >
              {downloading === artifact.name ? 'Downloading...' : `Download ${artifact.name}`}
            </button>
          ))}
        </div>
      ) : (
        <p className="workflow-run-artifacts__empty muted">
          {loading ? 'Checking workflow results...' : 'No downloadable workflow results yet.'}
        </p>
      )}
      {message ? <p className="workflow-run-artifacts__message">{message}</p> : null}
    </section>
  )
}
