import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Reads what External REST really answers, as recorded by
 * external-rest-api/test/contracts/oidcDesktopSignIn.edge.contract.test.ts. Profile UI tests
 * take upstream bodies from here instead of writing them by hand.
 */
type EdgeRecord = Readonly<{
  status: number
  body: unknown
  setCookie: ReadonlyArray<Readonly<{ name: string; attributes: readonly string[] }>>
  retryAfter: string | null
}>

// Read at runtime, not imported: the image build type-checks this file with only
// profile-ui/ in its context. Both node:test and vitest run from the package root.
const EDGE_RECORDS_PATH = resolve(
  process.cwd(),
  '../external-rest-api/test/fixtures/oidc-desktop-sign-in/edge.json'
)

export function edgeRecord(key: string): EdgeRecord {
  const expiresAt = new Date(Date.now() + 600_000).toISOString()
  const text = readFileSync(EDGE_RECORDS_PATH, 'utf8').replaceAll(
    '"FIXTURE_EXPIRES_AT"',
    JSON.stringify(expiresAt)
  )
  const record = (JSON.parse(text) as Record<string, EdgeRecord | undefined>)[key]
  if (!record) throw new Error(`edge.json has no record named ${key}`)
  return record
}

function setCookieHeaders(record: EdgeRecord): string[] {
  return record.setCookie.map(cookie =>
    [`${cookie.name}=fixture-cookie-value`, ...cookie.attributes].join('; ')
  )
}

/** Each recorded cookie as External REST sends it, with the value readers agree on. */
export function edgeSetCookies(key: string): string[] {
  return setCookieHeaders(edgeRecord(key))
}

export function edgeResponse(key: string): Response {
  const record = edgeRecord(key)
  const headers = new Headers({ 'content-type': 'application/json' })
  for (const cookie of setCookieHeaders(record)) headers.append('set-cookie', cookie)
  if (record.retryAfter !== null) headers.set('retry-after', record.retryAfter)
  return new Response(JSON.stringify(record.body), { status: record.status, headers })
}
