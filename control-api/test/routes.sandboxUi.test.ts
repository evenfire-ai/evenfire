import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { MockGateway } from './mockGateway.js'

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}))

const RPC_PROXY_TOKEN = 'dev-rpc-proxy-token'
const URL = (ns: string, name: string, forUser?: string, forTeam?: string) => {
  const params = new URLSearchParams()
  if (forUser) params.set('forUser', forUser)
  if (forTeam) params.set('forTeam', forTeam)
  const query = params.toString()
  return query
    ? `/api/v1/internal/sandbox-ui/registry/${ns}/${name}?${query}`
    : `/api/v1/internal/sandbox-ui/registry/${ns}/${name}`
}

function authed(
  app: ReturnType<typeof createApp>,
  ns: string,
  name: string,
  forUser?: string,
  forTeam?: string
) {
  return request(app)
    .get(URL(ns, name, forUser, forTeam))
    .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
    .set('x-service-token', 'rpc-proxy')
}

async function seedRecipe(
  gateway: MockGateway,
  opts: {
    name?: string
    spec: Record<string, unknown>
    status?: Record<string, unknown>
  }
): Promise<void> {
  await gateway.createResource(
    'workflowrecipes',
    { metadata: { name: opts.name ?? 'test-recipe' }, spec: opts.spec, status: opts.status },
    config.sandboxNamespace
  )
}

/**
 * Seed a Service's Endpoints object as having `count` Ready addresses in
 * the sandbox-ui namespace. Without this every active+routable test case
 * would 409 with `service_endpoints_missing`.
 */
function seedReadyEndpoints(gateway: MockGateway, serviceName: string, count = 1): void {
  gateway.seedServiceEndpoints(serviceName, config.sandboxUiNamespace, count)
}

describe('GET /api/v1/internal/sandbox-ui/registry/:ns/:name', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('rejects unauthenticated requests with 401', async () => {
    const app = createApp(new MockGateway() as never)
    await request(app).get(URL(config.sandboxNamespace, 'r1')).expect(401)
  })

  it('rejects bearers without x-service-token with 401', async () => {
    const app = createApp(new MockGateway() as never)
    await request(app)
      .get(URL(config.sandboxNamespace, 'r1'))
      .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
      .expect(401)
  })

  it('rejects requests from a non-rpc-proxy service with 401', async () => {
    const app = createApp(new MockGateway() as never)
    // external-rest-api is a real internal service, but only rpc-proxy is
    // allowed to read the registry.
    await request(app)
      .get(URL(config.sandboxNamespace, 'r1'))
      .set('Authorization', 'Bearer dev-external-rest-api-token')
      .set('x-service-token', 'external-rest-api')
      .expect(401)
  })

  it('returns 404 for an unknown namespace (collapses with recipe-missing)', async () => {
    const app = createApp(new MockGateway() as never)
    const res = await authed(app, 'some-other-ns', 'r1').expect(404)
    expect(res.body).toEqual({ error: 'recipe_not_found' })
  })

  it('returns 404 when the recipe is missing', async () => {
    const app = createApp(new MockGateway() as never)
    const res = await authed(app, config.sandboxNamespace, 'missing').expect(404)
    expect(res.body).toEqual({ error: 'recipe_not_found' })
  })

  it('returns 404 when the recipe has no spec.ui block', async () => {
    const gateway = new MockGateway()
    await seedRecipe(gateway, {
      name: 'r1',
      spec: { workloads: [{ id: 'app', type: 'deployment', image: 'app:1' }] },
      status: { phase: 'active' },
    })
    const app = createApp(gateway as never)
    const res = await authed(app, config.sandboxNamespace, 'r1').expect(404)
    expect(res.body).toEqual({ error: 'no_ui_block' })
  })

  it('returns 409 when the recipe is not yet active', async () => {
    const gateway = new MockGateway()
    await seedRecipe(gateway, {
      name: 'r1',
      spec: {
        workloads: [{ id: 'web', type: 'deployment', image: 'web:1', port: 8080 }],
        ui: { workloadRef: 'web', port: 8080 },
      },
      status: { phase: 'deploying' },
    })
    const app = createApp(gateway as never)
    const res = await authed(app, config.sandboxNamespace, 'r1').expect(409)
    expect(res.body.error).toBe('recipe_not_ready')
    expect(res.body.code).toBe('phase_not_active')
  })

  it('returns the registry entry when active and ui is present', async () => {
    const gateway = new MockGateway()
    await seedRecipe(gateway, {
      name: 'r1',
      spec: {
        workloads: [{ id: 'web', type: 'deployment', image: 'web:1', port: 8080 }],
        ui: {
          workloadRef: 'web',
          port: 8080,
          title: 'My UI',
          icon: 'data:image/png;base64,iVBOR',
          defaultPath: '/dashboard',
        },
      },
      status: { phase: 'active' },
    })
    seedReadyEndpoints(gateway, 'web')
    const app = createApp(gateway as never)
    const res = await authed(app, config.sandboxNamespace, 'r1').expect(200)
    expect(res.body).toEqual({
      appRef: `${config.sandboxNamespace}/r1`,
      service: { name: 'web', namespace: config.sandboxUiNamespace, port: 8080 },
      ready: true,
      title: 'My UI',
      icon: 'data:image/png;base64,iVBOR',
      defaultPath: '/dashboard',
    })
  })

  it('uses status.workloadInstances to resolve the deterministic Service name', async () => {
    const gateway = new MockGateway()
    await seedRecipe(gateway, {
      name: 'r1',
      spec: {
        workloads: [{ id: 'web', type: 'deployment', image: 'web:1', port: 8080 }],
        ui: { workloadRef: 'web', port: 8080 },
      },
      status: {
        phase: 'active',
        workloadInstances: { web: 'r1-web-a1b2c3d4' },
      },
    })
    seedReadyEndpoints(gateway, 'r1-web-a1b2c3d4')
    const app = createApp(gateway as never)
    const res = await authed(app, config.sandboxNamespace, 'r1').expect(200)
    expect(res.body.service.name).toBe('r1-web-a1b2c3d4')
  })

  it('returns 422 when ui.port disagrees with the referenced workload.port', async () => {
    // Recipe is active and has a UI block, but ui.port=8080 while the
    // workload listens on 3000. WRC's Service targets workload.port (3000),
    // so handing 8080 to the Desktop App would route to a closed port.
    const gateway = new MockGateway()
    await seedRecipe(gateway, {
      name: 'r1',
      spec: {
        workloads: [{ id: 'web', type: 'deployment', image: 'web:1', port: 3000 }],
        ui: { workloadRef: 'web', port: 8080 },
      },
      status: { phase: 'active' },
    })
    const app = createApp(gateway as never)
    const res = await authed(app, config.sandboxNamespace, 'r1').expect(422)
    expect(res.body).toEqual({ error: 'recipe_ui_invalid', code: 'ui_port_mismatch' })
  })

  it('returns 422 when the referenced workload has no port', async () => {
    const gateway = new MockGateway()
    await seedRecipe(gateway, {
      name: 'r1',
      spec: {
        workloads: [{ id: 'web', type: 'deployment', image: 'web:1' }],
        ui: { workloadRef: 'web', port: 8080 },
      },
      status: { phase: 'active' },
    })
    const app = createApp(gateway as never)
    const res = await authed(app, config.sandboxNamespace, 'r1').expect(422)
    expect(res.body).toEqual({
      error: 'recipe_ui_invalid',
      code: 'ui_workload_port_missing',
    })
  })

  it('derives the response port from workload.port (single source of truth)', async () => {
    // When the two fields agree (the only path that reaches 200), the
    // resolved port is the workload's. This pins the resolution direction
    // so a future refactor that "fixes" the helper to read ui.port would
    // fail this test.
    const gateway = new MockGateway()
    await seedRecipe(gateway, {
      name: 'r1',
      spec: {
        workloads: [{ id: 'web', type: 'deployment', image: 'web:1', port: 5173 }],
        ui: { workloadRef: 'web', port: 5173 },
      },
      status: { phase: 'active' },
    })
    seedReadyEndpoints(gateway, 'web')
    const app = createApp(gateway as never)
    const res = await authed(app, config.sandboxNamespace, 'r1').expect(200)
    expect(res.body.service.port).toBe(5173)
  })

  it('runs the port validation BEFORE the forUser ACL check (privileged signal ordering)', async () => {
    // A port-mismatched recipe should 422 before we touch the DB —
    // misconfiguration is not user-scoped and should be detectable without
    // an allowlist row.
    const gateway = new MockGateway()
    await seedRecipe(gateway, {
      name: 'r1',
      spec: {
        workloads: [{ id: 'web', type: 'deployment', image: 'web:1', port: 3000 }],
        ui: { workloadRef: 'web', port: 8080 },
      },
      status: { phase: 'active' },
    })
    const app = createApp(gateway as never)
    await authed(app, config.sandboxNamespace, 'r1', 'u1').expect(422)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('defaults defaultPath to "/" when ui omits it', async () => {
    const gateway = new MockGateway()
    await seedRecipe(gateway, {
      name: 'r1',
      spec: {
        workloads: [{ id: 'web', type: 'deployment', image: 'web:1', port: 8080 }],
        ui: { workloadRef: 'web', port: 8080 },
      },
      status: { phase: 'active' },
    })
    seedReadyEndpoints(gateway, 'web')
    const app = createApp(gateway as never)
    const res = await authed(app, config.sandboxNamespace, 'r1').expect(200)
    expect(res.body.defaultPath).toBe('/')
  })

  // ─── Service / Endpoints readiness gate ────────────────────────────

  it('returns 409 service_endpoints_missing when Endpoints does not exist', async () => {
    // Recipe is `active` with a valid UI binding, but the Service's
    // Endpoints object has not been created yet (no pods selected, or
    // the Service itself is missing). Without this gate, rpc-proxy would
    // mint a session and the user would see a generic proxy failure.
    const gateway = new MockGateway()
    await seedRecipe(gateway, {
      name: 'r1',
      spec: {
        workloads: [{ id: 'web', type: 'deployment', image: 'web:1', port: 8080 }],
        ui: { workloadRef: 'web', port: 8080 },
      },
      status: { phase: 'active' },
    })
    // No seedReadyEndpoints call — Endpoints intentionally missing.
    const app = createApp(gateway as never)
    const res = await authed(app, config.sandboxNamespace, 'r1').expect(409)
    expect(res.body.error).toBe('recipe_not_ready')
    expect(res.body.code).toBe('service_endpoints_missing')
  })

  it('returns 409 endpoints_not_ready when Endpoints exists but has 0 Ready addresses', async () => {
    // Pod is still starting / crash-looping / being replaced — Endpoints
    // exists but its `subsets[].addresses` is empty.
    const gateway = new MockGateway()
    await seedRecipe(gateway, {
      name: 'r1',
      spec: {
        workloads: [{ id: 'web', type: 'deployment', image: 'web:1', port: 8080 }],
        ui: { workloadRef: 'web', port: 8080 },
      },
      status: { phase: 'active' },
    })
    seedReadyEndpoints(gateway, 'web', 0)
    const app = createApp(gateway as never)
    const res = await authed(app, config.sandboxNamespace, 'r1').expect(409)
    expect(res.body.error).toBe('recipe_not_ready')
    expect(res.body.code).toBe('endpoints_not_ready')
  })

  it('runs the endpoint readiness gate BEFORE the forUser ACL check', async () => {
    // Readiness is not user-scoped — there's no point hitting the DB
    // when no caller can route to the upstream yet. This also matches
    // the placement of the phase_not_active gate.
    const gateway = new MockGateway()
    await seedRecipe(gateway, {
      name: 'r1',
      spec: {
        workloads: [{ id: 'web', type: 'deployment', image: 'web:1', port: 8080 }],
        ui: { workloadRef: 'web', port: 8080 },
      },
      status: { phase: 'active' },
    })
    seedReadyEndpoints(gateway, 'web', 0)
    const app = createApp(gateway as never)
    await authed(app, config.sandboxNamespace, 'r1', 'u1').expect(409)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  // ─── forUser ACL gate ──────────────────────────────────────────────

  async function activeUiRecipe(): Promise<MockGateway> {
    const g = new MockGateway()
    await seedRecipe(g, {
      name: 'r1',
      spec: {
        workloads: [{ id: 'web', type: 'deployment', image: 'web:1', port: 8080 }],
        ui: { workloadRef: 'web', port: 8080 },
      },
      status: { phase: 'active' },
    })
    seedReadyEndpoints(g, 'web')
    return g
  }

  it('returns 200 when forUser is in user_workflow_triggers', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })
    const app = createApp((await activeUiRecipe()) as never)
    await authed(app, config.sandboxNamespace, 'r1', 'u1').expect(200)
    // Confirm the ACL query ran with the right binding
    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    const [, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(params).toEqual(['u1', config.sandboxNamespace, 'r1'])
  })

  it('returns 200 when forUser has an active current-team workflow trigger grant', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })
    const app = createApp((await activeUiRecipe()) as never)
    await authed(app, config.sandboxNamespace, 'r1', 'u1', 'team-1').expect(200)

    expect(mockPoolQuery).toHaveBeenCalledTimes(2)
    const [teamSql, teamParams] = mockPoolQuery.mock.calls[1] as [string, unknown[]]
    expect(String(teamSql)).toContain('JOIN team_workflow_triggers')
    expect(teamParams).toEqual(['u1', 'team-1', config.sandboxNamespace, 'r1'])
  })

  it('returns 403 when forUser is NOT in user_workflow_triggers', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const app = createApp((await activeUiRecipe()) as never)
    const res = await authed(app, config.sandboxNamespace, 'r1', 'u-stranger').expect(403)
    expect(res.body).toEqual({ error: 'recipe_acl_denied' })
  })

  it('does NOT touch the DB when forUser is omitted', async () => {
    const app = createApp((await activeUiRecipe()) as never)
    await authed(app, config.sandboxNamespace, 'r1').expect(200)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('keeps 404/409 ahead of the ACL check (presence of recipe is the privileged signal)', async () => {
    // No recipe seeded — 404 should fire before the ACL query runs.
    const app = createApp(new MockGateway() as never)
    await authed(app, config.sandboxNamespace, 'missing', 'u1').expect(404)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })
})

// ─── /apps discovery endpoint ──────────────────────────────────────

describe('GET /api/v1/internal/sandbox-ui/apps', () => {
  const VALID_TEAM_ID = '11111111-2222-4333-8444-555555555555'

  const URL_APPS = (forUser?: string, forTeam?: string) => {
    const params = new URLSearchParams()
    if (forUser) params.set('forUser', forUser)
    if (forTeam) params.set('forTeam', forTeam)
    const query = params.toString()
    return query ? `/api/v1/internal/sandbox-ui/apps?${query}` : `/api/v1/internal/sandbox-ui/apps`
  }

  function authedApps(app: ReturnType<typeof createApp>, forUser?: string, forTeam?: string) {
    return request(app)
      .get(URL_APPS(forUser, forTeam))
      .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
      .set('x-service-token', 'rpc-proxy')
  }

  beforeEach(() => {
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  async function seedSet(g: MockGateway): Promise<void> {
    await seedRecipe(g, {
      name: 'r-ui-1',
      spec: {
        workloads: [{ id: 'web', type: 'deployment', image: 'web:1', port: 8080 }],
        ui: {
          workloadRef: 'web',
          port: 8080,
          title: 'App One',
          defaultPath: '/dash',
          icon: 'data:image/png;base64,AAA',
        },
      },
      status: { phase: 'active' },
    })
    await seedRecipe(g, {
      name: 'r-ui-2',
      spec: {
        workloads: [{ id: 'web', type: 'deployment', image: 'web:1', port: 8080 }],
        ui: { workloadRef: 'web', port: 8080, title: 'App Two' },
      },
      status: { phase: 'deploying' }, // not ready
    })
    await seedRecipe(g, {
      name: 'r-no-ui',
      spec: { workloads: [{ id: 'app', type: 'deployment', image: 'app:1' }] },
      status: { phase: 'active' },
    })
  }

  it('rejects unauthenticated requests with 401', async () => {
    const app = createApp(new MockGateway() as never)
    await request(app).get(URL_APPS('u1')).expect(401)
  })

  it('rejects callers other than rpc-proxy with 401', async () => {
    const app = createApp(new MockGateway() as never)
    await request(app)
      .get(URL_APPS('u1'))
      .set('Authorization', 'Bearer dev-external-rest-api-token')
      .set('x-service-token', 'external-rest-api')
      .expect(401)
  })

  it('returns 400 when forUser is missing', async () => {
    const app = createApp(new MockGateway() as never)
    const res = await authedApps(app).expect(400)
    expect(res.body.error).toBe('forUser_required')
  })

  it('returns 400 when forTeam is not a UUID', async () => {
    const app = createApp(new MockGateway() as never)
    const res = await authedApps(app, 'u1', 'not-a-uuid').expect(400)
    expect(res.body.error).toBe('forTeam_invalid')
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('returns an empty list when no UI-bearing recipes exist', async () => {
    const app = createApp(new MockGateway() as never)
    const res = await authedApps(app, 'u1').expect(200)
    expect(res.body).toEqual({ apps: [] })
    // DB should NOT have been queried — short-circuit on empty UI-bearing set
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('intersects the UI-bearing set with the user allowlist (DB join)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ recipe_namespace: config.sandboxNamespace, recipe_name: 'r-ui-1' }],
      rowCount: 1,
    })
    const g = new MockGateway()
    await seedSet(g)
    const app = createApp(g as never)
    const res = await authedApps(app, 'u1').expect(200)
    expect(res.body.apps).toHaveLength(1)
    expect(res.body.apps[0].appRef).toBe(`${config.sandboxNamespace}/r-ui-1`)

    // DB query received the (ns, name) pairs of UI-bearing recipes only —
    // r-no-ui should NOT appear in the param list.
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(String(sql)).toContain('team_workflow_triggers')
    expect(params[0]).toBe('u1')
    expect(params[1]).toBeNull()
    expect(params[3]).toEqual(['r-ui-1', 'r-ui-2'])
  })

  it('intersects the UI-bearing set with active current-team trigger grants', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ recipe_namespace: config.sandboxNamespace, recipe_name: 'r-ui-2' }],
      rowCount: 1,
    })
    const g = new MockGateway()
    await seedSet(g)
    const app = createApp(g as never)
    const res = await authedApps(app, 'u1', VALID_TEAM_ID).expect(200)
    expect(res.body.apps).toHaveLength(1)
    expect(res.body.apps[0].appRef).toBe(`${config.sandboxNamespace}/r-ui-2`)

    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(String(sql)).toContain('team_workflow_triggers')
    expect(String(sql)).toContain('$2::uuid IS NOT NULL')
    expect(String(sql)).toContain('tm.team_id = $2::uuid')
    expect(String(sql)).not.toMatch(/\$2\s+IS\s+NOT\s+NULL/)
    expect(String(sql)).not.toMatch(/tm\.team_id\s*=\s*\$2(?!::uuid)/)
    expect(String(sql)).toContain("tm.status = 'active'")
    expect(params).toEqual([
      'u1',
      VALID_TEAM_ID,
      [config.sandboxNamespace, config.sandboxNamespace],
      ['r-ui-1', 'r-ui-2'],
    ])
  })

  it('types the nullable team parameter when listing apps without a current team', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const g = new MockGateway()
    await seedSet(g)
    const app = createApp(g as never)
    const res = await authedApps(app, 'u1').expect(200)
    expect(res.body).toEqual({ apps: [] })

    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(String(sql)).toContain('$2::uuid IS NOT NULL')
    expect(String(sql)).toContain('tm.team_id = $2::uuid')
    expect(String(sql)).not.toMatch(/\$2\s+IS\s+NOT\s+NULL/)
    expect(String(sql)).not.toMatch(/tm\.team_id\s*=\s*\$2(?!::uuid)/)
    expect(params[1]).toBeNull()
  })

  it('reports per-app readiness from recipe.status.phase', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { recipe_namespace: config.sandboxNamespace, recipe_name: 'r-ui-1' },
        { recipe_namespace: config.sandboxNamespace, recipe_name: 'r-ui-2' },
      ],
      rowCount: 2,
    })
    const g = new MockGateway()
    await seedSet(g)
    const app = createApp(g as never)
    const res = await authedApps(app, 'u1').expect(200)
    const byRef = Object.fromEntries(
      (res.body.apps as Array<{ appRef: string; ready: boolean }>).map(a => [a.appRef, a.ready])
    )
    expect(byRef[`${config.sandboxNamespace}/r-ui-1`]).toBe(true)
    expect(byRef[`${config.sandboxNamespace}/r-ui-2`]).toBe(false)
  })

  it('treats phase casing differences as ready when phase is active', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ recipe_namespace: config.sandboxNamespace, recipe_name: 'r-ui-1' }],
      rowCount: 1,
    })
    const g = new MockGateway()
    await seedRecipe(g, {
      name: 'r-ui-1',
      spec: {
        workloads: [{ id: 'web', type: 'deployment', image: 'web:1', port: 8080 }],
        ui: { workloadRef: 'web', port: 8080, title: 'App One' },
      },
      status: { phase: 'Active' as never },
    })
    const app = createApp(g as never)
    const res = await authedApps(app, 'u1').expect(200)
    expect(res.body.apps).toHaveLength(1)
    expect(res.body.apps[0].phase).toBe('Active')
    expect(res.body.apps[0].ready).toBe(true)
  })

  it('passes through title / icon / defaultPath from spec.ui', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ recipe_namespace: config.sandboxNamespace, recipe_name: 'r-ui-1' }],
      rowCount: 1,
    })
    const g = new MockGateway()
    await seedSet(g)
    const app = createApp(g as never)
    const res = await authedApps(app, 'u1').expect(200)
    expect(res.body.apps[0]).toMatchObject({
      title: 'App One',
      icon: 'data:image/png;base64,AAA',
      defaultPath: '/dash',
    })
  })

  it('omits a recipe when the user is NOT in its allowlist', async () => {
    // DB returns only r-ui-1; r-ui-2 is filtered out
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ recipe_namespace: config.sandboxNamespace, recipe_name: 'r-ui-1' }],
      rowCount: 1,
    })
    const g = new MockGateway()
    await seedSet(g)
    const app = createApp(g as never)
    const res = await authedApps(app, 'u1').expect(200)
    const refs = (res.body.apps as Array<{ appRef: string }>).map(a => a.appRef)
    expect(refs).toEqual([`${config.sandboxNamespace}/r-ui-1`])
  })
})
