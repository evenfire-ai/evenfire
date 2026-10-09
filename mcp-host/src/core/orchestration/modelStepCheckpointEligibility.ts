import { LlmError, LlmErrorCode } from '../errors'

/**
 * The provider-native code that makes a failed model step resumable (#1043).
 *
 * `classifyError` maps both `provider_unavailable` and `connection_unavailable`
 * onto a retryable `ModelOverloaded`, so `LlmError.code` cannot tell them apart;
 * the original code survives in `LlmError.providerCode`. Only an upstream outage
 * (HTTP 503, or a stream that ended without a `success` terminal) qualifies. A
 * connection failure, a rate limit, a client-upgrade refusal, a limit, a
 * cancellation or an unknown outcome keeps today's behaviour.
 */
export const MODEL_STEP_ELIGIBLE_PROVIDER_CODE = 'provider_unavailable'

/**
 * True when a loop error may leave a resumable model-step checkpoint. The
 * caller still requires at least one confirmed tool result in the turn.
 */
export function isModelStepCheckpointEligibleError(error: Error): boolean {
  return (
    error instanceof LlmError &&
    error.code === LlmErrorCode.ModelOverloaded &&
    error.retryable === true &&
    error.providerCode === MODEL_STEP_ELIGIBLE_PROVIDER_CODE
  )
}
