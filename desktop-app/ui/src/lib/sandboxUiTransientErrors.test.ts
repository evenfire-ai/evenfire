import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { errorMessage, isTransientSandboxUiTeamContextError } from './sandboxUiTransientErrors'

// Literal copy of the classifier as it lived inside App.tsx before the
// extraction. It is the oracle: do not edit it to match the module.
const OLD_TRANSIENT_TEAM_CONTEXT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

function oldErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown error')
}

function oldErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const record = error as { code?: unknown; cause?: { code?: unknown } }
  return String(record.code || record.cause?.code || '').toUpperCase()
}

function oldIsTransientSandboxUiTeamContextError(error: unknown): boolean {
  const message = oldErrorMessage(error).toLowerCase()
  if (
    /\b(400|401|403|404)\b/.test(message) ||
    message.includes('access denied') ||
    message.includes('authenticat') ||
    message.includes('forbidden') ||
    message.includes('not a member') ||
    message.includes('permission') ||
    message.includes('select a team') ||
    message.includes('teamid is required') ||
    message.includes('validation')
  ) {
    return false
  }

  const code = oldErrorCode(error)
  if (OLD_TRANSIENT_TEAM_CONTEXT_ERROR_CODES.has(code)) return true

  return (
    message.includes('connection refused') ||
    message.includes('connection reset') ||
    message.includes('fetch failed') ||
    message.includes('network error') ||
    message.includes('socket hang up') ||
    message.includes('temporarily unavailable') ||
    message.includes('timed out') ||
    message.includes('timeout')
  )
}

const CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]

const NON_TRANSIENT_MESSAGES = [
  'Request failed with 400',
  'HTTP 401 Unauthorized',
  'status 403',
  'Team 404 not found',
  'Access denied for team',
  'Not authenticated',
  'Authentication required',
  'Forbidden',
  'You are not a member of this team',
  'Missing permission',
  'Select a team first',
  'teamId is required',
  'Validation failed',
]

const TRANSIENT_MESSAGES = [
  'connect: connection refused',
  'read: Connection reset by peer',
  'TypeError: fetch failed',
  'Network error',
  'socket hang up',
  'Service temporarily unavailable',
  'Request timed out',
  'TIMEOUT waiting for team',
]

const NEUTRAL_MESSAGES = ['', 'Something broke', 'error 4000', 'x401y', 'Unknown error']

function withCode(message: string, code: unknown): Error {
  return Object.assign(new Error(message), { code })
}

function withCause(message: string, cause: unknown): Error {
  return Object.assign(new Error(message), { cause })
}

const CASES: ReadonlyArray<readonly [string, unknown]> = [
  ...CODES.flatMap(code => [
    [`code ${code}`, withCode('boom', code)] as const,
    [`lowercase code ${code}`, withCode('boom', code.toLowerCase())] as const,
    [`cause code ${code}`, withCause('boom', { code })] as const,
    [`plain object code ${code}`, { code }] as const,
    [`plain object cause code ${code}`, { cause: { code } }] as const,
    [`code ${code} with a non-transient message`, withCode('HTTP 403 forbidden', code)] as const,
    [
      `own code wins over cause ${code}`,
      Object.assign(withCode('boom', 'EOTHER'), { cause: { code } }),
    ] as const,
    [
      `empty own code falls back to cause ${code}`,
      Object.assign(withCode('boom', ''), { cause: { code } }),
    ] as const,
    [`grandchild cause ${code} is not consulted`, withCause('boom', { cause: { code } })] as const,
  ]),
  ...NON_TRANSIENT_MESSAGES.map(message => [`message ${message}`, new Error(message)] as const),
  ...NON_TRANSIENT_MESSAGES.map(message => [`string ${message}`, message] as const),
  ...TRANSIENT_MESSAGES.map(message => [`message ${message}`, new Error(message)] as const),
  ...TRANSIENT_MESSAGES.map(message => [`string ${message}`, message] as const),
  ...TRANSIENT_MESSAGES.map(
    message => [`cause carrying ${message}`, withCause('outer', new Error(message))] as const
  ),
  ...NEUTRAL_MESSAGES.map(message => [`neutral ${message}`, new Error(message)] as const),
  ['numeric code', withCode('boom', 104)],
  ['unknown code', withCode('boom', 'EPERM')],
  ['cause is a string', withCause('boom', 'ECONNRESET')],
  ['cause is null', withCause('boom', null)],
  ['null', null],
  ['undefined', undefined],
  ['zero', 0],
  ['false', false],
  ['empty string', ''],
  ['number', 42],
  ['plain object without code', { message: 'connection refused' }],
]

describe('sandboxUiTransientErrors', () => {
  it.each(CASES)('classifies %s exactly as the previous App classifier', (_label, error) => {
    expect(isTransientSandboxUiTeamContextError(error)).toBe(
      oldIsTransientSandboxUiTeamContextError(error)
    )
    expect(errorMessage(error)).toBe(oldErrorMessage(error))
  })

  it('agrees with the previous classifier on generated errors', () => {
    const fragment = fc.constantFrom(
      ...NON_TRANSIENT_MESSAGES,
      ...TRANSIENT_MESSAGES,
      ...NEUTRAL_MESSAGES
    )
    const message = fc
      .array(fc.oneof(fragment, fc.string()), { maxLength: 3 })
      .map(parts => parts.join(' '))
    const code = fc.oneof(
      fc.constantFrom(...CODES),
      fc.constantFrom(...CODES).map(value => value.toLowerCase()),
      fc.string(),
      fc.integer(),
      fc.constant(undefined),
      fc.constant(null)
    )
    const error = fc.oneof(
      fc.tuple(message, code).map(([text, value]) => withCode(text, value)),
      fc.tuple(message, code).map(([text, value]) => withCause(text, { code: value })),
      fc
        .tuple(message, code, code)
        .map(([text, own, nested]) =>
          Object.assign(withCode(text, own), { cause: { code: nested } })
        ),
      fc.tuple(code, code).map(([own, nested]) => ({ code: own, cause: { code: nested } })),
      message,
      fc.constantFrom(null, undefined, 0, false, '')
    )
    fc.assert(
      fc.property(error, value => {
        expect(isTransientSandboxUiTeamContextError(value)).toBe(
          oldIsTransientSandboxUiTeamContextError(value)
        )
        expect(errorMessage(value)).toBe(oldErrorMessage(value))
      }),
      { numRuns: 2000 }
    )
  })

  it('covers both outcomes in the case table', () => {
    const outcomes = new Set(
      CASES.map(([, error]) => oldIsTransientSandboxUiTeamContextError(error))
    )
    expect(outcomes).toEqual(new Set([true, false]))
  })
})
