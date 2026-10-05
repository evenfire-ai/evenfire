import type { AuthorizeBodyAdmissionPolicy } from './llmProviderAttemptBodyAdmission.js'

// Ships as an explicit uncertified ceiling; see #813. The combined
// authorize/GFS workload has not yet selected and recorded a count, deadlines,
// heap policy and non-heap margin below 768 MiB in three fresh cgroups.
// The policy is process-wide; every Node worker needs its own measured budget.
//
// It governs only the retained path: bodies declared above the text authorize
// envelope, chunked bodies and unparseable lengths. Text-only authorizes are
// bounded by their own parser limit and never take a unit (see the route).
//
// maxQueued, maxPerPrincipal and queueWaitMs bound latency and fairness, not
// memory: queued requests are paused before any body read. Two waiters allow
// one same-principal overlap plus one other principal; the running+queued
// share stops one principal holding all three positions. queueWaitMs is the
// longest a healthy holder can keep the unit (its read deadline plus its work
// deadline), so a waiter is refused only when the holder outlives both.
const READ_DEADLINE_MS = 10_000
const WORK_DEADLINE_MS = 30_000

export const LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY: AuthorizeBodyAdmissionPolicy = Object.freeze({
  maxInFlight: 1,
  maxQueued: 2,
  maxPerPrincipal: 2,
  queueWaitMs: READ_DEADLINE_MS + WORK_DEADLINE_MS,
  readDeadlineMs: READ_DEADLINE_MS,
  workDeadlineMs: WORK_DEADLINE_MS,
  closeGraceMs: 250,
})
