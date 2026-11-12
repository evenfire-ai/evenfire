import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONFIG, DEFAULT_APPROVAL_TIMEOUT_MS } from '../agent/types'
import { parseApprovalTimeoutMs } from '../config'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

describe('CLERUM_APPROVAL_TIMEOUT', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults to 7 days when unset', () => {
    vi.stubEnv('CLERUM_APPROVAL_TIMEOUT', undefined)
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBe(SEVEN_DAYS_MS)
    expect(parseApprovalTimeoutMs()).toBe(SEVEN_DAYS_MS)
  })

  it('uses the same default for an agent built without an explicit timeout', () => {
    expect(DEFAULT_AGENT_CONFIG.approvalTimeout).toBe(SEVEN_DAYS_MS)
  })

  it.each([
    ['0', 0],
    ['600000', 600_000],
    ['2147483647', 2_147_483_647],
  ])('accepts %s', (raw, expected) => {
    vi.stubEnv('CLERUM_APPROVAL_TIMEOUT', raw)
    expect(parseApprovalTimeoutMs()).toBe(expected)
  })

  it.each(['', 'abc', '-1', '1.5', '10m', '2147483648'])('stops startup on %j', raw => {
    vi.stubEnv('CLERUM_APPROVAL_TIMEOUT', raw)
    expect(() => parseApprovalTimeoutMs()).toThrow(
      'CLERUM_APPROVAL_TIMEOUT must be a valid bounded integer from 0 to 2147483647 (inclusive)'
    )
  })
})
