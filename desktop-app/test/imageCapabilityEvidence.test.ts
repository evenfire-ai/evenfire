import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as evidenceModule from './e2e-playwright/helpers/imageCapabilityEvidence.js'
import {
  FIXTURE_RESPONSE_KIND,
  appendedAttempts,
  parseEvidenceSnapshot,
} from './e2e-playwright/helpers/imageCapabilityEvidence.js'

// The fixture is untyped ESM outside this package; only its reason list is read,
// through a typed dynamic import so the compiler does not resolve the module.
const PROVIDER_MODULE_URL = pathToFileURL(
  path.resolve(__dirname, '../../tests/e2e/fixtures/image-capabilities/provider.mjs')
).href

const RUN_ID = 'image-capabilities-0123456789ab'
const PROFILE = 'clerum-image-fixture-12345678'
const SOURCE = 'unit-test ledger'
const DIGEST = 'a'.repeat(64)

type Row = Record<string, unknown>

const rows = {
  rejected: (): Row => ({
    model: 'glm-5.3',
    imageSha256: null,
    responseKind: 'rejected',
    reason: 'text-model-image-incompatible',
  }),
  read: (): Row => ({
    model: 'glm-5.3-flash',
    imageSha256: null,
    responseKind: 'document-read-requested',
    documentSha256: null,
    documentByteLength: 6_291_456,
  }),
  answer: (): Row => ({
    model: 'glm-5.3-flash',
    imageSha256: null,
    responseKind: 'document-answer',
    documentSha256: DIGEST,
    byteRange: { offset: 0, length: 65_536 },
    truncated: true,
  }),
  textOnly: (): Row => ({ model: 'glm-5.3-flash', imageSha256: null, responseKind: 'text-only' }),
  shellRequested: (): Row => ({
    model: 'glm-5.3-flash',
    imageSha256: null,
    responseKind: 'legacy-lease-shell-requested',
  }),
  legacyAnswer: (): Row => ({
    model: 'glm-5.3-flash',
    imageSha256: null,
    responseKind: 'legacy-lease-answer',
    downloadSha256: DIGEST,
    downloadBytes: 42,
  }),
  shellFailed: (): Row => ({
    model: 'glm-5.3-flash',
    imageSha256: null,
    responseKind: 'legacy-lease-shell-failed',
    failureCode: 'download_busy',
  }),
}

function ledger(attempts: Row[]): string {
  return JSON.stringify({
    runId: RUN_ID,
    profile: PROFILE,
    pid: 41,
    counters: {
      totalAttempts: attempts.length,
      imageAttempts: 0,
      textAttempts: 0,
      rejectedAttempts: 0,
      tileColorResponses: 0,
      textOnlyResponses: 0,
      textModelImageRefusals: 0,
      blockedEgress: 0,
      documentReadRequests: 0,
      documentAnswers: 0,
      documentFailures: 0,
      legacyLeaseShellRequests: 0,
      legacyLeaseDownloadRequests: 0,
      legacyLeaseAnswers: 0,
      legacyLeaseFailures: 0,
    },
    attempts,
  })
}

const parse = (attempts: Row[]) =>
  parseEvidenceSnapshot(ledger(attempts), SOURCE, { runId: RUN_ID, profile: PROFILE })

describe('imageCapabilityEvidence ledger rows', () => {
  it('keeps the rejection reason and the delivered page on the rows that carry them', () => {
    const snapshot = parse([rows.rejected(), rows.read(), rows.answer(), rows.textOnly()])
    expect(snapshot.attempts).toEqual([
      rows.rejected(),
      rows.read(),
      rows.answer(),
      rows.textOnly(),
    ])
  })

  it('requires a closed-set reason on every rejected row and nowhere else', () => {
    // Witness: the well-formed rejected row parses.
    expect(parse([rows.rejected()]).attempts[0]?.reason).toBe('text-model-image-incompatible')
    const { reason: _omitted, ...withoutReason } = rows.rejected()
    for (const [label, row] of [
      ['missing reason', withoutReason],
      ['free-text reason', { ...rows.rejected(), reason: 'prompt said: draw a cat' }],
      ['non-string reason', { ...rows.rejected(), reason: 7 }],
      ['reason on an accepted row', { ...rows.textOnly(), reason: 'unsupported-model' }],
    ] as const) {
      expect(() => parse([row]), label).toThrow(/reason/)
    }
  })

  it('requires the delivered page on every document answer and nowhere else', () => {
    // Witness: the well-formed answer row parses with its page.
    expect(parse([rows.answer()]).attempts[0]?.byteRange).toEqual({ offset: 0, length: 65_536 })
    const { byteRange: _range, ...withoutRange } = rows.answer()
    const { truncated: _flag, ...withoutTruncated } = rows.answer()
    for (const [label, row] of [
      ['missing byteRange', withoutRange],
      ['null byteRange', { ...rows.answer(), byteRange: null }],
      ['array byteRange', { ...rows.answer(), byteRange: [0, 65_536] }],
      ['missing length', { ...rows.answer(), byteRange: { offset: 0 } }],
      ['negative offset', { ...rows.answer(), byteRange: { offset: -1, length: 10 } }],
      ['fractional length', { ...rows.answer(), byteRange: { offset: 0, length: 1.5 } }],
      ['string length', { ...rows.answer(), byteRange: { offset: 0, length: '10' } }],
      ['missing truncated', withoutTruncated],
      ['string truncated', { ...rows.answer(), truncated: 'true' }],
      ['byteRange on a read row', { ...rows.read(), byteRange: { offset: 0, length: 10 } }],
      ['truncated on a read row', { ...rows.read(), truncated: false }],
      ['byteRange on a text row', { ...rows.textOnly(), byteRange: { offset: 0, length: 10 } }],
    ] as const) {
      expect(() => parse([row]), label).toThrow(/byteRange|truncated/)
    }
  })
})

describe('legacy-lease ledger rows', () => {
  it('keeps the failure code and the download receipt on the rows that carry them', () => {
    const snapshot = parse([rows.shellRequested(), rows.legacyAnswer(), rows.shellFailed()])
    expect(snapshot.attempts).toEqual([
      rows.shellRequested(),
      rows.legacyAnswer(),
      rows.shellFailed(),
    ])
  })

  it('requires a closed-set failure code on failure rows and nowhere else', () => {
    // Witness: the well-formed failure row parses with its code.
    expect(parse([rows.shellFailed()]).attempts[0]?.failureCode).toBe('download_busy')
    const { failureCode: _code, ...withoutCode } = rows.shellFailed()
    for (const [label, row] of [
      ['missing failureCode', withoutCode],
      ['free-text failureCode', { ...rows.shellFailed(), failureCode: 'disk on fire' }],
      ['failureCode on an answer row', { ...rows.legacyAnswer(), failureCode: 'download_busy' }],
      ['failureCode on a text row', { ...rows.textOnly(), failureCode: 'download_busy' }],
    ] as const) {
      expect(() => parse([row]), label).toThrow(/failureCode/)
    }
  })

  it('requires the download receipt on every answer row and nowhere else', () => {
    // Witness: the well-formed answer row parses with its receipt.
    expect(parse([rows.legacyAnswer()]).attempts[0]?.downloadBytes).toBe(42)
    const { downloadSha256: _sha, ...withoutSha } = rows.legacyAnswer()
    const { downloadBytes: _bytes, ...withoutBytes } = rows.legacyAnswer()
    for (const [label, row] of [
      ['missing downloadSha256', withoutSha],
      ['short downloadSha256', { ...rows.legacyAnswer(), downloadSha256: 'abc' }],
      ['missing downloadBytes', withoutBytes],
      ['negative downloadBytes', { ...rows.legacyAnswer(), downloadBytes: -1 }],
      ['receipt on a shell row', { ...rows.shellRequested(), downloadSha256: DIGEST }],
    ] as const) {
      expect(() => parse([row]), label).toThrow(/downloadSha256|downloadBytes/)
    }
  })
})

describe('appendedAttempts', () => {
  it('refuses a row whose reason or delivered page changed between reads', () => {
    const before = parse([rows.rejected(), rows.answer()])
    // Witness: an unchanged prefix yields the appended row.
    expect(
      appendedAttempts(before, parse([rows.rejected(), rows.answer(), rows.textOnly()]))
    ).toEqual([rows.textOnly()])
    for (const [label, changed] of [
      ['reason', [{ ...rows.rejected(), reason: 'unsupported-model' }, rows.answer()]],
      ['offset', [rows.rejected(), { ...rows.answer(), byteRange: { offset: 1, length: 65_536 } }]],
      ['length', [rows.rejected(), { ...rows.answer(), byteRange: { offset: 0, length: 65_535 } }]],
      ['truncated', [rows.rejected(), { ...rows.answer(), truncated: false }]],
    ] as const) {
      expect(() => appendedAttempts(before, parse([...changed])), label).toThrow(/append-only/)
    }
  })

  it('refuses a legacy-lease row whose receipt or failure code changed between reads', () => {
    const before = parse([rows.legacyAnswer(), rows.shellFailed()])
    // Witness: an unchanged prefix yields the appended row.
    expect(
      appendedAttempts(before, parse([rows.legacyAnswer(), rows.shellFailed(), rows.textOnly()]))
    ).toEqual([rows.textOnly()])
    for (const [label, changed] of [
      ['sha', [{ ...rows.legacyAnswer(), downloadSha256: 'c'.repeat(64) }, rows.shellFailed()]],
      ['bytes', [{ ...rows.legacyAnswer(), downloadBytes: 43 }, rows.shellFailed()]],
      ['code', [rows.legacyAnswer(), { ...rows.shellFailed(), failureCode: 'writer_locked' }]],
    ] as const) {
      expect(() => appendedAttempts(before, parse([...changed])), label).toThrow(/append-only/)
    }
  })
})

describe('rejection reason parity', () => {
  it('declares the same closed set as the fixture, independently', async () => {
    const providerModule = (await import(PROVIDER_MODULE_URL)) as {
      FIXTURE_REJECTION_REASONS: readonly string[]
    }
    const declared = (evidenceModule as Record<string, unknown>).FIXTURE_REJECTION_REASONS
    expect(Array.isArray(declared)).toBe(true)
    expect(declared).not.toBe(providerModule.FIXTURE_REJECTION_REASONS)
    expect([...(declared as readonly string[])].sort()).toEqual(
      [...providerModule.FIXTURE_REJECTION_REASONS].sort()
    )
    // Witness: the set is not empty, so equality is not two empty lists.
    expect((declared as readonly string[]).length).toBeGreaterThan(0)
    expect(FIXTURE_RESPONSE_KIND.rejected).toBe('rejected')
  })

  it('declares the same legacy-lease failure codes as the fixture, independently', async () => {
    const providerModule = (await import(PROVIDER_MODULE_URL)) as {
      LEGACY_LEASE_FAILURE_CODES: readonly string[]
    }
    const declared = (evidenceModule as Record<string, unknown>).FIXTURE_LEGACY_LEASE_FAILURE_CODES
    expect(Array.isArray(declared)).toBe(true)
    expect(declared).not.toBe(providerModule.LEGACY_LEASE_FAILURE_CODES)
    expect([...(declared as readonly string[])].sort()).toEqual(
      [...providerModule.LEGACY_LEASE_FAILURE_CODES].sort()
    )
    expect(declared as readonly string[]).toContain('download_busy')
  })
})
