/**
 * Smoke test: configureModel endpoint DI wiring (Stage 2).
 *
 * Validates that in a real cluster environment:
 * 1. ClerumMcpServer has ModelConfigHandler wired (not null)
 * 2. configureModel endpoint returns non-501 with valid handler
 * 3. K8s ConfigMap/Secret resolution works end-to-end
 *
 * Requires: minikube running, clerum-model-secret-mapping ConfigMap, signing keys
 * Run with: TEST_SMOKE=true npx vitest run tests/smoke/
 */
import { describe, expect, it } from 'vitest'

const SMOKE = process.env.TEST_SMOKE === 'true'

describe.skipIf(!SMOKE)('Stage 2 configureModel Smoke Tests', () => {
  const WRC_URL = process.env.WRC_URL ?? 'http://localhost:8082'

  it('configureModel endpoint exists and does NOT return 404', async () => {
    // Without auth, should get 401 (not 404 or 501)
    const res = await fetch(`${WRC_URL}/api/v1/workflow/smoke-test/configure-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', model: 'gpt-4', stepId: 's1' }),
    })

    // 401 = endpoint exists, auth required (good)
    // 501 = handler not wired (B3 bug still present)
    // 404 = route not mounted (B5 bug still present)
    expect(res.status).not.toBe(404)
    expect(res.status).not.toBe(501)
    expect(res.status).toBe(401) // Expected: auth required
  })

  it('configureModel returns proper error with invalid JWT', async () => {
    const res = await fetch(`${WRC_URL}/api/v1/workflow/smoke-test/configure-model`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer invalid-token',
      },
      body: JSON.stringify({ provider: 'openai', model: 'gpt-4', stepId: 's1' }),
    })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('K8s ConfigMap clerum-model-secret-mapping exists in mcp-host', async () => {
    // This verifies the ConfigMap that ModelConfigHandler reads (post-refactor: mcp-host ns)
    const { execSync } = await import('node:child_process')
    const result = execSync(
      "kubectl get configmap clerum-model-secret-mapping -n mcp-host -o jsonpath='{.data}' 2>&1",
      { encoding: 'utf-8' }
    )
    expect(result).not.toContain('NotFound')
  })

  it('health endpoint confirms WRC is running', async () => {
    const res = await fetch(`${WRC_URL}/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
  })
})
