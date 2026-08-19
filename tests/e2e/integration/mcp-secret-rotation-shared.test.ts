/**
 * E2E: connector credential rotation — E5 "Secret compartido" (issue #223, Fase 4)
 *
 * Two connectors reference the SAME envSecret. One rotation must roll BOTH
 * Deployments, and both must actually be serving the new credential
 * afterward — not just "Ready" per Kubernetes bookkeeping.
 *
 * Also carries C7 (plan section 6): `affectedConnectors` in the PUT response
 * must name BOTH connectors. A test fixture with an invented shape would
 * validate the filter tautologically; this hits the real
 * `gateway.listResource('mcpservers', ns)` shape, so if it ever diverges
 * from what the route assumes, `affectedConnectors` silently returns `[]`
 * and this test is what catches it.
 *
 * "Ambos responden" is verified by asking each connector's OWN pod, through
 * its own Service (transient port-forward, no shared infra), what value of
 * E2E_ROTATION_API_KEY it currently has injected — proving the pod actually
 * restarted with the new credential, not just that the Deployment object
 * looks converged.
 *
 * Run:
 *   cd tests/e2e && npx vitest run integration/mcp-secret-rotation-shared
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MCP_SERVERS_NAMESPACE,
  ROLLOUT_TIMEOUT_MS,
  adminLogin,
  deleteMcpServerFixture,
  kubectlApply,
  localMcpServerYaml,
  putMcpSecret,
  randomSuffix,
  requireControlApiUp,
  secretYaml,
  waitForRolloutCondition,
  withServicePortForward,
} from './mcpCredentialRotation.helpers.js'

const RUN_ID = randomSuffix()
const SHARED_SECRET_NAME = `e2e-rot-shared-${RUN_ID}`
const SERVER_1 = `e2e-rot-shared-c1-${RUN_ID}`
const SERVER_2 = `e2e-rot-shared-c2-${RUN_ID}`

let controlApiUp = false
let adminToken = ''

beforeAll(async () => {
  controlApiUp = await requireControlApiUp('mcp-secret-rotation-shared')
  if (!controlApiUp) return

  adminToken = await adminLogin()

  kubectlApply(
    secretYaml(SHARED_SECRET_NAME, MCP_SERVERS_NAMESPACE, { 'api-key': 'initial-shared-value' })
  )
  kubectlApply(
    localMcpServerYaml({
      name: SERVER_1,
      envSecretName: SHARED_SECRET_NAME,
      keys: [{ secretKey: 'api-key', envVar: 'E2E_ROTATION_API_KEY' }],
    })
  )
  kubectlApply(
    localMcpServerYaml({
      name: SERVER_2,
      envSecretName: SHARED_SECRET_NAME,
      keys: [{ secretKey: 'api-key', envVar: 'E2E_ROTATION_API_KEY' }],
    })
  )

  await Promise.all([
    waitForRolloutCondition(SERVER_1, adminToken, {
      expectStatus: 'True',
      sinceMs: 0,
      timeoutMs: ROLLOUT_TIMEOUT_MS,
    }),
    waitForRolloutCondition(SERVER_2, adminToken, {
      expectStatus: 'True',
      sinceMs: 0,
      timeoutMs: ROLLOUT_TIMEOUT_MS,
    }),
  ])
}, ROLLOUT_TIMEOUT_MS + 30_000)

afterAll(() => {
  if (!controlApiUp) return
  // Only one Secret backs both connectors — delete it once, after both
  // McpServers are gone (kubectlSafe ignores already-deleted resources).
  deleteMcpServerFixture(SERVER_1, SHARED_SECRET_NAME)
  deleteMcpServerFixture(SERVER_2, SHARED_SECRET_NAME)
})

describe('mcp-secret rotation — E5 secret compartido + C7', () => {
  it(
    'PUT names BOTH connectors in affectedConnectors (C7), and BOTH roll',
    async () => {
      if (!controlApiUp) return

      const sinceMs = Date.now()
      const { status, data } = await putMcpSecret(
        SHARED_SECRET_NAME,
        { 'api-key': 'rotated-shared-value' },
        adminToken
      )
      expect(status, `PUT failed: ${JSON.stringify(data)}`).toBe(200)
      const body = data as { affectedConnectors: string[] }
      expect(body.affectedConnectors.sort()).toEqual([SERVER_1, SERVER_2].sort())

      const [cond1, cond2] = await Promise.all([
        waitForRolloutCondition(SERVER_1, adminToken, {
          expectStatus: 'True',
          sinceMs,
          timeoutMs: ROLLOUT_TIMEOUT_MS,
        }),
        waitForRolloutCondition(SERVER_2, adminToken, {
          expectStatus: 'True',
          sinceMs,
          timeoutMs: ROLLOUT_TIMEOUT_MS,
        }),
      ])
      expect(cond1.status).toBe('True')
      expect(cond2.status).toBe('True')
    },
    ROLLOUT_TIMEOUT_MS + 20_000
  )

  it('both connectors actually serve the NEW credential after rollout ("ambos responden")', async () => {
    if (!controlApiUp) return

    for (const server of [SERVER_1, SERVER_2]) {
      const observedKey = await withServicePortForward(
        MCP_SERVERS_NAMESPACE,
        server,
        3001,
        async baseUrl => {
          const res = await fetch(`${baseUrl}/whoami-credential`, {
            signal: AbortSignal.timeout(5_000),
          })
          expect(res.status, `${server} /whoami-credential returned ${res.status}`).toBe(200)
          const json = (await res.json()) as { key: string | null }
          return json.key
        },
        20_000,
        // /whoami-credential lives on the mock's health server (3001), which the
        // connector's Service does not publish — forward to the Deployment/pod.
        'deploy'
      )
      expect(observedKey, `${server} is not serving the rotated credential`).toBe(
        'rotated-shared-value'
      )
    }
  }, 30_000)
})
