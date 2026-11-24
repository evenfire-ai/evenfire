import { expect } from 'vitest'
import { isAbsolute } from 'node:path'

/**
 * The bodies control-api's routes really answer, recorded to a file that the
 * edge's contract test replays. Every value that changes between runs is
 * replaced with a fixed one, so the file only changes when a route's answer
 * does. Most fixed values keep the shape of the value they replace; expiresAt
 * becomes a sentinel each reader re-stamps, and me.picture becomes null. The
 * values Profile UI validates are checked raw first: a value Profile UI would
 * refuse fails the recording instead of being replaced with a valid one.
 */
export type ContractRecord = Readonly<{ status: number; body: unknown }>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** A Desktop sign-in code: 43 base64url characters. Error codes never have this shape. */
const DESKTOP_CODE_RE = /^[A-Za-z0-9_-]{43}$/

/**
 * The authorization request parameters Profile UI's validateAuthorizationUrl
 * checks (profile-ui/app/api/oidc/_flow.ts:382-425), each required exactly
 * once and with these shapes:
 * - state: STATE_RE (:18), applied at :401-402;
 * - code_challenge: :409-410;
 * - nonce: :413-414.
 * The raw value must match its shape; the fixed value replacing it matches
 * the same shape.
 */
const AUTHORIZATION_PARAMETERS: Readonly<Record<string, { shape: RegExp; fixed: string }>> = {
  state: { shape: /^[A-Za-z0-9_-]{32,512}$/, fixed: 'fixture-state-'.padEnd(43, 's') },
  nonce: { shape: /^[A-Za-z0-9_-]{32,512}$/, fixed: 'fixture-nonce-'.padEnd(43, 'n') },
  code_challenge: {
    shape: /^[A-Za-z0-9_-]{43}$/,
    fixed: 'fixture-code-challenge-'.padEnd(43, 'c'),
  },
}

/**
 * Profile UI's start route (profile-ui/app/api/oidc/start/route.ts:32-41)
 * refuses an expiry in the past or more than 660 s ahead: its 600 s browser
 * cookie (OIDC_BROWSER_COOKIE_MAX_AGE_SECONDS, _flow.ts:10) plus 60 s of
 * clock skew (OIDC_BROWSER_CLOCK_SKEW_SECONDS, _flow.ts:12).
 */
const MAX_EXPIRES_AT_AHEAD_MS = 660_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The same value with every object's keys in sorted order, at any depth. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, sortKeys(value[key])])
  )
}

/** Refuses a parameter Profile UI would refuse, then replaces it with its fixed value. */
function fixedAuthorizationUrl(raw: string): string {
  const url = new URL(raw)
  for (const [name, { shape, fixed }] of Object.entries(AUTHORIZATION_PARAMETERS)) {
    const values = url.searchParams.getAll(name)
    if (values.length !== 1) {
      throw new Error(
        `authorizationUrl must carry exactly one ${name}; it carries ${values.length}`
      )
    }
    if (!shape.test(values[0]!)) {
      throw new Error(
        `authorizationUrl ${name} (${values[0]!.length} characters) does not match ${shape}`
      )
    }
    url.searchParams.set(name, fixed)
  }
  return url.href
}

/** Refuses an expiry Profile UI's start route would refuse, then replaces it with the sentinel. */
function fixedExpiresAt(raw: string): string {
  const expires = Date.parse(raw)
  if (!Number.isFinite(expires)) throw new Error('expiresAt is not a parseable date')
  const now = Date.now()
  if (expires <= now || expires > now + MAX_EXPIRES_AT_AHEAD_MS) {
    throw new Error(
      `expiresAt must fall within (now, now + ${MAX_EXPIRES_AT_AHEAD_MS / 1000} s]; it is ${
        (expires - now) / 1000
      } s from now`
    )
  }
  return 'FIXTURE_EXPIRES_AT'
}

function fixtureUuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

/**
 * Replaces every value that changes between runs. Keys are sorted first, at
 * every depth, and UUIDs are then numbered in the order they appear in the
 * sorted body, so the numbering does not depend on the order in which a route
 * wrote its keys. A UUID that appears twice keeps one number.
 *
 * Throws, instead of replacing, when an authorizationUrl's state, nonce or
 * code_challenge is missing, repeated or of a shape Profile UI refuses, or
 * when an expiresAt is unparseable or outside (now, now + 660 s].
 */
export function normalizeContractBody(body: unknown): unknown {
  const uuids = new Map<string, string>()

  function normalizeString(key: string | undefined, value: string): string {
    if (key === 'code' && DESKTOP_CODE_RE.test(value)) return 'f'.repeat(43)
    if (key === 'token') return 'fixture-session-token'
    if (key === 'correlationId') return 'fixture-correlation'
    if (key === 'expiresAt') return fixedExpiresAt(value)
    if (key === 'authorizationUrl') return fixedAuthorizationUrl(value)
    if (UUID_RE.test(value)) {
      const known = uuids.get(value.toLowerCase())
      if (known) return known
      const numbered = fixtureUuid(uuids.size + 1)
      uuids.set(value.toLowerCase(), numbered)
      return numbered
    }
    if (EMAIL_RE.test(value)) return 'member@example.test'
    return value
  }

  function normalize(value: unknown, key: string | undefined): unknown {
    if ((key === 'authorizationUrl' || key === 'expiresAt') && typeof value !== 'string') {
      throw new Error(`${key} must be a string`)
    }
    if (Array.isArray(value)) return value.map(item => normalize(item, undefined))
    if (isRecord(value)) {
      const normalized = Object.fromEntries(
        Object.entries(value).map(([name, inner]) => [name, normalize(inner, name)])
      )
      if (key === 'me') {
        if (typeof normalized.name === 'string') normalized.name = 'Fixture Member'
        if (typeof normalized.teamName === 'string') normalized.teamName = 'Fixture Team'
        if ('picture' in normalized) normalized.picture = null
      }
      return normalized
    }
    return typeof value === 'string' ? normalizeString(key, value) : value
  }

  return normalize(sortKeys(body), undefined)
}

/**
 * Compares the records with the file, or writes the file under `vitest -u`.
 * Under `CI=true` vitest writes nothing: a changed body or a missing file
 * fails. The file ends with a newline, as Prettier's output does.
 */
export async function expectContractFile(
  records: Record<string, ContractRecord>,
  file: string
): Promise<void> {
  if (!isAbsolute(file)) throw new Error(`contract file path must be absolute: ${file}`)
  await expect(`${JSON.stringify(sortKeys(records), null, 2)}\n`).toMatchFileSnapshot(file)
}
