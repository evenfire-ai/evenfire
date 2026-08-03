/**
 * E2E: connector credential rotation — E2 "Rollout fallido" (issue #223, Fase 4)
 *
 * Rotates an existing connector's credential to a value that makes the
 * container crash on startup, then asserts the McpServer CRD's
 * `DeploymentReady` condition lands on `False` — and, critically, that the
 * test FAILS if the system ever reports success for that rotation.
 *
 * Pipeline under test:
 *   admin login
 *     → kubectl apply Secret + McpServer (precondition: connector Ready)
 *     → PUT /api/v1/admin/mcp-secrets/:name with the reserved invalid sentinel
 *     → HCC SecretInformer → reconcile → new pod template → rolling update
 *     → mock-mcp-server refuses to start (real crash-loop, not simulated)
 *     → generation-aware readiness never converges
 *     → poll exhausts its budget and writes DeploymentReady=False,
 *       reason=RolloutIncomplete, with the rollout numbers in the message
 *
 * Atajo prohibido que este test específicamente evita: aceptar el 200 del
 * PUT como señal de éxito. La única señal válida es la condición del CRD.
 *
 * Requires:
 *   - minikube cluster with the credential-rotation feature deployed
 *   - port-forward to control-api on :8090 (`make minikube-pf-all`)
 *   - kubectl configured for context KUBECTL_CONTEXT (default clerum-test)
 *
 * Run:
 *   cd tests/e2e && npx vitest run integration/mcp-secret-rotation-failure
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MCP_SERVERS_NAMESPACE,
  ROLLOUT_FAILURE_TIMEOUT_MS,
  ROLLOUT_TIMEOUT_MS,
  ROTATION_INVALID_SENTINEL,
  adminLogin,
  assertRolloutNeverSucceeds,
  clusterDiagnostics,
  deleteMcpServerFixture,
  deploymentReadyCondition,
  getMcpServerResource,
  kubectlApply,
  kubectlSafe,
  localMcpServerYaml,
  putMcpSecret,
  randomSuffix,
  requireControlApiUp,
  secretYaml,
  waitForRolloutCondition,
} from './mcpCredentialRotation.helpers.js'

const RUN_ID = randomSuffix()
const SERVER_NAME = `e2e-rot-fail-${RUN_ID}`
const SECRET_NAME = `${SERVER_NAME}-credentials`

let controlApiUp = false
let adminToken = ''

beforeAll(async () => {
  controlApiUp = await requireControlApiUp('mcp-secret-rotation-failure')
  if (!controlApiUp) return

  adminToken = await adminLogin()

  kubectlApply(
    secretYaml(SECRET_NAME, MCP_SERVERS_NAMESPACE, {
      'api-key': 'initial-valid-value',
    })
  )
  kubectlApply(
    localMcpServerYaml({
      name: SERVER_NAME,
      envSecretName: SECRET_NAME,
      keys: [{ secretKey: 'api-key', envVar: 'E2E_ROTATION_API_KEY' }],
    })
  )
}, 30_000)

afterAll(() => {
  if (!controlApiUp) return
  deleteMcpServerFixture(SERVER_NAME, SECRET_NAME)
})

describe('mcp-secret rotation — E2 rollout fallido', () => {
  it(
    'connector reaches Ready with the initial valid credential (precondition)',
    async () => {
      if (!controlApiUp) return

      const cond = await waitForRolloutCondition(SERVER_NAME, adminToken, {
        expectStatus: 'True',
        sinceMs: 0,
        timeoutMs: ROLLOUT_TIMEOUT_MS,
      })
      expect(cond.status).toBe('True')
    },
    ROLLOUT_TIMEOUT_MS + 10_000
  )

  it(
    'PUT /admin/mcp-secrets rotates to an invalid credential and the CRD condition goes False — never True',
    async () => {
      if (!controlApiUp) return

      const beforeResource = await getMcpServerResource(SERVER_NAME, adminToken)
      const priorCondition = deploymentReadyCondition(beforeResource)
      expect(priorCondition?.status).toBe('True') // sanity: precondition test above actually landed

      const sinceMs = Date.now()
      const { status, data } = await putMcpSecret(
        SECRET_NAME,
        { 'api-key': ROTATION_INVALID_SENTINEL },
        adminToken
      )
      // The PUT itself is expected to succeed — control-api only writes the
      // Secret, it has no idea whether the value will let the container
      // start. Asserting 200 here is NOT the business signal; it only
      // confirms the mutation was accepted so the rollout below is real.
      expect(status, `PUT /admin/mcp-secrets/${SECRET_NAME} body=${JSON.stringify(data)}`).toBe(200)

      // The one and only valid success signal: the CRD condition. This
      // throws immediately if DeploymentReady is ever observed True after
      // `sinceMs` — that is exactly the false-positive this scenario exists
      // to catch — and throws with full diagnostics if the terminal False
      // is never written at all.
      const failedCondition = await assertRolloutNeverSucceeds(
        SERVER_NAME,
        adminToken,
        sinceMs,
        ROLLOUT_FAILURE_TIMEOUT_MS
      )
      expect(failedCondition.status).toBe('False')
      expect(failedCondition.reason).toBe('RolloutIncomplete')
      // The message must be diagnosable, never a silent Unknown (plan Fase 2,
      // point 5) — assert it actually carries rollout numbers, not a generic
      // placeholder string.
      expect(failedCondition.message).toMatch(/generation|updated|ready|unavailable/i)
    },
    ROLLOUT_FAILURE_TIMEOUT_MS + 15_000
  )

  it('the crash-looping pod never became Ready (kubectl-level corroboration)', () => {
    if (!controlApiUp) return

    // A failed credential rotation does NOT drop the Deployment's readyReplicas
    // to 0. With replicas=1 and the default RollingUpdate (maxSurge=1,
    // maxUnavailable=0), Kubernetes keeps the OLD pod Ready while the NEW pod
    // crash-loops on the bad credential — so `.status.readyReplicas` stays at 1
    // (the old pod). That is exactly the trap the HCC readiness fix closes, and
    // asserting readyReplicas===0 here would reproduce the same wrong
    // assumption. Corroborate the failure by the crash itself: at least one pod
    // backing this connector is NOT Ready.
    const readyFlags = kubectlSafe(
      `get pods -n ${MCP_SERVERS_NAMESPACE} -l app=${SERVER_NAME} ` +
        `-o jsonpath='{.items[*].status.containerStatuses[*].ready}'`
    )
    const notReadyCount = (readyFlags ?? '').split(/\s+/).filter(flag => flag === 'false').length
    expect(
      notReadyCount,
      `Expected at least one pod backing ${SERVER_NAME} to be NOT Ready (the new pod crash-looping ` +
        `on the invalid credential), but every container reports ready.\n${clusterDiagnostics(
          MCP_SERVERS_NAMESPACE,
          [
            `get pods -n ${MCP_SERVERS_NAMESPACE} -l app=${SERVER_NAME} -o wide`,
            `describe deployment ${SERVER_NAME} -n ${MCP_SERVERS_NAMESPACE}`,
          ]
        )}`
    ).toBeGreaterThanOrEqual(1)
  })
})
