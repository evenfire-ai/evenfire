import { describe, expect, it } from 'vitest'
import {
  type CredentialSurface,
  resolveCredentialSurface,
} from '@components/UpdateConnectorCredentials/resolveCredentialSurface'
import type { McpServerCondition } from '@lib/api'
import {
  SECRET_RESOLVED,
  secretFound,
  secretMissingKey,
  secretNotFound,
} from './fixtures/secretResolvedConditions'

// ─── R1-M2: arbitrary-cardinality invariants ───────────────────────────────
//
// The example-based suite in resolveCredentialSurface.test.ts pins the rules
// one scenario at a time, and every scenario it pins uses at most TWO relevant
// SecretResolved conditions. The reviewer reproduced the consequence: mutating
// authority selection to rank only the LAST TWO candidates leaves all 87 tests
// green, because nothing exercises three or more.
//
// This file treats `resolveCredentialSurface` as the pure precedence function
// it is and checks it against an independent REFERENCE MODEL over generated
// inputs of arbitrary cardinality. The reference is written a different way on
// purpose — sort-based selection, and a timestamp validator built from civil
// calendar arithmetic instead of `Date` — so an error shared with the
// implementation cannot cancel out.
//
// Generation is seeded (mulberry32), never `Math.random()`: a red run names the
// seed and iteration and prints the whole case, so it reproduces exactly.
//
// The intentional ORDER-SENSITIVE rule is preserved: on equal rank the LAST
// array entry wins, so permutations are NOT interchangeable and the reference
// encodes the same rule rather than sorting the difference away.

// ─── Reference model ───────────────────────────────────────────────────────

const REFERENCE_RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/**
 * Days between 1970-01-01 and the given proleptic-Gregorian civil date
 * (Howard Hinnant's `days_from_civil`). Used instead of `Date` so the reference
 * shares no arithmetic — and no normalization bug — with the implementation.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const shiftedYear = year - (month <= 2 ? 1 : 0)
  const era = Math.floor(shiftedYear / 400)
  const yearOfEra = shiftedYear - era * 400
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
  return era * 146_097 + dayOfEra - 719_468
}

/** The intended rank: epoch milliseconds, or the oldest possible rank when the
 *  value is not a real instant. Calendar validity is checked by hand. */
function referenceRank(value: unknown): number {
  if (typeof value !== 'string') return Number.NEGATIVE_INFINITY
  const matched = REFERENCE_RFC3339.exec(value)
  if (!matched) return Number.NEGATIVE_INFINITY

  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  const hour = Number(matched[4])
  const minute = Number(matched[5])
  const second = Number(matched[6])
  const fraction = matched[7]
  const offset = matched[8]

  if (month < 1 || month > 12) return Number.NEGATIVE_INFINITY
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]
  if (day < 1 || day > maxDay) return Number.NEGATIVE_INFINITY
  if (hour > 23 || minute > 59 || second > 59) return Number.NEGATIVE_INFINITY

  const millisecond = Number((fraction ?? '').padEnd(3, '0').slice(0, 3))

  let offsetMinutes = 0
  if (offset !== 'Z') {
    const offsetHours = Number(offset.slice(1, 3))
    const offsetMinutePart = Number(offset.slice(4, 6))
    if (offsetHours > 23 || offsetMinutePart > 59) return Number.NEGATIVE_INFINITY
    offsetMinutes = (offset.startsWith('-') ? -1 : 1) * (offsetHours * 60 + offsetMinutePart)
  }

  return (
    daysFromCivil(year, month, day) * 86_400_000 +
    hour * 3_600_000 +
    minute * 60_000 +
    second * 1_000 +
    millisecond -
    offsetMinutes * 60_000
  )
}

/**
 * The intended precedence, implemented by SORTING a copy rather than by a
 * single scan: highest rank last, ties broken by original index so the LAST
 * entry of a tie ends up last. The winner is then the final element.
 */
function referenceResolve(
  conditions: McpServerCondition[] | undefined,
  spec: { managed?: boolean } | undefined
): CredentialSurface {
  const relevant = (conditions ?? [])
    .map((condition, index) => ({ condition, index }))
    .filter(entry => entry.condition.type === SECRET_RESOLVED)

  if (relevant.length === 0) return 'rotate'

  const ordered = [...relevant].sort((left, right) => {
    const leftRank = referenceRank(left.condition.lastTransitionTime)
    const rightRank = referenceRank(right.condition.lastTransitionTime)
    if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1
    return left.index - right.index
  })

  const winner = ordered[ordered.length - 1].condition
  const claimsAbsence = winner.status === 'False' && winner.reason === 'SecretNotFound'
  if (!claimsAbsence) return 'rotate'
  return spec?.managed === false ? 'recipe-owned' : 'set'
}

// ─── Seeded generator ──────────────────────────────────────────────────────

/** mulberry32 — small, deterministic, and reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * Timestamps span every class the resolver distinguishes, and the VALID ones
 * are drawn from a deliberately small pool with duplicates and equivalent
 * offsets, so exact ties are common — that is the only way the positional
 * tie-break gets exercised at all.
 */
const TIMESTAMPS: (string | undefined)[] = [
  // valid, Z, millisecond precision
  '2026-08-06T07:00:00.000Z',
  '2026-08-06T08:00:00.000Z',
  '2026-08-06T09:00:00.000Z',
  '2026-08-06T09:00:00.000Z', // exact duplicate of the above -> guaranteed ties
  // valid, second precision (no fraction)
  '2026-08-06T08:00:00Z',
  // valid, non-Z offsets that resolve to the SAME instant as 08:00Z
  '2026-08-06T10:30:00+02:30',
  '2026-08-06T04:00:00-04:00',
  // valid leap-day
  '2028-02-29T12:00:00.000Z',
  // RFC3339 SYNTAX, invalid calendar. The first two are inside the ISO grammar,
  // so `new Date()` accepts and silently NORMALIZES them (Feb 30 -> Mar 2) —
  // they are what separates strict validation from a bare parse. The rest fall
  // outside the grammar and only pin the regex.
  '2026-02-30T00:00:00.000Z',
  '2027-02-29T12:00:00.000Z', // 2027 is not a leap year
  '2026-13-01T00:00:00.000Z',
  '2026-08-06T25:00:00.000Z',
  '2026-08-06T12:60:00.000Z',
  '2026-08-06T12:00:60.000Z', // leap second
  '2026-08-06T12:00:00+99:00', // out-of-range offset
  // parseable by `Date`, rejected by RFC3339
  '2026-08-07', // date only
  '2026-08-07T12:00:00', // no offset: browser-timezone dependent
  'Aug 7, 2026', // Date.parse accepts, RFC3339 does not
  '2026-08-07 12:00:00Z', // space instead of T
  '', // empty
  undefined, // property absent altogether
]

const STATUSES: McpServerCondition['status'][] = ['True', 'False', 'Unknown']

const REASONS = [
  'SecretFound',
  'SecretNotFound',
  'SecretMissingKey',
  'SecretAccessDenied',
  'ReadError',
  'SecretValidationFailed',
]

/** Types that must never participate in the selection — including near-misses
 *  that a case-insensitive or substring match would wrongly accept. */
const IRRELEVANT_TYPES = [
  'Ready',
  'DeploymentReady',
  'NetworkReady',
  'secretresolved',
  'SecretResolvedd',
  'NotSecretResolved',
]

const SPECS: ({ managed?: boolean } | undefined)[] = [
  { managed: true },
  { managed: false },
  {},
  { managed: undefined },
  undefined,
]

type GeneratedCase = {
  conditions: McpServerCondition[]
  spec: { managed?: boolean } | undefined
  relevantCount: number
}

function makeCondition(
  rand: () => number,
  type: string,
  index: number,
  seq: number
): McpServerCondition {
  const timestamp = TIMESTAMPS[Math.floor(rand() * TIMESTAMPS.length)]
  const condition: Record<string, unknown> = {
    type,
    status: STATUSES[Math.floor(rand() * STATUSES.length)],
    reason: REASONS[Math.floor(rand() * REASONS.length)],
    // Distinct so a failure message identifies exactly which entry won.
    message: `generated condition #${seq} at slot ${index}`,
  }
  // A missing `lastTransitionTime` means the property is ABSENT, not undefined:
  // that is the shape a hand-edited resource actually has.
  if (timestamp !== undefined) condition.lastTransitionTime = timestamp
  return condition as unknown as McpServerCondition
}

/**
 * Relevant cardinality is drawn from a distribution weighted well past two —
 * 3, 4, 5, 6 and 7 relevant conditions all occur — because two is precisely the
 * bound the reviewer's mutant respected.
 */
const RELEVANT_COUNTS = [0, 1, 2, 2, 3, 3, 3, 4, 4, 5, 5, 6, 7]

function generateCase(rand: () => number, seq: number): GeneratedCase {
  const relevantCount = RELEVANT_COUNTS[Math.floor(rand() * RELEVANT_COUNTS.length)]
  const irrelevantCount = Math.floor(rand() * 5)

  const conditions: McpServerCondition[] = []
  for (let i = 0; i < relevantCount; i++) {
    conditions.push(makeCondition(rand, SECRET_RESOLVED, i, seq))
  }
  // Irrelevant conditions are spliced in at RANDOM positions, so they shift the
  // relevant entries' indices and would poison any index-based selection.
  for (let i = 0; i < irrelevantCount; i++) {
    const type = IRRELEVANT_TYPES[Math.floor(rand() * IRRELEVANT_TYPES.length)]
    const at = Math.floor(rand() * (conditions.length + 1))
    conditions.splice(at, 0, makeCondition(rand, type, at, seq))
  }

  return {
    conditions,
    spec: SPECS[Math.floor(rand() * SPECS.length)],
    relevantCount,
  }
}

function describeCase(
  label: string,
  generated: GeneratedCase,
  expected: CredentialSurface,
  actual: CredentialSurface
): string {
  return [
    `${label}`,
    `  expected (reference model): ${expected}`,
    `  actual   (implementation):  ${actual}`,
    `  spec: ${JSON.stringify(generated.spec)}`,
    `  conditions (${generated.conditions.length}, ${generated.relevantCount} relevant):`,
    ...generated.conditions.map(
      (condition, index) =>
        `    [${index}] rank=${referenceRank(condition.lastTransitionTime)} ${JSON.stringify(condition)}`
    ),
  ].join('\n')
}

/** Runs the full invariant battery on one case. Throws with the whole case on
 *  any violation, so a red is reproducible and diagnosable from the output. */
function checkCase(label: string, generated: GeneratedCase): void {
  const { conditions, spec } = generated

  const structureBefore = JSON.stringify(conditions)
  const identityBefore = [...conditions]

  const actual = resolveCredentialSurface(conditions, spec)
  const expected = referenceResolve(conditions, spec)

  if (actual !== expected) {
    throw new Error(
      describeCase(`${label}: disagreed with the reference model`, generated, expected, actual)
    )
  }

  // Determinism: the SAME array must resolve the same way every time. (Two
  // different permutations of a tie legitimately differ — that is the rule.)
  for (let repeat = 0; repeat < 3; repeat++) {
    const again = resolveCredentialSurface(conditions, spec)
    if (again !== actual) {
      throw new Error(describeCase(`${label}: not deterministic`, generated, actual, again))
    }
  }

  // Immutability: the caller's array is React state. No sort, no splice, no
  // reverse — neither the order, the element identity, nor the values.
  if (JSON.stringify(conditions) !== structureBefore) {
    throw new Error(
      `${label}: the conditions array was MUTATED\n  before: ${structureBefore}\n  after:  ${JSON.stringify(conditions)}`
    )
  }
  if (
    conditions.length !== identityBefore.length ||
    identityBefore.some((condition, index) => conditions[index] !== condition)
  ) {
    throw new Error(`${label}: the conditions array was REORDERED (element identity changed)`)
  }
}

// ─── The suites ────────────────────────────────────────────────────────────

const SEEDS = [1, 7, 42, 1337, 20_260_807]
const CASES_PER_SEED = 600

describe('resolveCredentialSurface — reference-model equivalence over generated inputs', () => {
  it('matches the reference model on every generated case', () => {
    let checked = 0
    let highCardinality = 0
    let maxRelevant = 0

    for (const seed of SEEDS) {
      const rand = mulberry32(seed)
      for (let iteration = 0; iteration < CASES_PER_SEED; iteration++) {
        const generated = generateCase(rand, checked)
        checkCase(`seed ${seed} / iteration ${iteration}`, generated)
        checked += 1
        if (generated.relevantCount >= 3) highCardinality += 1
        maxRelevant = Math.max(maxRelevant, generated.relevantCount)
      }
    }

    expect(checked).toBe(SEEDS.length * CASES_PER_SEED)
    // Coverage guard. A generator that quietly stopped producing 3+ relevant
    // conditions would make this whole suite pass while re-opening the exact
    // hole it exists to close, so the shape of the corpus is asserted too.
    expect(maxRelevant).toBeGreaterThanOrEqual(5)
    expect(highCardinality).toBeGreaterThan(checked / 4)
  })

  /**
   * The generated corpus is random; this one is exhaustive. Every array of
   * length 1..4 over a small alphabet chosen so each pair of entries can tie,
   * outrank, or be outranked — 780 cases, all with a known-correct answer.
   *
   * This is what makes 3- and 4-cardinality coverage a fact rather than a
   * property of the PRNG.
   */
  it('matches the reference model on every array of length 1..4 over a tie-rich alphabet', () => {
    // Both valid stamps sit in late February on purpose: see the malformed
    // entry below.
    const T_OLD = '2026-02-27T00:00:00.000Z'
    const T_NEW = '2026-02-28T00:00:00.000Z'
    const alphabet: McpServerCondition[] = [
      secretNotFound({ at: T_OLD }),
      secretFound({ at: T_OLD }),
      secretNotFound({ at: T_NEW }),
      secretFound({ at: T_NEW }),
      // Malformed calendar: shares the oldest rank with every other malformed
      // entry, and must never outrank either valid stamp above.
      //
      // February 30 specifically. Hour 25 and month 13 fall outside the ISO
      // grammar and `new Date()` rejects them outright, so they would NOT
      // distinguish strict validation from a bare parse. February 30 does: it
      // is inside the grammar, `new Date()` normalizes it to March 2, and that
      // ranks it ahead of both valid late-February stamps above.
      { ...secretNotFound({ at: T_NEW }), lastTransitionTime: '2026-02-30T00:00:00.000Z' },
    ]

    let checked = 0
    for (const spec of [{ managed: true }, { managed: false }] as const) {
      for (let length = 1; length <= 4; length++) {
        const total = alphabet.length ** length
        for (let code = 0; code < total; code++) {
          const conditions: McpServerCondition[] = []
          let remaining = code
          for (let slot = 0; slot < length; slot++) {
            conditions.push(alphabet[remaining % alphabet.length])
            remaining = Math.floor(remaining / alphabet.length)
          }
          checkCase(`exhaustive length ${length} / code ${code}`, {
            conditions,
            spec,
            relevantCount: length,
          })
          checked += 1
        }
      }
    }
    expect(checked).toBe(2 * (5 + 25 + 125 + 625))
  })
})

describe('resolveCredentialSurface — R1-M2 named regressions', () => {
  // THE REVIEWER'S COUNTEREXAMPLE. Ranking only the LAST TWO candidates drops
  // the newest condition — the clean resolution — and returns 'set', re-opening
  // POST against a Secret that exists.
  it('ranks ALL relevant conditions, not just the last two', () => {
    const conditions = [
      secretFound({ at: '2026-08-06T09:00:00.000Z' }),
      secretNotFound({ at: '2026-08-06T07:00:00.000Z' }),
      secretNotFound({ at: '2026-08-06T08:00:00.000Z' }),
    ]
    expect(resolveCredentialSurface(conditions, { managed: true })).toBe('rotate')
    expect(referenceResolve(conditions, { managed: true })).toBe('rotate')
    // Same counterexample on a WRC-owned connector: still no create form.
    expect(resolveCredentialSurface(conditions, { managed: false })).toBe('rotate')
  })

  // The mirror image: the newest IS the absence claim, and it sits FIRST behind
  // four newer-looking-but-older entries. A bounded selector misses it and
  // leaves the operator on a rotate form whose PUT can only 404.
  it('finds the newest absence claim when it is buried at the head of five', () => {
    const conditions = [
      secretNotFound({ at: '2026-08-06T09:00:00.000Z' }),
      secretFound({ at: '2026-08-06T05:00:00.000Z' }),
      secretMissingKey({ at: '2026-08-06T06:00:00.000Z' }),
      secretFound({ at: '2026-08-06T07:00:00.000Z' }),
      secretMissingKey({ at: '2026-08-06T08:00:00.000Z' }),
    ]
    expect(resolveCredentialSurface(conditions, { managed: true })).toBe('set')
    expect(resolveCredentialSurface(conditions, { managed: false })).toBe('recipe-owned')
    expect(referenceResolve(conditions, { managed: true })).toBe('set')
  })

  // Seven relevant conditions with the decisive one in the middle, bracketed by
  // irrelevant types that carry the newest timestamps in the array.
  it('ranks the middle of seven correctly with newer irrelevant types around it', () => {
    const newest = '2026-08-06T23:00:00.000Z'
    const conditions: McpServerCondition[] = [
      {
        type: 'Ready',
        status: 'False',
        reason: 'SecretNotFound',
        message: '',
        lastTransitionTime: newest,
      },
      secretFound({ at: '2026-08-06T01:00:00.000Z' }),
      secretMissingKey({ at: '2026-08-06T02:00:00.000Z' }),
      secretFound({ at: '2026-08-06T03:00:00.000Z' }),
      secretNotFound({ at: '2026-08-06T10:00:00.000Z' }),
      secretFound({ at: '2026-08-06T04:00:00.000Z' }),
      secretMissingKey({ at: '2026-08-06T05:00:00.000Z' }),
      secretFound({ at: '2026-08-06T06:00:00.000Z' }),
      {
        type: 'DeploymentReady',
        status: 'False',
        reason: 'SecretNotFound',
        message: '',
        lastTransitionTime: newest,
      },
    ]
    expect(resolveCredentialSurface(conditions, { managed: true })).toBe('set')
    expect(referenceResolve(conditions, { managed: true })).toBe('set')
  })

  // The positional tie-break across FOUR equally-ranked entries: the last one
  // decides, and flipping which verdict sits last flips the surface.
  it('breaks a four-way exact tie on the LAST entry', () => {
    const at = '2026-08-06T09:00:00.000Z'
    const absentLast = [
      secretFound({ at }),
      secretMissingKey({ at }),
      secretFound({ at }),
      secretNotFound({ at }),
    ]
    const resolvedLast = [
      secretNotFound({ at }),
      secretMissingKey({ at }),
      secretNotFound({ at }),
      secretFound({ at }),
    ]
    expect(resolveCredentialSurface(absentLast, { managed: true })).toBe('set')
    expect(resolveCredentialSurface(resolvedLast, { managed: true })).toBe('rotate')
    expect(referenceResolve(absentLast, { managed: true })).toBe('set')
    expect(referenceResolve(resolvedLast, { managed: true })).toBe('rotate')
  })

  // Five malformed timestamps all share the oldest rank, so this is a five-way
  // tie resolved positionally — and none of them may outrank the valid stamp.
  it('keeps every malformed timestamp below a valid one, however many there are', () => {
    const malformed = [
      '2026-02-30T00:00:00.000Z',
      '2026-13-01T00:00:00.000Z',
      '2026-08-06T25:00:00.000Z',
      'not-a-timestamp',
      '',
    ].map(lastTransitionTime => ({
      ...secretNotFound({ at: '2026-08-06T01:00:00.000Z' }),
      lastTransitionTime,
    }))
    const valid = secretFound({ at: '2020-01-01T00:00:00.000Z' })
    expect(resolveCredentialSurface([...malformed, valid], { managed: true })).toBe('rotate')
    expect(resolveCredentialSurface([valid, ...malformed], { managed: true })).toBe('rotate')
    expect(referenceResolve([...malformed, valid], { managed: true })).toBe('rotate')
  })
})

describe('resolveCredentialSurface — the caller’s array is read-only', () => {
  // A frozen array makes an in-place sort THROW rather than silently reorder,
  // which pins the no-mutation rule independently of the snapshot comparison.
  it('resolves a deep-frozen conditions array without throwing', () => {
    const conditions = Object.freeze(
      [
        secretFound({ at: '2026-08-06T09:00:00.000Z' }),
        secretNotFound({ at: '2026-08-06T07:00:00.000Z' }),
        secretMissingKey({ at: '2026-08-06T08:00:00.000Z' }),
        secretNotFound({ at: '2026-08-06T06:00:00.000Z' }),
      ].map(condition => Object.freeze(condition))
    ) as unknown as McpServerCondition[]

    expect(() => resolveCredentialSurface(conditions, { managed: true })).not.toThrow()
    expect(resolveCredentialSurface(conditions, { managed: true })).toBe('rotate')
  })
})
