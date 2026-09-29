import { describe, expect, it } from 'vitest'
import { OAUTH_BROKER_NP_TTL_MS, OAuthBrokerDeleteLedger } from './oauthBrokerDeleteLedger'

describe('OAuthBrokerDeleteLedger', () => {
  it('remembers a Secret delete for the recorded generation only', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    expect(ledger.shouldDeleteSecret('r', 4)).toBe(true)
    ledger.recordSecretDelete('r', 4)
    expect(ledger.shouldDeleteSecret('r', 4)).toBe(false)
    expect(ledger.shouldDeleteSecret('r', 5)).toBe(true)
  })

  it('keeps one entry per recipe: a newer generation replaces the older one', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    ledger.recordSecretDelete('r', 4)
    ledger.recordSecretDelete('r', 5)
    // Generations only increase, so the older key is dead weight. Not remembering it
    // is what bounds the ledger at one entry per recipe instead of one per spec edit.
    expect(ledger.shouldDeleteSecret('r', 5)).toBe(false)
    expect(ledger.shouldDeleteSecret('r', 4)).toBe(true)

    ledger.recordPolicyDelete('r', 4, 0)
    ledger.recordPolicyDelete('r', 5, 0)
    expect(ledger.shouldDeletePolicy('r', 5, 1)).toBe(false)
    expect(ledger.shouldDeletePolicy('r', 4, 1)).toBe(true)
  })

  it('does not let one recipe suppress another', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    ledger.recordSecretDelete('a', 1)
    expect(ledger.shouldDeleteSecret('a', 1)).toBe(false)
    expect(ledger.shouldDeleteSecret('a-b', 1)).toBe(true)
    expect(ledger.shouldDeleteSecret('b', 1)).toBe(true)
  })

  it('expires the NetworkPolicy entry after the TTL', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    ledger.recordPolicyDelete('r', 4, 1_000)
    expect(ledger.shouldDeletePolicy('r', 4, 1_000 + OAUTH_BROKER_NP_TTL_MS - 1)).toBe(false)
    expect(ledger.shouldDeletePolicy('r', 4, 1_000 + OAUTH_BROKER_NP_TTL_MS)).toBe(true)
  })

  it('invalidateSecret re-arms only the Secret side; the NetworkPolicy TTL survives', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    ledger.recordSecretDelete('r', 4)
    ledger.recordPolicyDelete('r', 4, 0)
    expect(ledger.shouldDeleteSecret('r', 4)).toBe(false)
    expect(ledger.shouldDeletePolicy('r', 4, 1)).toBe(false)

    ledger.invalidateSecret('r')
    expect(ledger.shouldDeleteSecret('r', 4)).toBe(true)
    expect(ledger.shouldDeletePolicy('r', 4, 1)).toBe(false)
  })

  it('invalidate drops both sides for the named recipe and no other', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    ledger.recordSecretDelete('r', 4)
    ledger.recordPolicyDelete('r', 4, 0)
    ledger.recordSecretDelete('r2', 4)
    ledger.recordPolicyDelete('r2', 4, 0)

    ledger.invalidate('r')
    expect(ledger.shouldDeleteSecret('r', 4)).toBe(true)
    expect(ledger.shouldDeletePolicy('r', 4, 1)).toBe(true)
    expect(ledger.shouldDeleteSecret('r2', 4)).toBe(false)
    expect(ledger.shouldDeletePolicy('r2', 4, 1)).toBe(false)
  })
})
