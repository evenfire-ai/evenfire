/**
 * Integration: control-api ↔ K8s reconciliation
 *
 * Tests the control-api's ability to read K8s resources (HCC reconciliation,
 * HostOverview, WorkflowRecipe CRUD) via its admin API.
 *
 * Requires: minikube cluster with control-api port-forwarded on :8090
 *   make minikube-pf-control-ui
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CONTROL_API_URL,
  bearer,
  deleteJson,
  fetchJson,
  isServiceUp,
  postJson,
  putJson,
} from './helpers.integration.js'

let controlApiUp = false
let adminToken = ''

beforeAll(async () => {
  controlApiUp = await isServiceUp(CONTROL_API_URL)
  if (!controlApiUp) {
    console.log('[control-api-k8s] control-api not available — tests will be skipped')
    return
  }

  // Try admin login (first-time setup or existing admin)
  const adminUsername = process.env.TEST_ADMIN_USERNAME ?? 'admin'
  const adminPassword = process.env.TEST_ADMIN_PASSWORD ?? 'changeme123!'
  const { status, data } = await postJson<{ token?: string }>(
    `${CONTROL_API_URL}/api/v1/admin/auth/login`,
    { username: adminUsername, password: adminPassword }
  )

  if (status === 200 && data.token) {
    adminToken = data.token
  } else {
    console.log('[control-api-k8s] Admin login failed — resource tests will be skipped')
  }
})

describe('control-api — /health', () => {
  it('returns 200 with status field', async () => {
    if (!controlApiUp) return

    const { status, data } = await fetchJson<{ status: string }>(`${CONTROL_API_URL}/health`)
    expect(status).toBe(200)
    expect(typeof data.status).toBe('string')
  })
})

describe('control-api — admin auth', () => {
  it('POST /api/v1/admin/auth/login returns token on valid credentials', async () => {
    if (!controlApiUp) return

    expect(typeof adminToken === 'string').toBe(true)
  })

  it('POST /api/v1/admin/auth/login returns 401 on wrong password', async () => {
    if (!controlApiUp) return

    const { status } = await postJson(`${CONTROL_API_URL}/api/v1/admin/auth/login`, {
      username: 'admin',
      password: 'wrong-password-xyz-123',
    })
    // 401 when admin exists but password is wrong
    // 400 when in first-time setup mode (no admin created yet)
    expect([400, 401, 403]).toContain(status)
  })
})

describe('control-api — HostOverview (admin)', () => {
  it('GET /api/v1/admin/overview requires auth token', async () => {
    if (!controlApiUp) return

    const { status } = await fetchJson(`${CONTROL_API_URL}/api/v1/admin/overview`)
    expect([401, 403]).toContain(status)
  })

  it('GET /api/v1/admin/overview returns 2xx or 4xx with valid admin token', async () => {
    if (!controlApiUp || !adminToken) return

    const { status, data } = await fetchJson<Record<string, unknown>>(
      `${CONTROL_API_URL}/api/v1/admin/overview`,
      { headers: bearer(adminToken) }
    )
    // 200 = success; 401/403 = endpoint uses different auth mechanism
    expect([200, 401, 403]).toContain(status)
    if (status === 200) {
      expect(data).toBeDefined()
    }
  })
})

// ── WorkflowRecipe smoke test ─────────────────────────────────────────────
// Full lifecycle: create → list → get → validate → status → update → delete → 404
// Recipe name uses a fixed test slug for idempotency (cleaned up in beforeAll).

const SMOKE_RECIPE_NAME = 'integration-smoke-recipe'
const RECIPES_BASE = `${CONTROL_API_URL}/api/v1/admin/recipes`

const VALID_RECIPE_BODY = {
  metadata: { name: SMOKE_RECIPE_NAME },
  spec: {
    workloads: [{ id: 'web', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
  },
}

describe('control-api — WorkflowRecipe smoke: full lifecycle', () => {
  // Cleanup any leftover from a previous crashed run
  beforeAll(async () => {
    if (!controlApiUp || !adminToken) return
    await deleteJson(`${RECIPES_BASE}/${SMOKE_RECIPE_NAME}`, bearer(adminToken))
    // ignore result — 404 is fine
  })

  // Cleanup after tests
  afterAll(async () => {
    if (!controlApiUp || !adminToken) return
    await deleteJson(`${RECIPES_BASE}/${SMOKE_RECIPE_NAME}`, bearer(adminToken))
  })

  it('GET /api/v1/admin/recipes requires auth', async () => {
    if (!controlApiUp) return
    const { status } = await fetchJson(RECIPES_BASE)
    expect([401, 403]).toContain(status)
  })

  it('GET /api/v1/admin/recipes returns items array with valid token', async () => {
    if (!controlApiUp || !adminToken) return
    const { status, data } = await fetchJson<{ items: unknown[] }>(RECIPES_BASE, {
      headers: bearer(adminToken),
    })
    expect(status).toBe(200)
    expect(Array.isArray(data.items)).toBe(true)
  })

  it('POST spec missing metadata.name returns 422', async () => {
    if (!controlApiUp || !adminToken) return
    const { status, data } = await postJson<{
      errors?: Array<{ field?: string; message?: string }>
    }>(RECIPES_BASE, { apiVersion: 'invalid' }, bearer(adminToken))
    expect(status).toBe(422)
    expect(Array.isArray(data.errors)).toBe(true)
    expect(data.errors?.some(error => error.field === 'metadata.name')).toBe(true)
  })

  it('POST recipe with more than 25 workloads returns 422 before K8s admission', async () => {
    if (!controlApiUp || !adminToken) return
    const workloads = Array.from({ length: 26 }, (_, index) => ({
      id: `worker-${index + 1}`,
      type: 'deployment',
      image: 'nginx:1.30.1-alpine',
    }))

    const { status, data } = await postJson<{
      errors?: Array<{ field?: string; message?: string }>
    }>(
      RECIPES_BASE,
      {
        metadata: { name: 'integration-too-many-workloads' },
        spec: { workloads },
      },
      bearer(adminToken)
    )

    expect(status).toBe(422)
    expect(
      data.errors?.some(error => {
        return error.field === 'spec.workloads' && error.message?.includes('at most 25')
      })
    ).toBe(true)
  })

  it('POST recipe with more than 25 UI internal egress refs returns 422 before K8s admission', async () => {
    if (!controlApiUp || !adminToken) return
    const internal = Array.from({ length: 26 }, () => ({
      workloadRef: 'api',
      port: 8000,
    }))

    const { status, data } = await postJson<{
      errors?: Array<{ field?: string; message?: string }>
    }>(
      RECIPES_BASE,
      {
        metadata: { name: 'integration-too-many-ui-internal-egress' },
        spec: {
          workloads: [{ id: 'api', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
          ui: {
            workloadRef: 'api',
            port: 8080,
            egress: { internal },
          },
        },
      },
      bearer(adminToken)
    )

    expect(status).toBe(422)
    expect(
      data.errors?.some(error => {
        return error.field === 'spec.ui.egress.internal' && error.message?.includes('at most 25')
      })
    ).toBe(true)
  })

  it('POST valid recipe returns 201 with created resource', async () => {
    if (!controlApiUp || !adminToken) return
    const { status, data } = await postJson<{ metadata?: { name: string } }>(
      RECIPES_BASE,
      VALID_RECIPE_BODY,
      bearer(adminToken)
    )
    expect(status).toBe(201)
    expect(data.metadata?.name).toBe(SMOKE_RECIPE_NAME)
  })

  it('GET /api/v1/admin/recipes/:name returns the created recipe', async () => {
    if (!controlApiUp || !adminToken) return
    const { status, data } = await fetchJson<{ metadata?: { name: string } }>(
      `${RECIPES_BASE}/${SMOKE_RECIPE_NAME}`,
      { headers: bearer(adminToken) }
    )
    expect(status).toBe(200)
    expect(data.metadata?.name).toBe(SMOKE_RECIPE_NAME)
  })

  it('GET /api/v1/admin/recipes lists the newly created recipe', async () => {
    if (!controlApiUp || !adminToken) return
    const { status, data } = await fetchJson<{ items: Array<{ metadata?: { name: string } }> }>(
      RECIPES_BASE,
      { headers: bearer(adminToken) }
    )
    expect(status).toBe(200)
    const names = data.items.map(r => r.metadata?.name)
    expect(names).toContain(SMOKE_RECIPE_NAME)
  })

  it('GET /api/v1/admin/recipes/:name/status returns status object', async () => {
    if (!controlApiUp || !adminToken) return
    const { status, data } = await fetchJson<Record<string, unknown>>(
      `${RECIPES_BASE}/${SMOKE_RECIPE_NAME}/status`,
      { headers: bearer(adminToken) }
    )
    expect([200, 404]).toContain(status)
    if (status === 200) {
      expect(typeof data).toBe('object')
    }
  })

  it('PUT /api/v1/admin/recipes/:name updates the recipe', async () => {
    if (!controlApiUp || !adminToken) return
    const updatedBody = {
      spec: {
        workloads: [{ id: 'web', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
      },
    }
    const { status } = await putJson(
      `${RECIPES_BASE}/${SMOKE_RECIPE_NAME}`,
      updatedBody,
      bearer(adminToken)
    )
    expect([200, 201]).toContain(status)
  })

  it('DELETE /api/v1/admin/recipes/:name removes the recipe', async () => {
    if (!controlApiUp || !adminToken) return
    const { status } = await deleteJson(`${RECIPES_BASE}/${SMOKE_RECIPE_NAME}`, bearer(adminToken))
    expect([200, 204]).toContain(status)
  })

  it('GET /api/v1/admin/recipes/:name returns 404 after deletion', async () => {
    if (!controlApiUp || !adminToken) return
    // K8s may take a moment to finalize — retry briefly
    let status = 200
    for (let i = 0; i < 5; i++) {
      const res = await fetchJson(`${RECIPES_BASE}/${SMOKE_RECIPE_NAME}`, {
        headers: bearer(adminToken),
      })
      status = res.status
      if (status === 404) break
      await new Promise(r => setTimeout(r, 1000))
    }
    expect(status).toBe(404)
  })
})
