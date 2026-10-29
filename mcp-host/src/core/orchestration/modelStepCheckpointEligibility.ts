import { LlmError, LlmErrorCode } from '../errors'

/**
 * The provider-native code that makes a failed model step resumable (#1043).
 *
 * `classifyError` maps both `provider_unavailable` and `connection_unavailable`
 * onto a retryable `ModelOverloaded`, so `LlmError.code` cannot tell them apart;
 * the original code survives in `LlmError.providerCode`. Of the two, only an
 * upstream outage (HTTP 503, or a stream that ended without a `success`
 * terminal) qualifies. A connection failure, a rate limit, a client-upgrade
 * refusal, a limit, a cancellation or an unknown outcome is not eligible by
 * itself.
 */
export const MODEL_STEP_ELIGIBLE_PROVIDER_CODE = 'provider_unavailable'

/**
 * True when `error` on its own may leave a resumable model-step checkpoint. The
 * caller still requires at least one confirmed tool result in the turn.
 *
 * This is the eligibility of one error, not the whole `resumable` rule: the
 * automatic model-step retry also keeps a checkpoint resumable when the step
 * began with an eligible failure and its retries ended on another error
 * (`ModelStepCheckpointRecorder.noteModelStepRetry`, F6). A rate limit that
 * arrives on its own therefore keeps today's behaviour.
 */
export function isModelStepCheckpointEligibleError(error: Error): boolean {
  return (
    error instanceof LlmError &&
    error.code === LlmErrorCode.ModelOverloaded &&
    error.retryable === true &&
    error.providerCode === MODEL_STEP_ELIGIBLE_PROVIDER_CODE
  )
}
