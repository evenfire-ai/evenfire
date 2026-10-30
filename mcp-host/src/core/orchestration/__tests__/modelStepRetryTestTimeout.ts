import {
  MODEL_STEP_AUTO_RETRIES_DEFAULT,
  MODEL_STEP_RETRY_DELAYS_MS,
} from '../modelStepRetrySchedule'

/** Real-timer tests keep the production retry waits and allow load margin. */
export const AUTO_RETRY_TEST_TIMEOUT_MS =
  3 *
  MODEL_STEP_RETRY_DELAYS_MS.slice(0, MODEL_STEP_AUTO_RETRIES_DEFAULT).reduce(
    (total, delayMs) => total + delayMs,
    0
  )
