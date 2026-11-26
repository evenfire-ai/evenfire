import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalResourceIdentity,
  hashActionTarget,
  validateActionOperationTarget,
} from '@clerum/action-context-contracts'
import { hostWakeV2Answers } from '../../../control-api/test/fixtures/hostWakeV2Answers.js'
import { type AuthorizedActionV2, authorizeActionV2 } from '../actionAuthorityV2.js'
import { requestHostWakeFromControlApi } from '../services/controlApiRestService.js'
import type { UserDelegationV2Claims } from '../userDelegationV2.js'

// control-api's V2 wake route answers 404 and 409 both for an authority
// refusal ({ version: 2, status, code }) and for the wake result after the
// authority check passed ({ status: 'unknown' | 'not-stateless' }). The wake
// results come from the fixture that control-api's route test pins.

const USER = '00000000-0000-4000-8000-000000000001'
const HOST = 'host-a'
const CHECKPOINT_PATH = '/api/v1/internal/action-authority/checkpoint'
const V2_WAKE_PATH = `/api/v1/internal/action-authority/hosts/${HOST}/wake`
const V1_WAKE_PATH = `/api/v1/rpc/hosts/${HOST}/wake`

const RESOURCE = canonicalResourceIdentity({
  environmentId: 'test',
  type: 'host',
  logicalId: 'mcp-host/chatllm',
  displayName: 'Chat LLM',
})
const TARGET = validateActionOperationTarget({
  operationId: 'host.status.read',
  resource: RESOURCE,
  operationTarget: { hostRef: 'mcp-host/chatllm' },
})
const BOUND = {
  operationId: 'host.status.read' as const,
  target: TARGET,
  targetHash: hashActionTarget(TARGET),
}
const DELEGATION: UserDelegationV2Claims = {
  typ: 'user_delegation',
  ver: 2,
  sub: USER,
  sid: '00000000-0000-4000-8000-000000000002',
  sv: 2,
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
  operationIds: ['host.status.read'],
  scopes: ['action:host.status.read'],
  resource: RESOURCE,
  targets: { 'host.status.read': TARGET },
  targetHashes: { 'host.status.read': BOUND.targetHash },
  accessPathId: `ap1_${'A'.repeat(43)}`,
  authorizationRevision: `ar1_${'B'.repeat(43)}`,
  behaviorBindingHash: `bh2_${'C'.repeat(43)}`,
  pathKind: 'team',
  effectiveTeamId: '00000000-0000-4000-8000-000000000003',
}

function allowedCheckpoint(): Response {
  const checkedAt = new Date()
  return Response.json({
    version: 2,
    status: 'allowed',
    authorizationRevision: DELEGATION.authorizationRevision,
    behaviorBindingHash: DELEGATION.behaviorBindingHash,
    behavior: {
      budget: { state: 'unknown' },
      credentialPolicy: { state: 'unknown' },
      approvalPolicy: { state: 'unknown' },
      filesystemScope: { state: 'unknown' },
      runtime: { state: 'unknown' },
      providerModelPolicy: { state: 'unknown' },
      audit: { state: 'unknown' },
    },
    checkedAt: checkedAt.toISOString(),
    validUntil: new Date(checkedAt.getTime() + 30_000).toISOString(),
    attribution: {
      userId: DELEGATION.sub,
      sid: DELEGATION.sid,
      sessionVersion: DELEGATION.sv,
      accessPathId: DELEGATION.accessPathId,
      pathKind: DELEGATION.pathKind,
      effectiveTeamId: DELEGATION.effectiveTeamId,
    },
    destination: {
      kind: 'host',
      ref: 'mcp-host/chatllm',
      url: 'http://chatllm.mcp-host.svc.cluster.local:3000',
    },
    hostEdgeAssertion: 'eyJhbGciOiJSUzI1NiJ9.eyJ2IjoyfQ.c2lnbmF0dXJl',
  })
}

async function authorized(): Promise<AuthorizedActionV2> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      if (new URL(String(url)).pathname !== CHECKPOINT_PATH) {
        throw new Error(`unexpected request ${String(url)}`)
      }
      return allowedCheckpoint()
    })
  )
  return authorizeActionV2(DELEGATION, BOUND)
}

/** Stubs control-api's wake answer and returns the fetch mock. */
function wakeAnswers(status: number, body: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function expectOneWakeCall(fetchMock: ReturnType<typeof vi.fn>, path: string): void {
  expect(fetchMock).toHaveBeenCalledOnce()
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  expect(new URL(url).pathname).toBe(path)
  expect(init.method).toBe('POST')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('V2 host wake answers from control-api', () => {
  it.each([
    {
      row: 'c1',
      answer: hostWakeV2Answers.unknown,
      expected: { kind: 'unknown' },
    },
    {
      row: 'c2',
      answer: hostWakeV2Answers.notStateless,
      expected: { kind: 'not-stateless' },
    },
    {
      row: 'c3',
      answer: { status: 404, body: { version: 2, status: 'not_found', code: 'not_found' } },
      expected: { kind: 'authority', status: 404, code: 'not_found' },
    },
    {
      row: 'c4',
      answer: {
        status: 409,
        body: { version: 2, status: 'access_path_stale', code: 'access_path_stale' },
      },
      expected: { kind: 'authority', status: 409, code: 'access_path_stale' },
    },
    {
      row: 'c8',
      answer: {
        status: 403,
        body: { version: 2, status: 'denied', code: 'wake_delegation_required' },
      },
      expected: { kind: 'authority', status: 403, code: 'wake_delegation_required' },
    },
  ])('$row: reads $answer.status $answer.body', async ({ answer, expected }) => {
    const authorizedActionV2 = await authorized()
    const fetchMock = wakeAnswers(answer.status, JSON.stringify(answer.body))

    await expect(
      requestHostWakeFromControlApi(HOST, 'jwt', { authorizedActionV2 })
    ).resolves.toEqual(expected)
    expectOneWakeCall(fetchMock, V2_WAKE_PATH)
  })

  it.each([
    { row: 'c5', status: 409, body: JSON.stringify({ status: 'unknown' }) },
    { row: 'c6', status: 404, body: JSON.stringify({ status: 'not-stateless' }) },
    { row: 'c7', status: 404, body: 'not json' },
  ])('$row: refuses a $status whose body is $body', async ({ status, body }) => {
    const authorizedActionV2 = await authorized()
    const fetchMock = wakeAnswers(status, body)

    await expect(
      requestHostWakeFromControlApi(HOST, 'jwt', { authorizedActionV2 })
    ).rejects.toThrow('Control API v2 host wake returned an invalid authority response')
    expectOneWakeCall(fetchMock, V2_WAKE_PATH)
  })

  it.each([
    { status: 404, expected: { kind: 'unknown' } },
    { status: 409, expected: { kind: 'not-stateless' } },
  ])('c9: the V1 wake reads $status as before', async ({ status, expected }) => {
    const fetchMock = wakeAnswers(status, JSON.stringify({ status: 'anything' }))

    await expect(requestHostWakeFromControlApi(HOST, 'jwt')).resolves.toEqual(expected)
    expectOneWakeCall(fetchMock, V1_WAKE_PATH)
  })
})
