import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { normalizeContractBody } from './contractFixture.js'

/**
 * The normalizer replaces the values Profile UI validates with fixed ones, so
 * it must first refuse a raw value Profile UI would refuse; otherwise a broken
 * attempts answer would record as a valid one. The attempts body here is the
 * one the real chain recorded, with its fixed values swapped for raw ones.
 */

const recorded = JSON.parse(
  readFileSync(
    new URL('../fixtures/oidc-desktop-sign-in/control-api.realPostgres.json', import.meta.url),
    'utf8'
  )
) as Record<string, { body: { authorizationUrl: string; expiresAt: string } }>
const recordedAttempt = recorded['POST /external/oidc/profile-flow/attempts desktop-echo']!.body

const NOW = Date.parse('2026-11-25T12:00:00.000Z')
const PARAMETERS = ['state', 'nonce', 'code_challenge'] as const

/** A fresh value of the shape the engine sends for each parameter. */
function rawValue(): string {
  return randomBytes(32).toString('base64url')
}

/** The recorded authorization URL with raw values in place of the fixed ones. */
function rawAuthorizationUrl(): URL {
  const url = new URL(recordedAttempt.authorizationUrl)
  for (const name of PARAMETERS) url.searchParams.set(name, rawValue())
  return url
}

function attemptBody(overrides: Record<string, unknown> = {}) {
  return {
    ...recordedAttempt,
    authorizationUrl: rawAuthorizationUrl().href,
    expiresAt: new Date(NOW + 600_000).toISOString(),
    ...overrides,
  }
}

const BAD_SHAPES: Record<(typeof PARAMETERS)[number], string[]> = {
  state: ['s'.repeat(31), 's'.repeat(513), `${'s'.repeat(42)}.`],
  nonce: ['n'.repeat(31), 'n'.repeat(513), `${'n'.repeat(42)}.`],
  code_challenge: ['c'.repeat(42), 'c'.repeat(44), `${'c'.repeat(42)}.`],
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('normalizeContractBody', () => {
  it('turns a valid raw attempts answer into the recorded one', () => {
    const raw = attemptBody()
    // The raw values differ from the fixed ones the file holds.
    expect(raw.authorizationUrl).not.toBe(recordedAttempt.authorizationUrl)

    expect(normalizeContractBody(raw)).toEqual(recordedAttempt)
    expect(recordedAttempt.expiresAt).toBe('FIXTURE_EXPIRES_AT')
  })

  it('accepts an expiresAt exactly 660 s ahead', () => {
    const raw = attemptBody({ expiresAt: new Date(NOW + 660_000).toISOString() })

    expect(normalizeContractBody(raw)).toMatchObject({ expiresAt: 'FIXTURE_EXPIRES_AT' })
  })

  it.each(PARAMETERS)('refuses an authorizationUrl without %s', name => {
    const url = rawAuthorizationUrl()
    url.searchParams.delete(name)

    expect(() => normalizeContractBody(attemptBody({ authorizationUrl: url.href }))).toThrow(
      `authorizationUrl must carry exactly one ${name}; it carries 0`
    )
  })

  it.each(PARAMETERS)('refuses an authorizationUrl with %s twice', name => {
    const url = rawAuthorizationUrl()
    url.searchParams.append(name, rawValue())

    expect(() => normalizeContractBody(attemptBody({ authorizationUrl: url.href }))).toThrow(
      `authorizationUrl must carry exactly one ${name}; it carries 2`
    )
  })

  it.each(
    PARAMETERS.flatMap(name => BAD_SHAPES[name].map(value => [name, value.length, value] as const))
  )('refuses a %s of a shape Profile UI refuses (%i characters)', (name, _length, value) => {
    const url = rawAuthorizationUrl()
    url.searchParams.set(name, value)

    expect(() => normalizeContractBody(attemptBody({ authorizationUrl: url.href }))).toThrow(
      `authorizationUrl ${name} (${value.length} characters) does not match`
    )
  })

  it.each([
    ['in the past', new Date(NOW - 1_000).toISOString()],
    ['equal to now', new Date(NOW).toISOString()],
    ['more than 660 s ahead', new Date(NOW + 660_001).toISOString()],
  ])('refuses an expiresAt %s', (_name, expiresAt) => {
    expect(() => normalizeContractBody(attemptBody({ expiresAt }))).toThrow(
      'expiresAt must fall within (now, now + 660 s]'
    )
  })

  it('refuses an unparseable expiresAt', () => {
    expect(() => normalizeContractBody(attemptBody({ expiresAt: 'not-a-date' }))).toThrow(
      'expiresAt is not a parseable date'
    )
  })

  it.each([
    ['expiresAt', NOW + 600_000],
    ['authorizationUrl', null],
  ])('refuses a %s that is not a string', (key, value) => {
    expect(() => normalizeContractBody(attemptBody({ [key]: value }))).toThrow(
      `${key} must be a string`
    )
  })
})
