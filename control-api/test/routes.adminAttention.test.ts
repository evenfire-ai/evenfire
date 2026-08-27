import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { MockGateway } from './mockGateway.js'

// ── Fase 5, Pieza C: GET /admin/attention. OBSERVABLE-contract tests (T4): they
// assert the HTTP BODY the frontend banner consumes (the attention items + their
// impact), never an internal helper. Host references are produced by the REAL
// gateway producer (`createResource` → per-namespace `listResource`, T1); grant
// references flow through the REAL `mapGrantRow` inside `listGrantsReferencingModel`
// (T1) — never hand-built DTOs. The stale set comes from the REAL `rowToModel`
// mapper via `listStaleAllowedModels` (raw DB rows shaped to the migration).

const mockPoolQuery = vi.fn()
const mockVerifyAdminToken = vi.fn()
const mockIsAdminTokenRevoked = vi.fn()
const mockFindAdminById = vi.fn()

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
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
const STALE_MODEL = 'claude-haiku-4-5'
const OTHER_STALE_MODEL = 'claude-opus-legacy'
// A stale row that has ALREADY been disabled. Sorts after STALE_MODEL under the
// query's ORDER BY provider, model, so a leaked ordering is deterministic.
const DISABLED_STALE_MODEL = 'claude-sonnet-disabled'

// A raw `llm_allowed_models` DB row shaped to the migration schema, run through
// the REAL `rowToModel` mapper on the way out (T1). `stale` defaults true here
// because the WHERE-stale query only ever returns stale rows.
function makeModelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    provider: PROVIDER,
    model: STALE_MODEL,
    vendor: 'Anthropic',
    display_name: null,
    context_window_tokens: 200000,
    enabled: true,
    source: 'manual',
    discovered_at: null,
    last_seen_at: null,
    stale: true,
    created_at: new Date('2026-07-01T00:00:00Z'),
    updated_at: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  }
}

// A raw `plugin_workload_sdk_grants` row; the production path runs it through the
// REAL `mapGrantRow`, so the body carries genuine mapper output.
function makeGrantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    recipe_namespace: 'sandbox-recipes',
    recipe_name: 'nightly-summary',
    capability_family: 'promptBridge',
    provider: PROVIDER,
    allowed_models: [STALE_MODEL],
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
 * Route `pool.query` by SQL text. `staleRows` are the rows the stale-list query
 * returns; `grantRowsByModel` maps a model name → the raw grant rows the
 * per-model impact query returns for it (keyed on the query's `$1` param).
 */
function installPool(opts: {
  staleRows?: unknown[]
  grantRowsByModel?: Record<string, unknown[]>
}) {
  const staleRows = opts.staleRows ?? []
  const grantRowsByModel = opts.grantRowsByModel ?? {}
  mockPoolQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = String(sql)
    if (/FROM plugin_workload_sdk_grants/.test(text)) {
      const model = String(params?.[0] ?? '')
      const rows = grantRowsByModel[model] ?? []
      return { rows, rowCount: rows.length }
    }
    if (/FROM llm_allowed_models/.test(text) && /WHERE stale/.test(text)) {
      // No real Postgres in this suite, so emulate the query's OWN WHERE clause
      // instead of trusting the caller to pre-filter: when the SQL under test
      // filters `AND enabled`, drop disabled rows exactly as Postgres would.
      // Keying off the real SQL is what lets this stand in for the DB across the
      // fix — pre-fix (`WHERE stale`) the disabled row leaks through, post-fix it
      // is filtered. Rows keep the real `rowToModel` input shape (T1).
      const filtersEnabled = /\bAND enabled\b/.test(text)
      const rows = filtersEnabled
        ? staleRows.filter(r => (r as { enabled?: unknown }).enabled === true)
        : staleRows
      return { rows, rowCount: rows.length }
    }
    return { rows: [], rowCount: 0 }
  })
}

function app(gateway: MockGateway) {
  return createApp(gateway as never)
}

function authedGet(gateway: MockGateway) {
  return request(app(gateway))
    .get('/api/v1/admin/attention')
    .set('Cookie', 'control_ui_admin_session=admin-token')
}

async function seedHost(
  gateway: MockGateway,
  name: string,
  spec: Record<string, unknown>,
  namespace = 'mcp-host'
) {
  await gateway.createResource('hosts', { metadata: { name }, spec }, namespace)
}

const primarySpec = (model = STALE_MODEL) => ({ model: { provider: PROVIDER, name: model } })

describe('GET /admin/attention', () => {
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

  it('requires control-ui admin auth (401 without the session cookie)', async () => {
    installPool({ staleRows: [] })
    const gateway = new MockGateway('mcp-host')
    await request(app(gateway)).get('/api/v1/admin/attention').expect(401)
  })

  it('stale model referenced by a Host → one item with hostsAffected', async () => {
    installPool({ staleRows: [makeModelRow({ display_name: 'Claude Haiku' })] })
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', primarySpec())

    const res = await authedGet(gateway).expect(200)
    expect(res.body.items).toEqual([
      {
        kind: 'stale_model_referenced',
        provider: PROVIDER,
        model: STALE_MODEL,
        displayName: 'Claude Haiku',
        hostsAffected: [{ namespace: 'mcp-host', name: 'agent-a', roles: ['primary'] }],
        grantsAffected: [],
      },
    ])
    expect(typeof res.body.generatedAt).toBe('string')
    expect(Number.isNaN(Date.parse(res.body.generatedAt))).toBe(false)
  })

  it('stale model referenced ONLY by a grant → item with grantsAffected, empty hosts', async () => {
    installPool({
      staleRows: [makeModelRow()],
      grantRowsByModel: { [STALE_MODEL]: [makeGrantRow()] },
    })
    const gateway = new MockGateway('mcp-host') // no hosts

    const res = await authedGet(gateway).expect(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0]).toMatchObject({
      kind: 'stale_model_referenced',
      provider: PROVIDER,
      model: STALE_MODEL,
      hostsAffected: [],
      grantsAffected: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'nightly-summary',
          capabilityFamily: 'promptBridge',
        },
      ],
    })
    // display_name was null → the field must be absent, not null.
    expect(res.body.items[0]).not.toHaveProperty('displayName')
  })

  it('stale model with NO references → not actionable → absent from the feed', async () => {
    installPool({ staleRows: [makeModelRow()] })
    const gateway = new MockGateway('mcp-host') // no hosts, no grants

    const res = await authedGet(gateway).expect(200)
    expect(res.body.items).toEqual([])
  })

  it('a NON-stale model that IS referenced never appears (not in the stale set)', async () => {
    // The stale query returns only STALE_MODEL. A Host references a DIFFERENT,
    // non-stale model — it must not generate an attention item.
    installPool({ staleRows: [makeModelRow()] })
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-nonstale', primarySpec('claude-sonnet-current'))

    const res = await authedGet(gateway).expect(200)
    expect(res.body.items).toEqual([])
  })

  it('no stale models → empty feed', async () => {
    installPool({ staleRows: [] })
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', primarySpec())

    const res = await authedGet(gateway).expect(200)
    expect(res.body.items).toEqual([])
  })

  it('mixed set: only the referenced stale model yields an item', async () => {
    installPool({
      staleRows: [
        makeModelRow({ id: '11111111-1111-4111-8111-111111111111', model: STALE_MODEL }),
        makeModelRow({ id: '33333333-3333-4333-8333-333333333333', model: OTHER_STALE_MODEL }),
      ],
    })
    const gateway = new MockGateway('mcp-host')
    // Only STALE_MODEL is referenced; OTHER_STALE_MODEL is stranded/unreferenced.
    await seedHost(gateway, 'agent-a', primarySpec(STALE_MODEL))

    const res = await authedGet(gateway).expect(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].model).toBe(STALE_MODEL)
  })

  it('preserves the stable stale-list order (provider, model) with ≥2 referenced items', async () => {
    // `listStaleAllowedModels` sorts ORDER BY provider, model; the feed must
    // carry that order through unchanged. Both providers are `claude`, so model
    // decides: `claude-haiku-4-5` < `claude-opus-legacy`. The UI relies on it.
    installPool({
      staleRows: [
        makeModelRow({ id: '11111111-1111-4111-8111-111111111111', model: STALE_MODEL }),
        makeModelRow({ id: '33333333-3333-4333-8333-333333333333', model: OTHER_STALE_MODEL }),
      ],
    })
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', primarySpec(STALE_MODEL))
    await seedHost(gateway, 'agent-b', primarySpec(OTHER_STALE_MODEL))

    const res = await authedGet(gateway).expect(200)
    expect(res.body.items.map((i: { model: string }) => i.model)).toEqual([
      STALE_MODEL,
      OTHER_STALE_MODEL,
    ])
  })

  it('a stale but DISABLED referenced model is NOT actionable → absent; an enabled one appears (R1-M2)', async () => {
    // A force-disable can leave a dangling reference: stale=true, enabled=false,
    // still referenced by a Host. Its suggested action ("disable it, impact-gated
    // PUT") is ALREADY done, so the feed must NOT re-surface it — otherwise it
    // never converges to zero after the action it itself asked for. A stale AND
    // enabled referenced model still must appear. Both rows carry the real
    // `rowToModel` input shape (T1); the assertion is the observable item list the
    // banner renders (T4).
    installPool({
      staleRows: [
        makeModelRow({
          id: '11111111-1111-4111-8111-111111111111',
          model: STALE_MODEL,
          enabled: true,
        }),
        makeModelRow({
          id: '44444444-4444-4444-8444-444444444444',
          model: DISABLED_STALE_MODEL,
          enabled: false,
        }),
      ],
    })
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-enabled', primarySpec(STALE_MODEL))
    await seedHost(gateway, 'agent-disabled', primarySpec(DISABLED_STALE_MODEL))

    const res = await authedGet(gateway).expect(200)
    // Only the enabled stale model is an actionable item; the disabled one, though
    // still referenced, is filtered out at the query (`WHERE stale AND enabled`).
    expect(res.body.items.map((i: { model: string }) => i.model)).toEqual([STALE_MODEL])
  })

  it('detects stale references across BOTH real host namespaces', async () => {
    expect(config.hostsNamespace).not.toBe(config.namespace) // precondition
    installPool({ staleRows: [makeModelRow()] })
    const gateway = new MockGateway('mcp-host')
    await seedHost(gateway, 'agent-a', primarySpec(), config.namespace)

    const res = await authedGet(gateway).expect(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].hostsAffected).toEqual([
      { namespace: config.namespace, name: 'agent-a', roles: ['primary'] },
    ])
  })

  it('FAILS LOUD: a Host LIST error tumbles the whole endpoint (500), never a partial feed', async () => {
    installPool({ staleRows: [makeModelRow()] })
    const gateway = new MockGateway('mcp-host')
    gateway.listResource = vi.fn(async () => {
      throw new Error('k8s apiserver LIST failed')
    })

    await authedGet(gateway).expect(500)
  })
})
