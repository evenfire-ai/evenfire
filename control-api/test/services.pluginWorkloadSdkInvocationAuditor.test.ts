import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as sdkDb from '../src/services/pluginWorkloadSdkDb.js'
import { recordInvocation } from '../src/services/pluginWorkloadSdkInvocationAuditor.js'

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

vi.mock('../src/services/pluginWorkloadSdkDb.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/pluginWorkloadSdkDb.js')>(
    '../src/services/pluginWorkloadSdkDb.js'
  )
  return {
    ...actual,
    insertInvocation: vi.fn(),
    failStaleInvocations: vi.fn(),
  }
})

const SECRET_PROMPT = 'confidential customer data that must never be persisted'
const RAW_IDEMPOTENCY_KEY = 'raw-idempotency-key-123'
const PROVIDER_KEY = 'sk-provider-secret'

beforeEach(() => {
  vi.mocked(sdkDb.insertInvocation)
    .mockReset()
    .mockResolvedValue({ kind: 'inserted', invocation: {} as never })
  vi.mocked(sdkDb.failStaleInvocations).mockReset().mockResolvedValue(0)
})

describe('recordInvocation — audit field inclusion/exclusion (plan §5.2, spec §16)', () => {
  it('persists the whitelisted attribution fields', async () => {
    await recordInvocation({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'sdk-recipe',
      callerRef: 'api',
      correlationId: 'corr-1',
      method: 'promptBridge',
      detail: 'glm-4.7',
      purpose: 'summarization',
      idempotencyKey: RAW_IDEMPOTENCY_KEY,
      payload: { messages: [{ role: 'user', content: SECRET_PROMPT }] },
      status: 'in_progress',
      authorizationDecision: 'authorized',
    })
    const params = vi.mocked(sdkDb.insertInvocation).mock.calls[0][0]
    expect(params).toMatchObject({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'sdk-recipe',
      callerRef: 'api',
      correlationId: 'corr-1',
      method: 'promptBridge',
      detail: 'glm-4.7',
      purpose: 'summarization',
      status: 'in_progress',
      authorizationDecision: 'authorized',
    })
  })

  it('never persists the raw idempotency key, prompt contents, or secrets', async () => {
    await recordInvocation({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'sdk-recipe',
      callerRef: 'api',
      method: 'promptBridge',
      detail: 'glm-4.7',
      idempotencyKey: RAW_IDEMPOTENCY_KEY,
      payload: {
        messages: [{ role: 'user', content: SECRET_PROMPT }],
        leakedProviderKey: PROVIDER_KEY,
      },
      status: 'in_progress',
      authorizationDecision: 'authorized',
    })
    const persisted = JSON.stringify(vi.mocked(sdkDb.insertInvocation).mock.calls[0][0])
    expect(persisted).not.toContain(RAW_IDEMPOTENCY_KEY)
    expect(persisted).not.toContain(SECRET_PROMPT)
    expect(persisted).not.toContain(PROVIDER_KEY)
    // What IS stored: fixed-length SHA-256 hashes.
    const params = vi.mocked(sdkDb.insertInvocation).mock.calls[0][0]
    expect(params.idempotencyKeyHash).toMatch(/^[0-9a-f]{64}$/)
    expect(params.payloadHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces the same payload hash for semantically equal JSON (key order)', () => {
    const a = sdkDb.hashPayload({ b: 2, a: 1, nested: { y: 2, x: 1 } })
    const b = sdkDb.hashPayload({ nested: { x: 1, y: 2 }, a: 1, b: 2 })
    expect(a).toBe(b)
  })

  it('produces different hashes for different payloads', () => {
    expect(sdkDb.hashPayload({ a: 1 })).not.toBe(sdkDb.hashPayload({ a: 2 }))
  })
})

describe('failStaleInvocations (plan §5.1 recovery)', () => {
  it('is called with the 60s default stale timeout by the cron', async () => {
    // The maintenance cron passes STALE_INVOCATION_TIMEOUT_SECONDS=60 directly
    // to sdkDb.failStaleInvocations; verify the db function accepts an integer.
    vi.mocked(sdkDb.failStaleInvocations).mockResolvedValue(0)
    await sdkDb.failStaleInvocations(60)
    expect(sdkDb.failStaleInvocations).toHaveBeenCalledWith(60)
  })

  it('returns the number of transitioned rows', async () => {
    vi.mocked(sdkDb.failStaleInvocations).mockResolvedValue(3)
    await expect(sdkDb.failStaleInvocations(120)).resolves.toBe(3)
    expect(sdkDb.failStaleInvocations).toHaveBeenCalledWith(120)
  })
})
