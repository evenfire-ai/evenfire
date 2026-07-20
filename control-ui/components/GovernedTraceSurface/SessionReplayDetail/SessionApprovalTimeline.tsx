import type { GovernedTraceApproval } from '@lib/governedTrace'
import type { GovernedTraceSessionSummaryV1 } from '@lib/governedTrace'
import { formatTraceTimestamp } from '../formatters'
import { ApprovalPromptEvidence } from './ApprovalPromptEvidence'
import { SessionDecisionActor } from './SessionDecisionActor'

export function SessionApprovalTimeline({
  approvals,
  human,
}: {
  approvals: readonly GovernedTraceApproval[]
  human: GovernedTraceSessionSummaryV1['human']
}) {
  return (
    <section className="cu-trace-detail-section" aria-labelledby="trace-session-approvals">
      <div className="cu-trace-detail-section__head">
        <h2 id="trace-session-approvals">Approval timeline</h2>
        <span>{approvals.length} loaded</span>
      </div>
      {approvals.length ? (
        <ol className="cu-trace-approval-timeline">
          {approvals.map((approval, index) => (
            <li key={`${approval.approvalRequestId ?? 'legacy'}:${approval.requestedAt}:${index}`}>
              <div className="cu-trace-approval-timeline__marker" data-state={approval.state} />
              <div className="cu-trace-approval-timeline__content">
                <div className="cu-trace-approval-timeline__head">
                  <strong>{approval.state}</strong>
                  <span>
                    {approval.requestedAt
                      ? formatTraceTimestamp(approval.requestedAt)
                      : 'Request time not captured'}
                  </span>
                </div>
                <dl className="cu-trace-facts">
                  <div>
                    <dt>Request ID</dt>
                    <dd className="cu-trace-monospace">
                      {approval.approvalRequestId ?? 'Legacy correlation not captured'}
                    </dd>
                  </div>
                  <div>
                    <dt>Run</dt>
                    <dd className="cu-trace-monospace">{approval.runId}</dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>{approval.source.replaceAll('_', ' ')}</dd>
                  </div>
                  <div>
                    <dt>Tool</dt>
                    <dd>{approval.toolName ?? 'Not captured by legacy producer'}</dd>
                  </div>
                  <div>
                    <dt>Tool type</dt>
                    <dd>
                      {approval.toolKind === 'unclassified'
                        ? 'Unclassified legacy event'
                        : (approval.toolKind?.replaceAll('_', ' ') ??
                          'Not captured by legacy producer')}
                    </dd>
                  </div>
                  <div>
                    <dt>Tool source</dt>
                    <dd>{approval.toolSourceRef ?? 'Not captured by legacy producer'}</dd>
                  </div>
                  <div>
                    <dt>Decision actor</dt>
                    <dd>
                      <SessionDecisionActor
                        actorSub={approval.decisionActorSub}
                        fallback={
                          approval.state === 'requested'
                            ? 'Awaiting human decision'
                            : 'Decision actor not captured by legacy producer'
                        }
                        human={human}
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>Decision time</dt>
                    <dd>
                      {approval.decidedAt ? formatTraceTimestamp(approval.decidedAt) : 'Pending'}
                    </dd>
                  </div>
                  <div>
                    <dt>Observed execution</dt>
                    <dd>
                      {approval.state === 'denied' && approval.observedExecution === 'not_observed'
                        ? 'Not executed (approval denied)'
                        : approval.observedExecution.replaceAll('_', ' ')}
                    </dd>
                  </div>
                </dl>
                <ApprovalPromptEvidence
                  approvalRequestId={approval.approvalRequestId}
                  availability={approval.promptHistory}
                />
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className="cu-empty">No approval requests are associated with this session.</div>
      )}
    </section>
  )
}
