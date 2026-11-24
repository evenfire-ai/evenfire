import { expect } from 'vitest'
import { isAbsolute } from 'node:path'

/**
 * The bodies control-api's routes really answer, recorded to a file that the
 * edge's contract test replays. Every value that changes between runs is
 * replaced with a fixed one of the same shape, so the file only changes when
 * a route's answer does.
 */
export type ContractRecord = Readonly<{ status: number; body: unknown }>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** A Desktop sign-in code: 43 base64url characters. Error codes never have this shape. */
const DESKTOP_CODE_RE = /^[A-Za-z0-9_-]{43}$/

/**
 * Fixed authorization request parameters, each of the shape Profile UI's
 * validateAuthorizationUrl accepts: state and nonce 32 to 512 base64url
 * characters, code_challenge exactly 43.
 */
const AUTHORIZATION_PARAMETERS: Readonly<Record<string, string>> = {
  state: 'fixture-state-'.padEnd(43, 's'),
  nonce: 'fixture-nonce-'.padEnd(43, 'n'),
  code_challenge: 'fixture-code-challenge-'.padEnd(43, 'c'),
}

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

function fixedAuthorizationUrl(raw: string): string {
  const url = new URL(raw)
  for (const [name, value] of Object.entries(AUTHORIZATION_PARAMETERS)) {
    if (url.searchParams.has(name)) url.searchParams.set(name, value)
  }
  return url.href
}

function fixtureUuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

/**
 * Replaces every value that changes between runs. Keys are sorted first, at
 * every depth, and UUIDs are then numbered in the order they appear in the
 * sorted body, so the numbering does not depend on the order in which a route
 * wrote its keys. A UUID that appears twice keeps one number.
 */
export function normalizeContractBody(body: unknown): unknown {
  const uuids = new Map<string, string>()

  function normalizeString(key: string | undefined, value: string): string {
    if (key === 'code' && DESKTOP_CODE_RE.test(value)) return 'f'.repeat(43)
    if (key === 'token') return 'fixture-session-token'
    if (key === 'correlationId') return 'fixture-correlation'
    if (key === 'expiresAt') return 'FIXTURE_EXPIRES_AT'
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
