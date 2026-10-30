/** CLERUM_MODEL_STEP_AUTO_RETRIES when the variable is absent. */
export const MODEL_STEP_AUTO_RETRIES_DEFAULT = 3
/**
 * The nominal wait before each automatic retry of one failed model step.
 * Retry k waits entry k whatever the configured count: three retries wait
 * 5 s in total, five retries 23 s.
 */
export const MODEL_STEP_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  500, 1_500, 3_000, 6_000, 12_000,
])
/** Upper bound of CLERUM_MODEL_STEP_AUTO_RETRIES: one wait per retry. */
export const MODEL_STEP_AUTO_RETRIES_MAX = MODEL_STEP_RETRY_DELAYS_MS.length
/** All model-step retries end 60 s after the first eligible provider_unavailable. */
export const MODEL_STEP_RETRY_DEADLINE_MS = 60_000

/**
 * The wait before retry `retryIndex` (0-based), shortened by up to 20 %.
 * Like Math.random, `random` must return a value in [0, 1). An index outside
 * the sequence or a random value outside that range is a programming error.
 */
export function modelStepRetryDelayMs(retryIndex: number, random: () => number): number {
  const nominal = MODEL_STEP_RETRY_DELAYS_MS[retryIndex]
  if (nominal === undefined)
    throw new RangeError(`no model-step retry wait for index ${retryIndex}`)
  const r = random()
  if (!(r >= 0 && r < 1)) throw new RangeError(`model-step retry jitter source returned ${r}`)
  return Math.round(nominal * (0.8 + 0.2 * r))
}
