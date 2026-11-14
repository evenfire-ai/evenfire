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

  it('refuses a memory row whose fields changed between reads', () => {
    const before = parse([memoryRows.writeAnswer(), memoryRows.read()])
    // Witness: an unchanged prefix yields the appended row.
    expect(
      appendedAttempts(
        before,
        parse([memoryRows.writeAnswer(), memoryRows.read(), rows.textOnly()])
      )
    ).toEqual([rows.textOnly()])
    for (const [label, changed] of [
      [
        'memoryToolResult',
        [
          { ...memoryRows.writeAnswer(), memoryToolResult: 'Written to memory/other.md (append)' },
          memoryRows.read(),
        ],
      ],
      [
        'searchHitNotePath',
        [memoryRows.writeAnswer(), { ...memoryRows.read(), searchHitNotePath: false }],
      ],
      ['userMessages', [memoryRows.writeAnswer(), { ...memoryRows.read(), userMessages: 2 }]],
    ] as const) {
      expect(() => appendedAttempts(before, parse([...changed])), label).toThrow(/append-only/)
    }
  })
})

const memoryRows = {
  writeRequested: (): Row => ({
    model: 'glm-5.3-flash',
    imageSha256: null,
    responseKind: 'memory-write-requested',
    memoryJourney: 'remember',
  }),
  writeAnswer: (): Row => ({
    model: 'glm-5.3-flash',
    imageSha256: null,
    responseKind: 'memory-write-answer',
    memoryJourney: 'note',
    memoryToolResult: 'Written to memory/release-checklist.md (append)',
  }),
  search: (): Row => ({
    model: 'glm-5.3-flash',
    imageSha256: null,
    responseKind: 'memory-search-requested',
    memoryJourney: 'recall',
    userMessages: 1,
  }),
  read: (): Row => ({
    model: 'glm-5.3-flash',
    imageSha256: null,
    responseKind: 'memory-read-requested',
    memoryJourney: 'recall',
    userMessages: 1,
    searchHitNotePath: true,
  }),
  recall: (): Row => ({
    model: 'glm-5.3-flash',
    imageSha256: null,
    responseKind: 'memory-recall-answer',
    memoryJourney: 'recall',
    userMessages: 1,
    readFoundNote: true,
  }),
}

describe('imageCapabilityEvidence memory-notes rows', () => {
  it('keeps each memory field on the row that carries it', () => {
    const all = [
      memoryRows.writeRequested(),
      memoryRows.writeAnswer(),
      memoryRows.search(),
      memoryRows.read(),
      memoryRows.recall(),
    ]
    expect(parse(all).attempts).toEqual(all)
  })

  it('refuses a memory field that is missing, malformed or on another row kind', () => {
    // Witness: the private-memory result parses.
    expect(
      parse([
        { ...memoryRows.writeAnswer(), memoryToolResult: 'Written to private memory (append)' },
      ]).attempts[0]?.memoryToolResult
    ).toBe('Written to private memory (append)')
    const { memoryJourney: _journey, ...withoutJourney } = memoryRows.writeRequested()
    for (const [label, row] of [
      ['missing journey', withoutJourney],
      ['unknown journey', { ...memoryRows.writeRequested(), memoryJourney: 'forget' }],
      [
        'free-text write result',
        { ...memoryRows.writeAnswer(), memoryToolResult: 'Written to notes the user typed' },
      ],
      ['zero user messages', { ...memoryRows.search(), userMessages: 0 }],
      ['string hit flag', { ...memoryRows.read(), searchHitNotePath: 'yes' }],
      ['journey on a text row', { ...rows.textOnly(), memoryJourney: 'recall' }],
      ['read flag on a search row', { ...memoryRows.search(), readFoundNote: true }],
      ['write result on a request row', { ...memoryRows.writeRequested(), memoryToolResult: 'x' }],
    ] as const) {
      expect(() => parse([row]), label).toThrow(/attempts\[0\]\./)
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
})
