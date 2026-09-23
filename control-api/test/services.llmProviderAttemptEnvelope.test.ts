import { describe, expect, it } from 'vitest'
import { config } from '../src/config.js'
import { GROK_MAX_STREAM_DURATION_MS } from '../src/services/grokProviderAttemptRedemption.js'
import { GROK_EXECUTION_TICKET_TTL_SECONDS } from '../src/services/grokProviderAttemptTicket.js'
import {
  CODEX_ATTEMPT_MAX_LIFETIME_MS,
  CODEX_ATTEMPT_RESERVATION_TTL_SECONDS,
  GROK_ATTEMPT_MAX_LIFETIME_MS,
  GROK_ATTEMPT_RESERVATION_TTL_SECONDS,
  IN_FLIGHT_USAGE_GRACE_MS,
} from '../src/services/llmProviderAttemptEnvelope.js'
import { CODEX_MAX_STREAM_DURATION_MS } from '../src/services/llmProviderAttemptRedemption.js'
import { CODEX_IN_FLIGHT_USAGE_GRACE_MS } from '../src/services/llmProviderAttemptStore.js'
import { CODEX_EXECUTION_TICKET_TTL_SECONDS } from '../src/services/llmProviderAttemptTicket.js'

// One provider attempt lives from authorize until its stream ends: the ticket
// can wait its TTL before the redeem, then the stream runs up to the redeem
// cap. The budget reservation and the in-flight usage grace must both outlast
// that, or spend arrives after the reservation freed the budget headroom.
describe('provider attempt lifetime envelope', () => {
  it('sizes each attempt lifetime as the ticket TTL plus the redeem stream cap', () => {
    // Concrete inputs, read from the modules the ticket issuer and the redeem
    // use, so the lifetime below is checked against values, not the formula.
    expect(CODEX_EXECUTION_TICKET_TTL_SECONDS).toBe(60)
    expect(GROK_EXECUTION_TICKET_TTL_SECONDS).toBe(60)
    expect(CODEX_MAX_STREAM_DURATION_MS).toBe(1_800_000)
    expect(GROK_MAX_STREAM_DURATION_MS).toBe(1_800_000)
    expect(CODEX_ATTEMPT_MAX_LIFETIME_MS).toBe(1_860_000)
    expect(GROK_ATTEMPT_MAX_LIFETIME_MS).toBe(1_860_000)
  })

  it('keeps each attempt reservation alive for the attempt plus the rollup margin', () => {
    // The task-level reservation TTL is the rollup margin added to the lifetime.
    expect(config.budgetReservationTtlSeconds).toBe(300)
    expect(CODEX_ATTEMPT_RESERVATION_TTL_SECONDS).toBe(2160)
    expect(GROK_ATTEMPT_RESERVATION_TTL_SECONDS).toBe(2160)
  })

  it('holds the in-flight usage grace past the longest attempt of either provider', () => {
    expect(IN_FLIGHT_USAGE_GRACE_MS).toBeGreaterThan(CODEX_ATTEMPT_MAX_LIFETIME_MS)
    expect(IN_FLIGHT_USAGE_GRACE_MS).toBeGreaterThan(GROK_ATTEMPT_MAX_LIFETIME_MS)
    expect(IN_FLIGHT_USAGE_GRACE_MS).toBe(2_160_000)
    // The sweepers read the Store constant; it must be this derived value.
    expect(CODEX_IN_FLIGHT_USAGE_GRACE_MS).toBe(IN_FLIGHT_USAGE_GRACE_MS)
  })
})
