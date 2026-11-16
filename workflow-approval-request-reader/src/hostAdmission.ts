/** Error code of the MCP Host's direct service admission refusal (429). */
export const HOST_ADMISSION_LIMITED_ERROR = 'runtime_service_admission_limited'

/**
 * The Host's wait in seconds when a decision or enrollment result is its
 * admission refusal, as recognised by mcpHostClient.ts; undefined otherwise.
 */
export function hostAdmissionRetryAfter(result: {
  status?: number
  error?: string
  retryAfterSeconds?: number
}): number | undefined {
  return result.status === 429 && result.error === HOST_ADMISSION_LIMITED_ERROR
    ? result.retryAfterSeconds
    : undefined
}
