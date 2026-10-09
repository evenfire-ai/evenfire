import { Button, StatusBanner } from '@components/Common'
import {
  MODEL_STEP_BLOCKED_REASON_LABELS,
  MODEL_STEP_RESEND_HINT,
  MODEL_STEP_RETRY_LABEL,
} from '@constants/agents'
import type { ModelStepRetryNoticeProps } from './ModelStepRetryNotice.types'

function toolCallCount(count: number): string {
  return `${count} tool call${count === 1 ? '' : 's'}`
}

/**
 * #1044 — the persistent notice for a model-step checkpoint of the active chat.
 *
 * - `resumable`: the turn stopped before its next model step. The completed
 *   tool calls are kept on the Host, and **Retry model step** continues from
 *   there (it is not Resend: no second user message, no tool re-run).
 * - `blocked`: the Host cannot continue the turn; the notice says why and
 *   points at sending the message again (Resend), its only way forward.
 * - `claimed`: the continuation is running and its progress stepper is the
 *   surface, so the notice renders nothing.
 * - no checkpoint after a `not_found` retry answer: the Host no longer holds
 *   the step (abandoned or expired); the notice says so until the next send.
 */
export function ModelStepRetryNotice({ checkpoint, retry, onRetry }: ModelStepRetryNoticeProps) {
  if (!checkpoint) {
    if (!retry?.unavailable) return null
    return (
      <section
        className="model-step-retry-notice"
        aria-label="Model step checkpoint"
        data-testid="model-step-retry-notice"
        data-status="unavailable"
      >
        <StatusBanner tone="error" compact>
          <span>This model step can no longer be retried. {MODEL_STEP_RESEND_HINT}</span>
        </StatusBanner>
      </section>
    )
  }
  if (checkpoint.status === 'blocked') {
    const reason = checkpoint.blockedReason
      ? MODEL_STEP_BLOCKED_REASON_LABELS[checkpoint.blockedReason]
      : undefined
    return (
      <section
        className="model-step-retry-notice"
        aria-label="Model step checkpoint"
        data-testid="model-step-retry-notice"
        data-status="blocked"
      >
        <StatusBanner tone="error" compact>
          <span>
            This turn cannot continue.{reason ? ` ${reason}` : ''} {MODEL_STEP_RESEND_HINT}
          </span>
        </StatusBanner>
      </section>
    )
  }
  if (checkpoint.status !== 'resumable' || !checkpoint.retryAvailable) return null

  const { confirmed, unknown } = checkpoint.tools
  const pending = retry?.pending === true
  return (
    <section
      className="model-step-retry-notice"
      aria-label="Model step checkpoint"
      data-testid="model-step-retry-notice"
      data-status="resumable"
    >
      <StatusBanner tone="warn" compact>
        <span>
          The provider was unavailable before this turn finished.{' '}
          {confirmed > 0
            ? `${toolCallCount(confirmed)} already completed and will not run again.`
            : 'No tool call will run again.'}
          {unknown > 0
            ? ` ${toolCallCount(unknown)} ended without a recorded result and will not be repeated.`
            : ''}
        </span>
      </StatusBanner>
      {retry?.error ? (
        <p className="model-step-retry-notice__error" role="alert">
          {retry.error}
        </p>
      ) : null}
      <div className="model-step-retry-notice__footer">
        <Button
          className="model-step-retry-notice__action"
          data-testid="model-step-retry-btn"
          variant="soft"
          color="primary"
          size="sm"
          loading={pending}
          onClick={onRetry}
        >
          {MODEL_STEP_RETRY_LABEL}
        </Button>
      </div>
    </section>
  )
}
