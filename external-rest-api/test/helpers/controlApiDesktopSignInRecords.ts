import { vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * control-api's recorded Desktop sign-in answers, written by its contract and real-Postgres
 * suites. Edge tests replay these bodies and never write a control-api body by hand.
 */
const RECORD_FILES = [
  new URL(
    '../../../control-api/test/fixtures/oidc-desktop-sign-in/control-api.json',
    import.meta.url
  ),
  new URL(
    '../../../control-api/test/fixtures/oidc-desktop-sign-in/control-api.realPostgres.json',
    import.meta.url
  ),
]

/**
 * control-api records every `expiresAt` as this sentinel, so the files stay deterministic. The
 * edge's own file writes it back the same way.
 */
export const FIXTURE_EXPIRES_AT = 'FIXTURE_EXPIRES_AT'

export type ControlApiRecord = Readonly<{ status: number; body: Record<string, unknown> }>

/** Each file's records, with every `FIXTURE_EXPIRES_AT` re-stamped to now + 600 s. */
function readRecordFiles(): Array<Record<string, ControlApiRecord>> {
  return RECORD_FILES.map(
    file =>
      JSON.parse(readFileSync(file, 'utf8'), (_key, value: unknown) =>
        value === FIXTURE_EXPIRES_AT ? new Date(Date.now() + 600_000).toISOString() : value
      ) as Record<string, ControlApiRecord>
  )
}

/**
 * The record named `'<METHOD> <control-api path> <case>'`. Each `FIXTURE_EXPIRES_AT` becomes
 * now + 600 s, a live attempt expiry. An unknown name, or one recorded in both files, throws.
 */
export function controlApiRecord(name: string): ControlApiRecord {
  const matches = readRecordFiles().flatMap(records =>
    Object.hasOwn(records, name) ? [records[name]!] : []
  )
  if (matches.length !== 1) {
    throw new Error(`expected one control-api record named "${name}", found ${matches.length}`)
  }
  return matches[0]!
}

/** Every record name in both files. A name recorded in both files throws. */
export function controlApiRecordNames(): string[] {
  const names = readRecordFiles().flatMap(records => Object.keys(records))
  const repeated = names.filter((name, index) => names.indexOf(name) !== index)
  if (repeated.length > 0) {
    throw new Error(`control-api records named in both files: ${repeated.join(', ')}`)
  }
  return names
}

/**
 * Stubs `fetch` so control-api answers each call with the record, or with what the function
 * returns at call time. A function that throws stands for an unreachable control-api.
 */
export function controlApiAnswers(answer: ControlApiRecord | (() => ControlApiRecord)) {
  const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
    const { status, body } = typeof answer === 'function' ? answer() : answer
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
