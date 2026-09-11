import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { MockGateway } from './mockGateway.js'

// ── Fase 3: the `?force` availability-reduction gate on PUT/DELETE of
// `/admin/llm-models`. These are OBSERVABLE-contract tests (T4): they assert the
// HTTP status (409 vs 200/204) and the impact body the operator sees, never an
// internal count. Host references are produced by the REAL gateway producer
// (`createResource` → `listResource`, T1), never hand-built CR literals; grant
// references flow through the REAL `mapGrantRow` inside `listGrantsReferencingModel`.

const mockPoolQuery = vi.fn()
const mockVerifyAdminToken = vi.fn()
const mockIsAdminTokenRevoked = vi.fn()
const mockFindAdminById = vi.fn()

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
  // R1-H3 fase 1: the reductor gate now runs inside a carrier transaction. Route
  // the transaction client's queries through the SAME `mockPoolQuery` so the
  // sequenced expectations are unchanged; the advisory lock / idle-timeout guards
  // are no-ops here (serialization is covered by the real-Postgres race test).
  withTransaction: (work: (db: { query: (...a: unknown[]) => unknown }) => Promise<unknown>) =>
    work({ query: (...args: unknown[]) => mockPoolQuery(...args) }),
  advisoryLockModelName: async () => {},
  advisoryLockModelNames: async () => {},
  boundCarrierTransactionIdleTimeout: async () => {},
}))

vi.mock('../src/utils/auth/adminAuthToken.js', () => ({
  verifyAdminToken: (...args: unknown[]) => mockVerifyAdminToken(...args),
}))

vi.mock('../src/services/adminAuthService.js', () => ({
  findAdminById: (...args: unknown[]) => mockFindAdminById(...args),
  isAdminTokenRevoked: (...args: unknown[]) => mockIsAdminTokenRevoked(...args),
}))

const ADMIN_CLAIMS = {
  sub: '00000000-0000-4000-8000-000000000001',
  typ: 'user' as const,
  role: 'admin' as const,
  jti: 'admin-jti',
  exp: Math.floor(Date.now() / 1000) + 3600,
}

const ACTIVE_ADMIN = {
  id: ADMIN_CLAIMS.sub,
  username: 'admin',
  email: 'admin@example.com',
  passwordHash: 'hash',
  sessionVersion: 0,
  role: 'admin' as const,
  status: 'active' as const,
  failedAttempts: 0,
  lockedUntil: null,
}

const PROVIDER = 'claude'
const MODEL = 'claude-haiku-4-5'
const MODEL_ID = '11111111-1111-4111-8111-111111111111'

// The stored allowlist row the gate reads. Mutable so a test can flip `enabled`.
function makeModelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MODEL_ID,
    provider: PROVIDER,
    model: MODEL,
    vendor: 'Anthropic',
    display_name: null,
    context_window_tokens: 200000,
    enabled: true,
    source: 'manual',
    discovered_at: null,
    last_seen_at: null,
    stale: false,
    created_at: new Date('2026-07-01T00:00:00Z'),
    updated_at: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  }
}

// A raw `plugin_workload_sdk_grants` DB row shaped to the migration schema. The
// production impact path runs it through the REAL `mapGrantRow`, so what the
// 409 body carries is genuinely mapper output — not a hand-authored grant DTO.
function makeGrantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    recipe_namespace: 'sandbox-recipes',
    recipe_name: 'nightly-summary',
    capability_family: 'promptBridge',
    provider: PROVIDER,
    allowed_models: [MODEL],
    allowed_event_types: [],
    allowed_target_refs: [],
    allowed_user_refs: [],
    allowed_callers: ['worker'],
    quota_limits: {},
    model_policies: {},
    prompt_targets: [],
    default_target_ref: null,
    policy_revision: 1,
    policy_state: 'active',
    policy_reviewed_at: null,
    policy_reviewed_by: null,
    revocation_id: null,
    created_at: new Date('2026-07-01T00:00:00Z'),
    updated_at: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  }
}

/**
 * Route `pool.query` by SQL text (robust to call ORDER — the gate adds reads
 * ahead of the mutation). `modelRow` is the stored allowlist row; `grantRows`
 * are the raw grant rows the impact query returns.
 */
function installPool(opts: { modelRow?: Record<string, unknown> | null; grantRows?: unknown[] }) {
  const modelRow = opts.modelRow === undefined ? makeModelRow() : opts.modelRow
  const grantRows = opts.grantRows ?? []
  mockPoolQuery.mockImplementation(async (sql: string) => {
    const text = String(sql)
    if (/FROM plugin_workload_sdk_grants/.test(text))
      return { rows: grantRows, rowCount: grantRows.length }
    if (/FROM llm_allowed_models\b/.test(text) && /WHERE id/.test(text)) {
      return { rows: modelRow ? [modelRow] : [], rowCount: modelRow ? 1 : 0 }
    }
    if (/UPDATE llm_allowed_models/.test(text)) {
      return { rows: [makeModelRow({ enabled: false })], rowCount: 1 }
    }
    if (/DELETE FROM llm_allowed_models/.test(text)) return { rows: [], rowCount: 1 }
    // audit inserts and anything else
    return { rows: [], rowCount: 1 }
  })
}

function app(gateway: MockGateway) {
  return createApp(gateway as never)
}

function authed(method: 'get' | 'post' | 'put' | 'delete', path: string, gateway: MockGateway) {
  return request(app(gateway))[method](path).set('Cookie', 'control_ui_admin_session=admin-token')
}

// Seed a Host CR through the REAL gateway producer (mirrors prod create/list).
async function seedHost(
  gateway: MockGateway,
  name: string,
  spec: Record<string, unknown>,
  namespace = 'mcp-host'
) {
  await gateway.createResource('hosts', { metadata: { name }, spec }, namespace)
}

const primarySpec = { model: { provider: PROVIDER, name: MODEL } }
const allowedModelsSpec = { allowedModels: [{ provider: PROVIDER, model: MODEL }] }
const fallbackSpec = { llmPolicy: { fallbacks: [{ provider: PROVIDER, model: MODEL }] } }

describe('admin llm-models ?force impact gate', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset()
    mockVerifyAdminToken.mockReset()
    mockVerifyAdminToken.mockReturnValue(ADMIN_CLAIMS)
    mockIsAdminTokenRevoked.mockReset()
    mockIsAdminTokenRevoked.mockResolvedValue(false)
    mockFindAdminById.mockReset()
    mockFindAdminById.mockResolvedValue(ACTIVE_ADMIN)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('DELETE with a Host reference and no ?force → 409 with the impact body', async () => {
    installPool({})
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', primarySpec)

    const res = await authed('delete', `/api/v1/admin/llm-models/${MODEL_ID}`, gateway).expect(409)
    expect(res.body.error).toBe('model_in_use')
    expect(res.body.impact.provider).toBe(PROVIDER)
    expect(res.body.impact.model).toBe(MODEL)
    expect(res.body.impact.hostsAffected).toEqual([
      { namespace: 'mcp-host', name: 'agent-a', roles: ['primary'] },
    ])
    expect(res.body.impact.grantsAffected).toEqual([])
  })

  it('DELETE with a reference AND ?force=true → proceeds (204)', async () => {
    installPool({})
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', primarySpec)

    await authed('delete', `/api/v1/admin/llm-models/${MODEL_ID}?force=true`, gateway).expect(204)
  })

  it('DELETE with no references → deletes without 409 (204)', async () => {
    installPool({})
    const gateway = new MockGateway('mcp-host') // no hosts, no grants
    await authed('delete', `/api/v1/admin/llm-models/${MODEL_ID}`, gateway).expect(204)
  })

  it('PUT enabled true→false with a reference and no ?force → 409', async () => {
    installPool({ modelRow: makeModelRow({ enabled: true }) })
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', primarySpec)

    const res = await authed('put', `/api/v1/admin/llm-models/${MODEL_ID}`, gateway)
      .send({ enabled: false })
      .expect(409)
    expect(res.body.error).toBe('model_in_use')
    expect(res.body.impact.hostsAffected).toHaveLength(1)
  })

  it('PUT enabled true→false with a reference AND ?force=true → 200', async () => {
    installPool({ modelRow: makeModelRow({ enabled: true }) })
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', primarySpec)

    await authed('put', `/api/v1/admin/llm-models/${MODEL_ID}?force=true`, gateway)
      .send({ enabled: false })
      .expect(200)
  })

  it('PUT that does NOT reduce availability (enabled stays true) → never 409 even with references', async () => {
    installPool({ modelRow: makeModelRow({ enabled: true }) })
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', primarySpec)

    // Re-enable / metadata edit: enabled true→true. The gate must not fire.
    await authed('put', `/api/v1/admin/llm-models/${MODEL_ID}`, gateway)
      .send({ enabled: true, display_name: 'Claude Haiku' })
      .expect(200)
  })

  // ── R1-H1: a PUT that RENAMES an enabled pair pulls the OLD pair out of the
  // runtime ConfigMap on re-materialize exactly like a disable, silently
  // stranding any Host/grant that referenced it. The gate must fire on the OLD
  // pair. These assert the OBSERVABLE 409 + impact body (T4).
  it('R1-H1: PUT that RENAMES an enabled referenced pair (model changes) → 409 with impact on the OLD pair', async () => {
    installPool({ modelRow: makeModelRow({ enabled: true }) })
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', primarySpec) // references the OLD (claude, claude-haiku-4-5)

    // The admin UI form resubmits provider+model on every PUT; here `model`
    // actually changes → identity rename while staying enabled.
    const res = await authed('put', `/api/v1/admin/llm-models/${MODEL_ID}`, gateway)
      .send({ provider: PROVIDER, model: 'claude-opus-4-8', enabled: true })
      .expect(409)
    expect(res.body.error).toBe('model_in_use')
    // Impact is over the OLD pair — that is what would be stranded.
    expect(res.body.impact.provider).toBe(PROVIDER)
    expect(res.body.impact.model).toBe(MODEL)
    expect(res.body.impact.hostsAffected).toEqual([
      { namespace: 'mcp-host', name: 'agent-a', roles: ['primary'] },
    ])
  })

  it('R1-H1: PUT that RENAMES the provider of an enabled referenced pair → 409 (identity is the tuple)', async () => {
    installPool({ modelRow: makeModelRow({ enabled: true }) })
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', primarySpec)

    await authed('put', `/api/v1/admin/llm-models/${MODEL_ID}`, gateway)
      .send({ provider: 'anthropic', model: MODEL, enabled: true })
      .expect(409)
  })

  it('R1-H1: PUT rename + ?force=true → proceeds (200), the escape works', async () => {
    installPool({ modelRow: makeModelRow({ enabled: true }) })
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', primarySpec)

    await authed('put', `/api/v1/admin/llm-models/${MODEL_ID}?force=true`, gateway)
      .send({ provider: PROVIDER, model: 'claude-opus-4-8', enabled: true })
      .expect(200)
  })

  it('R1-H1 regression guard: PUT resubmits the SAME provider+model (form no-op) with references → 200, no false positive', async () => {
    installPool({ modelRow: makeModelRow({ enabled: true }) })
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', primarySpec)

    // Identity unchanged (same values) — the gate compares VALUES, not presence.
    await authed('put', `/api/v1/admin/llm-models/${MODEL_ID}`, gateway)
      .send({ provider: PROVIDER, model: MODEL, enabled: true, display_name: 'Claude Haiku' })
      .expect(200)
  })

  it('R1-H1: renaming an ALREADY-DISABLED referenced pair → 200 (old pair was not in the ConfigMap)', async () => {
    installPool({ modelRow: makeModelRow({ enabled: false }) })
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', primarySpec)

    await authed('put', `/api/v1/admin/llm-models/${MODEL_ID}`, gateway)
      .send({ provider: PROVIDER, model: 'claude-opus-4-8', enabled: false })
      .expect(200)
  })

  it('PUT enabled false→false (already disabled) → never 409', async () => {
    installPool({ modelRow: makeModelRow({ enabled: false }) })
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', primarySpec)

    await authed('put', `/api/v1/admin/llm-models/${MODEL_ID}`, gateway)
      .send({ enabled: false })
      .expect(200)
  })

  it('DELETE with a reference ONLY from a grant (no Hosts) → still 409', async () => {
    installPool({ grantRows: [makeGrantRow()] })
    const gateway = new MockGateway('mcp-host') // no hosts

    const res = await authed('delete', `/api/v1/admin/llm-models/${MODEL_ID}`, gateway).expect(409)
    expect(res.body.impact.hostsAffected).toEqual([])
    expect(res.body.impact.grantsAffected).toEqual([
      {
        id: '22222222-2222-4222-8222-222222222222',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'nightly-summary',
        capabilityFamily: 'promptBridge',
      },
    ])
  })

  // ── One test per Host source (primary / allowedModels / fallbacks) ──────────
  for (const [label, spec, role] of [
    ['primary (spec.model)', primarySpec, 'primary'],
    ['allowedModels (spec.allowedModels[])', allowedModelsSpec, 'allowedModels'],
    ['fallbacks (spec.llmPolicy.fallbacks[])', fallbackSpec, 'fallback'],
  ] as const) {
    it(`a reference ONLY from Host ${label} alone trips the 409`, async () => {
      installPool({})
      const gateway = new MockGateway('mcp-host')
      await seedHost(gateway, 'agent-a', spec)

      const res = await authed('delete', `/api/v1/admin/llm-models/${MODEL_ID}`, gateway).expect(
        409
      )
      expect(res.body.impact.hostsAffected).toEqual([
        { namespace: 'mcp-host', name: 'agent-a', roles: [role] },
      ])
    })
  }

  it('detects Host references across the REAL enumerated namespaces (both host namespaces)', async () => {
    // The route enumerates the actual host namespace set (config.hostsNamespace +
    // config.namespace), LISTing each; MockGateway scopes by namespace, so this
    // reflects real coverage rather than an unfiltered `'*'` dump.
    expect(config.hostsNamespace).not.toBe(config.namespace) // precondition: two distinct namespaces
    installPool({})
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', primarySpec, config.hostsNamespace)
    await seedHost(gateway, 'agent-b', allowedModelsSpec, config.namespace)

    const res = await authed('delete', `/api/v1/admin/llm-models/${MODEL_ID}`, gateway).expect(409)
    const affected = (res.body.impact.hostsAffected as Array<{ namespace: string; name: string }>)
      .map(h => `${h.namespace}/${h.name}`)
      .sort()
    expect(affected).toEqual(
      [`${config.hostsNamespace}/agent-a`, `${config.namespace}/agent-b`].sort()
    )
  })

  it('a Host referencing a DIFFERENT model does not trip the gate', async () => {
    installPool({})
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-other', {
      model: { provider: PROVIDER, name: 'some-other-model' },
    })

    await authed('delete', `/api/v1/admin/llm-models/${MODEL_ID}`, gateway).expect(204)
  })

  it('FAILS CLOSED: a Host LIST error rejects the destructive op (5xx), never a silent delete', async () => {
    // The impact enumeration is a safety gate: if the K8s LIST fails, the gate
    // must NOT let the delete through under-reported. computeModelImpact
    // propagates → asyncHandler → 500, so the model is never removed.
    installPool({})
    const gateway = new MockGateway('mcp-host')
    gateway.listResource = vi.fn(async () => {
      throw new Error('k8s apiserver LIST failed')
    })

    await authed('delete', `/api/v1/admin/llm-models/${MODEL_ID}`, gateway).expect(500)
    // The destructive DELETE against Postgres must never have run.
    const ranDelete = mockPoolQuery.mock.calls.some(c =>
      /DELETE FROM llm_allowed_models/.test(String(c[0]))
    )
    expect(ranDelete).toBe(false)
  })

  it('nit: PUT partial WITHOUT enabled (metadata-only) with references → 200 (gate not tripped)', async () => {
    installPool({ modelRow: makeModelRow({ enabled: true }) })
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', primarySpec)

    await authed('put', `/api/v1/admin/llm-models/${MODEL_ID}`, gateway)
      .send({ display_name: 'Claude Haiku' })
      .expect(200)
  })
})
