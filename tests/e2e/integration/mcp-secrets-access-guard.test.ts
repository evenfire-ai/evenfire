/**
 * E2E: connector credential rotation — E9 "Guardia de acceso" (issue #223, Fase 4)
 *
 * PUT /api/v1/admin/mcp-secrets/:name without an operator session must be
 * rejected — the same `requireAuthForControlUI` gate every other /admin
 * route goes through (control-api/src/app.ts:139-149). No fixture or mock
 * stands in for auth here: this hits the real route on the real cluster.
 *
 * Run:
 *   cd tests/e2e && npx vitest run integration/mcp-secrets-access-guard
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MCP_SERVERS_NAMESPACE,
  kubectlApply,
  kubectlSafe,
  putMcpSecret,
  randomSuffix,
  requireControlApiUp,
  secretYaml,
} from './mcpCredentialRotation.helpers.js'

const RUN_ID = randomSuffix()
const SECRET_NAME = `e2e-rot-guard-${RUN_ID}`

let controlApiUp = false

beforeAll(async () => {
  controlApiUp = await requireControlApiUp('mcp-secrets-access-guard')
  if (!controlApiUp) return

  // Precondition only: a Secret must exist for the route to reach its auth
  // gate meaningfully (a 404 for "no such secret" would be a false pass).
  // Written via kubectl because this test's business is authorization, not
  // rotation — the PUT under test is the request WITHOUT a token, never
  // used to establish state.
  kubectlApply(secretYaml(SECRET_NAME, MCP_SERVERS_NAMESPACE, { 'api-key': 'guarded-value' }))
}, 15_000)

afterAll(() => {
  if (!controlApiUp) return
  kubectlSafe(
    `delete secret ${SECRET_NAME} -n ${MCP_SERVERS_NAMESPACE} --ignore-not-found --timeout=10s`
  )
})

describe('mcp-secret rotation — E9 guardia de acceso', () => {
  it('PUT without a session cookie is rejected (401/403), never 200', async () => {
    if (!controlApiUp) return

    const { status, data } = await putMcpSecret(SECRET_NAME, { 'api-key': 'attempted-bypass' })
    expect([401, 403], `expected 401/403, got ${status}: ${JSON.stringify(data)}`).toContain(status)
  })

  it('PUT with a garbage session cookie is rejected (401/403), never 200', async () => {
    if (!controlApiUp) return

    const { status, data } = await putMcpSecret(
      SECRET_NAME,
      { 'api-key': 'attempted-bypass-2' },
      'not-a-real-session-jwt'
    )
    expect([401, 403], `expected 401/403, got ${status}: ${JSON.stringify(data)}`).toContain(status)
  })
})
