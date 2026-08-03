/**
 * E2E: connector credential rotation — E8 "Regresión de readiness" / R2
 * (issue #223, Fase 4)
 *
 * The generation-aware readiness check (host-context-controller/src/reconciler.ts
 * readDeploymentRollout) is stricter than the old `readyReplicas > 0` check —
 * it now requires observedGeneration to have caught up AND
 * updated/ready/unavailable replica counts to all agree. That stricter gate
 * governs EVERY connector's rollout, not just rotations (plan section 3, R2).
 * This test has no rotation in it at all: a brand-new connector must still
 * reach Ready within the poll budget (24 attempts x 5s = 120s,
 * reconciler.ts pollReadiness).
 *
 * Run:
 *   cd tests/e2e && npx vitest run integration/mcp-server-readiness-regression
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MCP_SERVERS_NAMESPACE,
  ROLLOUT_TIMEOUT_MS,
  adminLogin,
  clusterDiagnostics,
  kubectl,
  kubectlApply,
  kubectlJson,
  kubectlSafe,
  localMcpServerYaml,
  randomSuffix,
  requireControlApiUp,
  secretYaml,
  waitForRolloutCondition,
} from './mcpCredentialRotation.helpers.js'

const RUN_ID = randomSuffix()
const SERVER_NAME = `e2e-rot-readiness-${RUN_ID}`
const SECRET_NAME = `${SERVER_NAME}-credentials`

let controlApiUp = false
let adminToken = ''

beforeAll(async () => {
  controlApiUp = await requireControlApiUp('mcp-server-readiness-regression')
  if (!controlApiUp) return
  adminToken = await adminLogin()
}, 15_000)

afterAll(() => {
  if (!controlApiUp) return
  kubectlSafe(
    `delete mcpserver ${SERVER_NAME} -n ${MCP_SERVERS_NAMESPACE} --ignore-not-found --timeout=20s`
  )
  kubectlSafe(
    `delete secret ${SECRET_NAME} -n ${MCP_SERVERS_NAMESPACE} --ignore-not-found --timeout=10s`
  )
})

describe('mcp-secret rotation — E8 regresión de readiness (R2)', () => {
  it(
    'a brand-new connector (no rotation involved) reaches Ready within the poll budget',
    async () => {
      if (!controlApiUp) return

      kubectlApply(
        secretYaml(SECRET_NAME, MCP_SERVERS_NAMESPACE, { 'api-key': 'readiness-check-value' })
      )
      const createdAt = Date.now()
      kubectlApply(
        localMcpServerYaml({
          name: SERVER_NAME,
          envSecretName: SECRET_NAME,
          keys: [{ secretKey: 'api-key', envVar: 'E2E_ROTATION_API_KEY' }],
        })
      )

      const cond = await waitForRolloutCondition(SERVER_NAME, adminToken, {
        expectStatus: 'True',
        sinceMs: createdAt,
        timeoutMs: ROLLOUT_TIMEOUT_MS,
      })
      expect(cond.status).toBe('True')
      expect(cond.reason).toBe('ReplicasAvailable')

      // Corroborate directly against the Deployment status — the same four
      // fields readDeploymentRollout requires to ALL hold simultaneously.
      const deployment = kubectlJson<{
        metadata: { generation: number }
        spec: { replicas: number }
        status: {
          observedGeneration: number
          updatedReplicas?: number
          readyReplicas?: number
          unavailableReplicas?: number
        }
      }>(`get deployment ${SERVER_NAME} -n ${MCP_SERVERS_NAMESPACE}`)

      const diag = () =>
        clusterDiagnostics(MCP_SERVERS_NAMESPACE, [
          `describe deployment ${SERVER_NAME} -n ${MCP_SERVERS_NAMESPACE}`,
        ])

      expect(deployment.status.observedGeneration, diag()).toBeGreaterThanOrEqual(
        deployment.metadata.generation
      )
      expect(deployment.status.updatedReplicas ?? 0, diag()).toBe(deployment.spec.replicas)
      expect(deployment.status.readyReplicas ?? 0, diag()).toBe(deployment.spec.replicas)
      expect(deployment.status.unavailableReplicas ?? 0, diag()).toBe(0)
    },
    ROLLOUT_TIMEOUT_MS + 15_000
  )

  it('the pod backing the connector is actually Running (not just "the Deployment object looks converged")', () => {
    if (!controlApiUp) return

    const phase = kubectl(
      `get pod -l app=${SERVER_NAME} -n ${MCP_SERVERS_NAMESPACE} -o jsonpath='{.items[0].status.phase}'`
    )
    expect(phase).toBe('Running')
  })
})
