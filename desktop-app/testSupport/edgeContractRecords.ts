import { readFileSync } from 'node:fs'
import { URL as NodeUrl } from 'node:url'
import type { LoginMethodsHttpAnswer } from '../src/browserSignInModel.js'
import type { LoginMethodsModel } from '../src/types.js'

/**
 * What the edge really answers, as PR 1 recorded it in
 * `external-rest-api/test/fixtures/oidc-desktop-sign-in/edge.json` (written by
 * `external-rest-api/test/contracts/oidcDesktopSignIn.edge.contract.test.ts`). Desktop tests read
 * every methods and redeem answer from here and never write one by hand. A labelled derivation
 * (`deriveEdgeRecord`) changes only what its label says.
 *
 * Only `node:fs` and `node:url`, so both main-process and renderer tests can import this file.
 */

export type EdgeContractRecord = Readonly<{
  status: number
  body: unknown
  setCookie: ReadonlyArray<{ name: string; attributes: string[] }>
  retryAfter: string | null
}>

/** The records this PR reads: PR 1 Task 12's case names, each with the edge's path. */
export const DESKTOP_EDGE_RECORD_KEYS = [
  'GET /api/v1/auth/methods password-and-oidc',
  'GET /api/v1/auth/methods password',
  'GET /api/v1/auth/methods not-found',
  'GET /api/v1/auth/methods unavailable',
  'POST /api/v1/oidc/desktop-sign-in/redeem signed-in',
  'POST /api/v1/oidc/desktop-sign-in/redeem invalid',
  'POST /api/v1/oidc/desktop-sign-in/redeem refused-account-disabled',
  'POST /api/v1/oidc/desktop-sign-in/redeem unavailable',
  'POST /api/v1/oidc/desktop-sign-in/redeem upgrade-required',
  'POST /api/v1/oidc/desktop-sign-in/redeem issuance-unavailable',
  'POST /api/v1/oidc/desktop-sign-in/redeem rate-limited',
  // Read only: its `body.environment` is environment A's REST URL in the browser sign-in harness.
  'POST /api/v1/oidc/profile-flow/complete desktop-code-issued',
] as const

export type EdgeRecordKey = (typeof DESKTOP_EDGE_RECORD_KEYS)[number]

// Node's own URL: under a renderer test's jsdom environment, the global `URL` resolves this
// relative path against a `file:` base to an `http:` URL, which `readFileSync` refuses.
const EDGE_RECORDS_URL = new NodeUrl(
  '../../external-rest-api/test/fixtures/oidc-desktop-sign-in/edge.json',
  import.meta.url
)
/** PR 1 records every `expiresAt` as this sentinel, so the file stays deterministic. */
const FIXTURE_EXPIRES_AT = 'FIXTURE_EXPIRES_AT'
const KNOWN_KEYS: ReadonlySet<string> = new Set(DESKTOP_EDGE_RECORD_KEYS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEdgeContractRecord(value: unknown): value is EdgeContractRecord {
  return (
    isRecord(value) &&
    typeof value.status === 'number' &&
    Object.hasOwn(value, 'body') &&
    Array.isArray(value.setCookie) &&
    (value.retryAfter === null || typeof value.retryAfter === 'string')
  )
}

/**
 * The record named `key`, read afresh from the file, so a caller may change what it gets. Each
 * `FIXTURE_EXPIRES_AT` becomes now + 600 s, as every PR 1 reader does. A key outside
 * `DESKTOP_EDGE_RECORD_KEYS`, or one the file lacks, throws.
 */
export function readEdgeRecord(key: EdgeRecordKey): EdgeContractRecord {
  if (!KNOWN_KEYS.has(key)) {
    throw new Error(`"${key}" is not a key this PR reads (DESKTOP_EDGE_RECORD_KEYS)`)
  }
  const records = JSON.parse(readFileSync(EDGE_RECORDS_URL, 'utf8'), (_name, value: unknown) =>
    value === FIXTURE_EXPIRES_AT ? new Date(Date.now() + 600_000).toISOString() : value
  ) as Record<string, unknown>
  const record = Object.hasOwn(records, key) ? records[key] : undefined
  if (!isEdgeContractRecord(record)) {
    throw new Error(`edge.json has no record "${key}" of the recorded shape`)
  }
  return record
}

/**
 * A labelled derivation: the record with its body passed through `edit`, everything else as
 * recorded. The label names the change and appears in the test name. A derivation that changes
 * nothing throws, since its label would then be false.
 */
export function deriveEdgeRecord(
  key: EdgeRecordKey,
  label: string,
  edit: (body: unknown) => unknown
): EdgeContractRecord {
  if (!label.trim()) throw new Error(`a derivation of "${key}" needs a label`)
  const record = readEdgeRecord(key)
  const recordedBody = JSON.stringify(record.body)
  const body = edit(record.body)
  if (JSON.stringify(body) === recordedBody) {
    throw new Error(`the derivation "${label}" of "${key}" changed nothing`)
  }
  return { ...record, body }
}

/** The record as the edge sends it: its status, its JSON body and its `retry-after`. */
export function edgeResponse(record: EdgeContractRecord): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (record.retryAfter !== null) headers.set('retry-after', record.retryAfter)
  return new Response(JSON.stringify(record.body), { status: record.status, headers })
}

const BOTH_METHODS: EdgeRecordKey = 'GET /api/v1/auth/methods password-and-oidc'
const PASSWORD_METHOD: EdgeRecordKey = 'GET /api/v1/auth/methods password'
const METHODS_NOT_FOUND: EdgeRecordKey = 'GET /api/v1/auth/methods not-found'

/**
 * A recorded methods answer as the model receives it. Only a 200 and a 404 carry an answer the
 * model reads. Turning a 503, another 5xx or a network failure into `unreachable` belongs to
 * the code that fetches the methods, so any other status throws here.
 */
function loginMethodsAnswer(record: EdgeContractRecord): LoginMethodsHttpAnswer {
  if (record.status === 200) return { status: 200, body: record.body }
  if (record.status === 404) return { status: 404 }
  throw new Error(`a methods record answering ${record.status} is not a model answer here`)
}

function methodsBody(body: unknown): Record<string, unknown> & { methods: unknown[] } {
  if (!isRecord(body) || !Array.isArray(body.methods)) {
    throw new Error('the recorded methods answer has no methods list')
  }
  return body as Record<string, unknown> & { methods: unknown[] }
}

function recordedOidc(): Readonly<{ label: string; signInUrl: string }> {
  const oidc = methodsBody(readEdgeRecord(BOTH_METHODS).body).oidc
  if (!isRecord(oidc) || typeof oidc.label !== 'string' || typeof oidc.signInUrl !== 'string') {
    throw new Error(`"${BOTH_METHODS}" records no oidc label and signInUrl`)
  }
  return Object.freeze({ label: oidc.label, signInUrl: oidc.signInUrl })
}

const RECORDED_OIDC = recordedOidc()

/** `password-and-oidc` without `'password'` (the PR4 shape), with `oidc` fields replaced. */
function oidcOnly(label: string, oidcFields: Record<string, unknown> = {}): LoginMethodsHttpAnswer {
  return loginMethodsAnswer(
    deriveEdgeRecord(BOTH_METHODS, label, recorded => {
      const body = methodsBody(recorded)
      return {
        ...body,
        methods: body.methods.filter(method => method !== 'password'),
        oidc: { ...(body.oidc as object), ...oidcFields },
      }
    })
  )
}

function fromPassword(label: string, methods: (recorded: unknown[]) => unknown) {
  return loginMethodsAnswer(
    deriveEdgeRecord(PASSWORD_METHOD, label, recorded => {
      const body = methodsBody(recorded)
      return { ...body, methods: methods(body.methods) }
    })
  )
}

const recordedSignInUrl = new NodeUrl(RECORDED_OIDC.signInUrl)
const { hostname, origin, pathname } = recordedSignInUrl
const titleCasePathname = pathname.replace(/\b[a-z]/g, letter => letter.toUpperCase())

/** A sign-in URL of exactly `length` characters, made long in its host. */
function signInUrlOfLength(length: number): string {
  const frame = `https://.${hostname}${pathname}`
  return `https://${'a'.repeat(length - frame.length)}.${hostname}${pathname}`
}

/** [label, the `signInUrl` value, what PR 2's parser normalizes it to or null]. */
const SIGN_IN_URL_CASES: ReadonlyArray<readonly [string, unknown, string | null]> = [
  [
    'an explicit port',
    `https://${hostname}:8443${pathname}`,
    `https://${hostname}:8443${pathname}`,
  ],
  ['an upper-case host', `https://${hostname.toUpperCase()}${pathname}`, RECORDED_OIDC.signInUrl],
  ['exactly 2048 characters', signInUrlOfLength(2048), signInUrlOfLength(2048)],
  ['http:', `http://${hostname}${pathname}`, null],
  ['a query', `${RECORDED_OIDC.signInUrl}?next=1`, null],
  ['a bare ?', `${RECORDED_OIDC.signInUrl}?`, null],
  ['a fragment', `${RECORDED_OIDC.signInUrl}#top`, null],
  ['user info', `https://member@${hostname}${pathname}`, null],
  [`a trailing slash (${pathname}/)`, `${RECORDED_OIDC.signInUrl}/`, null],
  [`another case (${titleCasePathname})`, `${origin}${titleCasePathname}`, null],
  ['another path', `${origin}/login`, null],
  ['a number', 42, null],
  ['null', null, null],
  ['an object', { href: RECORDED_OIDC.signInUrl }, null],
  ['more than 2048 characters', signInUrlOfLength(2049), null],
]

/**
 * Review Focus 3: [the derivation's label, usable, the answer, what `readUsableOidc` returns].
 * Each answer is `oidc-only` with only `oidc.signInUrl` replaced.
 */
export const SIGN_IN_URL_SHAPES: ReadonlyArray<
  readonly [
    label: string,
    usable: boolean,
    answer: LoginMethodsHttpAnswer,
    usableOidc: { label: string; signInUrl: string } | null,
  ]
> = SIGN_IN_URL_CASES.map(([shape, signInUrl, normalized]) => {
  const label = `${normalized === null ? 'nothing-usable' : 'oidc-only'}:signInUrl ${shape}`
  return [
    label,
    normalized !== null,
    oidcOnly(label, { signInUrl }),
    normalized === null ? null : { label: RECORDED_OIDC.label, signInUrl: normalized },
  ] as const
})

const PASSWORD_FORM: LoginMethodsModel = { kind: 'methods', provider: null, password: true }
const MISCONFIGURED: LoginMethodsModel = { kind: 'misconfigured' }
const LABEL_OF_80 = RECORDED_OIDC.label.padEnd(80, 'x')

/**
 * Design §10.1's login screen, one row per answer, with links available: [label, the answer,
 * the model]. Main's model tests and the renderer's tests both iterate it.
 */
export const LOGIN_SCREEN_ROWS: ReadonlyArray<
  readonly [label: string, answer: LoginMethodsHttpAnswer, model: LoginMethodsModel]
> = [
  [
    'password-and-oidc',
    loginMethodsAnswer(readEdgeRecord(BOTH_METHODS)),
    { kind: 'methods', provider: { label: RECORDED_OIDC.label }, password: true },
  ],
  [
    'oidc-only',
    oidcOnly('oidc-only'),
    { kind: 'methods', provider: { label: RECORDED_OIDC.label }, password: false },
  ],
  [
    'oidc-only:label-80-characters',
    oidcOnly('oidc-only:label-80-characters', { label: LABEL_OF_80 }),
    { kind: 'methods', provider: { label: LABEL_OF_80 }, password: false },
  ],
  ['password', loginMethodsAnswer(readEdgeRecord(PASSWORD_METHOD)), PASSWORD_FORM],
  [
    // The `oidc` object alone does not offer the provider: `methods` must list it.
    'password:oidc-not-listed',
    loginMethodsAnswer(
      deriveEdgeRecord(BOTH_METHODS, 'password:oidc-not-listed', recorded => {
        const body = methodsBody(recorded)
        return { ...body, methods: body.methods.filter(method => method !== 'oidc') }
      })
    ),
    PASSWORD_FORM,
  ],
  [
    'password-and-unknown-name',
    fromPassword('password-and-unknown-name', methods => [...methods, 'sso']),
    PASSWORD_FORM,
  ],
  // A server older than the endpoint (Decision 7).
  ['not-found', loginMethodsAnswer(readEdgeRecord(METHODS_NOT_FOUND)), PASSWORD_FORM],
  ['nothing-usable:empty', fromPassword('nothing-usable:empty', () => []), MISCONFIGURED],
  [
    'nothing-usable:unknown-name',
    fromPassword('nothing-usable:unknown-name', () => ['sso']),
    MISCONFIGURED,
  ],
  [
    // A string's `includes('oidc')` is true too.
    'nothing-usable:methods-not-a-list',
    loginMethodsAnswer(
      deriveEdgeRecord(BOTH_METHODS, 'nothing-usable:methods-not-a-list', recorded => {
        const body = methodsBody(recorded)
        return { ...body, methods: body.methods.join(',') }
      })
    ),
    MISCONFIGURED,
  ],
  [
    'nothing-usable:oidc-without-object',
    loginMethodsAnswer(
      deriveEdgeRecord(BOTH_METHODS, 'nothing-usable:oidc-without-object', recorded => {
        const { oidc: _dropped, ...body } = methodsBody(recorded)
        return { ...body, methods: body.methods.filter(method => method !== 'password') }
      })
    ),
    MISCONFIGURED,
  ],
  [
    'nothing-usable:label-empty',
    oidcOnly('nothing-usable:label-empty', { label: '' }),
    MISCONFIGURED,
  ],
  [
    'nothing-usable:label-81-characters',
    oidcOnly('nothing-usable:label-81-characters', {
      label: RECORDED_OIDC.label.padEnd(81, 'x'),
    }),
    MISCONFIGURED,
  ],
  [
    'nothing-usable:label-not-a-string',
    oidcOnly('nothing-usable:label-not-a-string', { label: 42 }),
    MISCONFIGURED,
  ],
  ...SIGN_IN_URL_SHAPES.filter(([, usable]) => !usable).map(
    ([label, , answer]) => [label, answer, MISCONFIGURED] as const
  ),
  // No body: what the code that fetches hands over for a 503 (`GET /api/v1/auth/methods
  // unavailable`), another 5xx or a network failure.
  ['unreachable', { status: 'unreachable' }, { kind: 'unreachable' }],
]
