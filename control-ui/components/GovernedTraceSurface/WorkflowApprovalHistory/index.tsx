'use client'

import { useEffect, useState } from 'react'
import { getWorkflowRun } from '@lib/api'
import type { WorkflowRunSummary } from '@lib/api'
import { ApprovalPromptEvidence } from '../SessionReplayDetail/ApprovalPromptEvidence'
import { displayTraceValue as display } from '../formatters'

export function WorkflowApprovalHistory({
  namespace,
  name,
  runId,
}: {
  namespace: string
  name: string
  runId: string
}) {
  const [run, setRun] = useState<WorkflowRunSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setRun(null)
    setError(null)
    void getWorkflowRun(namespace, name, runId, controller.signal)
      .then(setRun)
      .catch(readError => {
        if (!controller.signal.aborted) {
          setError(
            readError instanceof Error
              ? readError.message
              : 'Unable to load workflow approval metadata.'
          )
        }
      })
    return () => controller.abort()
  }, [name, namespace, runId])

  if (error) {
    return (
      <div className="cu-banner cu-banner--error" role="alert">
        {error}
      </div>
    )
  }

  if (!run?.approvalRequestId) return null

  const actor = run.actor
  const actorReference = actor?.userId ?? actor?.adminUserId ?? actor?.hostRef ?? null

  return (
    <section className="cu-trace-detail-section" aria-labelledby="workflow-approval-history">
      <div className="cu-trace-detail-section__head">
        <div>
          <h2 id="workflow-approval-history">Workflow approval history</h2>
          <p>Canonical control-api approval evidence for this workflow run.</p>
        </div>
        <span>{run.phase}</span>
      </div>
      <dl className="cu-trace-facts">
        <div>
          <dt>Approval request ID</dt>
          <dd className="cu-trace-monospace">{run.approvalRequestId}</dd>
        </div>
        <div>
          <dt>Workflow run</dt>
          <dd className="cu-trace-monospace">{run.id}</dd>
        </div>
        <div>
          <dt>Actor type</dt>
          <dd>{display(actor?.type)}</dd>
        </div>
        <div>
          <dt>Actor reference</dt>
          <dd>{display(actorReference)}</dd>
        </div>
      </dl>
      <ApprovalPromptEvidence
        approvalRequestId={run.approvalRequestId}
        availability="check_required"
      />
    </section>
  )
}
