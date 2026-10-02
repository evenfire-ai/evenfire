import type { AuthorizeBodyAdmissionPolicy } from './llmProviderAttemptBodyAdmission.js'

// Experimental candidate for the authorized PR #806 cgroup calibration.
// These values are not certified for deployment. Keep this candidate local
// and unpublished until the combined authorize/GFS workload selects and
// records a count, deadlines, heap policy and non-heap margin below 768 MiB.
// The policy is process-wide; every Node worker needs its own measured budget.
export const LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY: AuthorizeBodyAdmissionPolicy = Object.freeze({
  maxInFlight: 1,
  readDeadlineMs: 10_000,
  workDeadlineMs: 30_000,
  closeGraceMs: 250,
})
