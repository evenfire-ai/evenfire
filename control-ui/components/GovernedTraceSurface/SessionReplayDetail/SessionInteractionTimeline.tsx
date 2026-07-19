import type { GovernedTraceInteraction } from '@lib/governedTrace'
import type { GovernedTraceSessionSummaryV1 } from '@lib/governedTrace'
import { displayTraceValue as display, formatTraceTimestamp } from '../formatters'
import { SessionDecisionActor } from './SessionDecisionActor'

function displayReleasedValue(value: string | number | boolean | null): string {
  if (value === null) return 'Not recorded'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

export function SessionInteractionTimeline({
  human,
  interactions,
}: {
  human: GovernedTraceSessionSummaryV1['human']
  interactions: readonly GovernedTraceInteraction[]
}) {
  return (
    <section className="cu-trace-detail-section" aria-labelledby="trace-session-interactions">
      <div className="cu-trace-detail-section__head">
        <div>
          <h2 id="trace-session-interactions">Relevant interactions</h2>
          <p>Ordered governed facts grouped by their persisted run and turn references.</p>
        </div>
        <span>{interactions.length} loaded</span>
      </div>
      {interactions.length ? (
        <ol className="cu-trace-timeline" aria-label="Relevant session interactions">
          {interactions.map(interaction => {
            const toolEvent =
              interaction.eventType === 'tool_call' || interaction.eventType === 'approval'
            const decisionApplies = interaction.decision !== 'not_applicable'
            const safeFields = Object.entries(interaction.safeFields).filter(
              ([key, value]) =>
                value !== null && !['tool_name', 'tool_kind', 'tool_source_ref'].includes(key)
            )
            return (
              <li className="cu-trace-timeline__item" key={interaction.eventId}>
                <div className="cu-trace-timeline__time">
                  {formatTraceTimestamp(interaction.occurredAt)}
                </div>
                <div className="cu-trace-timeline__content">
                  <strong>{interaction.eventType}</strong>
                  <span>{display(interaction.outcome)}</span>
                  {decisionApplies ? <span>Decision: {interaction.decision}</span> : null}
                  <dl className="cu-trace-timeline__facts">
                    <div>
                      <dt>Run</dt>
                      <dd>{display(interaction.runId)}</dd>
                    </div>
                    <div>
                      <dt>Stream sequence</dt>
                      <dd>{interaction.streamSequence}</dd>
                    </div>
                    {decisionApplies ? (
                      <div>
                        <dt>Decision actor</dt>
                        <dd>
                          <SessionDecisionActor
                            actorSub={interaction.decisionActorSub}
                            fallback={
                              interaction.decision === 'require_approval'
                                ? 'Awaiting human decision'
                                : 'Not captured by legacy producer'
                            }
                            human={human}
                          />
                        </dd>
                      </div>
                    ) : null}
                    {toolEvent ? (
                      <>
                        <div>
                          <dt>Tool</dt>
                          <dd>{interaction.toolName ?? 'Not captured by legacy producer'}</dd>
                        </div>
                        <div>
                          <dt>Tool type</dt>
                          <dd>
                            {interaction.toolKind === 'unclassified'
                              ? 'Unclassified legacy event'
                              : (interaction.toolKind?.replaceAll('_', ' ') ??
                                'Not captured by legacy producer')}
                          </dd>
                        </div>
                        <div>
                          <dt>Tool source</dt>
                          <dd>{interaction.toolSourceRef ?? 'Not captured by legacy producer'}</dd>
                        </div>
                        <div>
                          <dt>Approval request</dt>
                          <dd>
                            {interaction.approvalRequestId ??
                              (interaction.eventType === 'tool_call'
                                ? 'Not required'
                                : 'Legacy correlation not captured')}
                          </dd>
                        </div>
                      </>
                    ) : null}
                    <div>
                      <dt>Event ID</dt>
                      <dd>{interaction.eventId}</dd>
                    </div>
                    {safeFields.map(([key, value]) => (
                      <div key={key}>
                        <dt>{key.replaceAll('_', ' ')}</dt>
                        <dd>{displayReleasedValue(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </li>
            )
          })}
        </ol>
      ) : (
        <div className="cu-empty">No relevant governed interactions are available.</div>
      )}
    </section>
  )
}
