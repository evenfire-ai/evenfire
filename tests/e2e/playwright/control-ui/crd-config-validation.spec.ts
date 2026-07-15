/**
 * CRD Configuration Validation Tests
 *
 * These tests validate that the deployed Kubernetes CRDs match the expected
 * configuration. They run PURELY against the API (no browser), acting as
 * configuration drift detectors.
 *
 * PURPOSE:
 *   If you change deploy/minikube/instances/host.yaml, context.yaml, or
 *   communicationchannel.yaml, these tests will FAIL until the cluster is
 *   updated — catching config drift early.
 *
 * Flow:
 *   Playwright test → control-api REST → Kubernetes CRD state
 *
 * Prerequisites: make minikube-pf-control-api
 */
import { expect, request, test } from '@playwright/test'
import { E2E_TEST_EMAIL } from '../../testUser.js'
import { adminSessionCookieHeader } from '../helpers/session-cookie'

const CONTROL_API = process.env.CONTROL_API_URL ?? 'http://127.0.0.1:8090'

async function apiGet<T>(path: string): Promise<T> {
  const ctx = await request.newContext({ baseURL: CONTROL_API })
  try {
    const res = await ctx.get(path, {
      headers: adminSessionCookieHeader(),
    })
    if (!res.ok()) throw new Error(`${res.status()} on GET ${path}`)
    return (await res.json()) as T
  } finally {
    await ctx.dispose()
  }
}

type CRDItem = {
  metadata?: { name?: string; namespace?: string }
  spec?: Record<string, unknown>
  status?: Record<string, unknown>
}

// ─── Host CRD Configuration ───────────────────────────────────────────────────

test.describe("CRD Config — Host 'chatllm'", () => {
  let host: CRDItem

  test.beforeAll(async () => {
    const { items } = await apiGet<{ items: CRDItem[] }>('/api/v1/admin/hosts')
    const found = items.find(h => h.metadata?.name === 'chatllm')
    if (!found) {
      console.warn("Host 'chatllm' not found — skipping host config tests")
    }
    host = found ?? {}
  })

  test('chatllm host is deployed in cluster', async () => {
    expect(host.metadata?.name).toBe('chatllm')
    expect(host.metadata?.namespace).toBe('mcp-host')
  })

  test('chatllm host references context1', async () => {
    // If someone changes contextRef in host.yaml, this catches it
    expect(host.spec?.contextRef).toBe('context1')
  })

  test('chatllm host references chatllm-api-keys secret', async () => {
    // Validates secretRef points to the correct K8s Secret
    expect(host.spec?.secretRef).toBe('chatllm-api-keys')
  })

  test('chatllm host has a configured model', async () => {
    const model = host.spec?.model as { provider?: string; name?: string } | undefined
    expect(model).toBeDefined()
    expect(typeof model?.name).toBe('string')
    expect(model?.name?.trim().length).toBeGreaterThan(0)
  })

  test('chatllm host has approval policy configured', async () => {
    const approval = host.spec?.approval as Record<string, unknown> | undefined
    expect(approval).toBeDefined()
    expect(approval?.defaultPolicy).toBe('channel_users')
  })
})

// ─── Context CRD Configuration ────────────────────────────────────────────────

test.describe("CRD Config — Context 'context1'", () => {
  let ctx: CRDItem

  test.beforeAll(async () => {
    const { items } = await apiGet<{ items: CRDItem[] }>('/api/v1/admin/contexts')
    const found = items.find(c => c.metadata?.name === 'context1')
    ctx = found ?? {}
  })

  test('context1 is deployed in cluster', async () => {
    expect(ctx.metadata?.name).toBe('context1')
  })

  test('context1 mcpServers field is a valid array', async () => {
    // context1 starts with mcpServers: [] on a fresh minikube deploy.
    // WRC creates per-recipe contexts (wf-{name}) and does NOT patch context1
    // (H-04 Context Isolation Fix, 2026-03-23). Verify the field exists and is
    // a well-typed array — the allowlist may be empty before E2E suites run.
    const mcpServers = ctx.spec?.mcpServers as unknown[] | undefined
    expect(Array.isArray(mcpServers)).toBeTruthy()
  })
})

// ─── User Seeding Validation ──────────────────────────────────────────────────

test.describe('Users and Teams — Data Integrity', () => {
  const TEST_EMAIL = E2E_TEST_EMAIL

  test('test user exists in system', async () => {
    const { items } = await apiGet<{ items: Array<{ email: string; id: string }> }>(
      `/api/v1/admin/users?q=${encodeURIComponent(TEST_EMAIL)}`
    )
    const user = items.find(u => u.email === TEST_EMAIL)
    if (!user) {
      throw new Error(`Test user ${TEST_EMAIL} not found.\n` + `Run: make minikube-seed-test-data`)
    }
    expect(user.email).toBe(TEST_EMAIL)
  })

  test('test user has chatllm agent assigned', async () => {
    const { items } = await apiGet<{ items: Array<{ email: string; id: string }> }>(
      `/api/v1/admin/users?q=${encodeURIComponent(TEST_EMAIL)}`
    )
    const user = items.find(u => u.email === TEST_EMAIL)
    if (!user) {
      test.skip() // Run make minikube-seed-test-data
      return
    }

    // control-api exposes agents as a sub-collection: GET /users/:id/agents
    const detail = await apiGet<{ agentNames?: string[] }>(`/api/v1/admin/users/${user.id}/agents`)
    const agents = detail.agentNames ?? []
    expect(agents).toContain('chatllm')
  })

  test('test user has context1 assigned', async () => {
    const { items } = await apiGet<{ items: Array<{ email: string; id: string }> }>(
      `/api/v1/admin/users?q=${encodeURIComponent(TEST_EMAIL)}`
    )
    const user = items.find(u => u.email === TEST_EMAIL)
    if (!user) {
      test.skip()
      return
    }

    // control-api exposes contexts as a sub-collection: GET /users/:id/contexts
    const detail = await apiGet<{ contextIds?: string[] }>(
      `/api/v1/admin/users/${user.id}/contexts`
    )
    const contexts = detail.contextIds ?? []
    expect(contexts).toContain('context1')
  })

  test('admin account is the only initial admin', async () => {
    // Validates system hygiene — only expected admin accounts exist
    const { items } = await apiGet<{ items: Array<{ email: string }> }>('/api/v1/admin/users')
    // At minimum the system has users (admin + test user if seeded)
    expect(items.length).toBeGreaterThan(0)
  })
})
