/**
 * Deterministic fixture for #731 — a minified JSON tool result of a requested
 * byte size, shaped like what an MCP server actually returns (contact records
 * from a CRM/outreach integration).
 *
 * The payload shape is the point, not the size. A word count under-reads dense
 * minified JSON because whitespace is rare in it: a 33,313-character result of
 * seed 1 splits into 1,522 "words" (~1,980 tokens at the old ×1.3) against
 * ~8,330 at four characters per token. That was the defect `heuristicCount`
 * carried until #731, and the one `heuristicCountTools` documents in
 * `core/tokenizer/heuristic.ts`.
 * A prose fixture of the same byte size does NOT reproduce it: prose carries a
 * space every few characters, so its word count tracks its byte count and the
 * gauge reads it correctly.
 *
 * `minifiedMcpResult.test.ts` (F-1) pins that gap, so substituting a prose
 * fixture later fails loudly instead of silently turning the #731 tests green
 * without a fix.
 *
 * Deterministic by construction: a 32-bit LCG seeded from `seed`, no
 * `Math.random`, no clock. The same (seed, targetBytes) always yields the same
 * string.
 */

/** Numerical Recipes LCG — fixed constants, no global state. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const FIRST_NAMES = ['Joaquin', 'Marta', 'Andrei', 'Priya', 'Tomas', 'Chiara', 'Noor', 'Diego']
const LAST_NAMES = ['La Madrid', 'Neira', 'Okonkwo', 'Vasquez', 'Lindqvist', 'Haddad', 'Rossi']
const TITLES = [
  'Chief Business Officer',
  'Head of Partnerships',
  'VP Revenue Operations',
  'Director of Growth',
  'Founder',
]
const COMPANIES = ['Not a Bot Agency', 'Northwind Labs', 'Veridian Systems', 'Halcyon Data']
const CITIES = ['Alicante', 'Tallinn', 'Lisbon', 'Bristol', 'Valparaiso']
const SENTIMENTS = ['positive', 'neutral', 'requested_followup']

const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]

/**
 * One contact record. Every field is drawn from the LCG, so record `n` of a
 * given seed is stable across runs and machines.
 */
function contact(rnd: () => number, index: number): Record<string, unknown> {
  const first = pick(rnd, FIRST_NAMES)
  const last = pick(rnd, LAST_NAMES)
  const company = pick(rnd, COMPANIES)
  return {
    id: `c_${index}_${Math.floor(rnd() * 1e9).toString(36)}`,
    firstName: first,
    lastName: last,
    headline: `${pick(rnd, TITLES)} at ${company}`,
    linkedinUrl: `https://linkedin.example/in/${first.toLowerCase()}-${last
      .toLowerCase()
      .replace(/ /g, '-')}-${index}`,
    company: {
      name: company,
      domain: `${company.toLowerCase().replace(/[^a-z]/g, '')}.example`,
      location: `${pick(rnd, CITIES)}, ES`,
      employeeCount: 3 + Math.floor(rnd() * 900),
    },
    lastReply: {
      campaignId: `camp_${index}`,
      campaignName: 'Q3 Outbound - SaaS Partners',
      repliedAt: `2026-09-${String(1 + (index % 28)).padStart(2, '0')}T10:22:03.000Z`,
      messageText:
        'Thanks for reaching out, this is relevant for us. Can we book a call next week?',
      sentiment: pick(rnd, SENTIMENTS),
    },
    tags: ['saas', 'partner', `tier-${1 + (index % 3)}`],
    score: Number((rnd() * 100).toFixed(4)),
  }
}

/**
 * A minified JSON tool result of at least `targetBytes` characters.
 *
 * Records are serialized one at a time and the envelope length is computed
 * exactly at each step, so the result overshoots the target by at most one
 * record (555–605 characters for seed 1). F-1 pins the overshoot at +10%.
 */
export function minifiedMcpResult(seed: number, targetBytes: number): string {
  if (!Number.isInteger(seed)) {
    throw new Error(`minifiedMcpResult: seed must be an integer, got ${seed}`)
  }
  if (!Number.isInteger(targetBytes) || targetBytes <= 0) {
    throw new Error(`minifiedMcpResult: targetBytes must be a positive integer, got ${targetBytes}`)
  }

  const rnd = lcg(seed)
  const records: string[] = []
  let recordBytes = 0
  let index = 0

  // Each record is already canonical minified JSON, so the envelope length is
  // arithmetic — no quadratic re-serialization of the growing array.
  const envelope = (parts: string[]): string =>
    `{"contacts":[${parts.join(',')}],"total":${parts.length}}`
  const projectedLength = (): number =>
    OPEN.length + recordBytes + Math.max(records.length - 1, 0) + CLOSE(records.length).length

  for (;;) {
    const record = JSON.stringify(contact(rnd, index++))
    records.push(record)
    recordBytes += record.length
    if (projectedLength() >= targetBytes) break
  }

  return envelope(records)
}

const OPEN = '{"contacts":['
const CLOSE = (n: number): string => `],"total":${n}}`
