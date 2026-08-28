/**
 * E2E: connector credential rotation — E3 "Preservación" (issue #223, Fase 4)
 *
 * Rotates ONE of two keys on a connector's Secret and asserts the other key
 * survives untouched. Also carries two of the plan's "tests de composición"
 * (section 6) that specifically need a REAL cluster round-trip, not a mock:
 *
 *   C3 — gateway.mergeSecret() <-> the `patch` verb actually granted in the
 *        cluster's RBAC. A unit test mocks the gateway and never touches
 *        RBAC; the trip-wire here is exercising the REAL PUT. If the
 *        deployed Role is missing `patch` on secrets, the request fails and
 *        THIS test must fail loudly with the API server's own message — it
 *        must not degrade to a skip or swallow the error.
 *
 *   C2 — the namespace control-api WRITES the Secret in
 *        (MCP_SERVERS_NAMESPACE) vs. the namespace the HCC informer WATCHES
 *        (CONTEXT_MAPPER_NAMESPACE) are two independent env vars. If they
 *        diverge, nothing rolls, in silence. The only way to catch that from
 *        outside both processes is to rotate through the real endpoint and
 *        confirm the informer actually reconciled — which is exactly what
 *        waiting for a NEW DeploymentReady transition after the PUT proves.
 *
 *   C4 — the credentials-revision annotation must hash the Secret's REAL
 *        post-merge content, not a stale pre-merge read. Verified by reading
 *        the Secret back from the cluster, hashing it with the exact
 *        canonicalStringify+sha256 algorithm host-context-controller uses,
 *        and comparing to the annotation actually on the pod template.
 *
 * Atajos prohibidos evitados aquí: no se escribe el Secret con kubectl (sólo
 * se lee, para el hash) y no se asume éxito por el 200 del PUT — la
 * preservación se verifica leyendo el Secret real, y el rollout se verifica
 * en el CRD.
 *
 * Run:
 *   cd tests/e2e && npx vitest run integration/mcp-secret-rotation-preservation
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MCP_SERVERS_NAMESPACE,
  ROLLOUT_TIMEOUT_MS,
  adminLogin,
  canonicalStringify,
  deleteMcpServerFixture,
  deploymentCredentialsRevisionAnnotation,
  kubectlApply,
  kubectlJson,
  localMcpServerYaml,
  putMcpSecret,
  randomSuffix,
  requireControlApiUp,
  secretDataHash,
  secretYaml,
  waitForRolloutCondition,
} from './mcpRotation.helpers.js'

const RUN_ID = randomSuffix()
const SERVER_NAME = `e2e-rot-preserve-${RUN_ID}`
const SECRET_NAME = `${SERVER_NAME}-credentials`

let controlApiUp = false
let adminToken = ''

beforeAll(async () => {
  controlApiUp = await requireControlApiUp('mcp-secret-rotation-preservation')
  if (!controlApiUp) return

  adminToken = await adminLogin()

  kubectlApply(
    secretYaml(SECRET_NAME, MCP_SERVERS_NAMESPACE, {
      'api-key': 'initial-api-key-value',
      'webhook-secret': 'initial-webhook-secret-value',
    })
  )
  kubectlApply(
    localMcpServerYaml({
      name: SERVER_NAME,
      envSecretName: SECRET_NAME,
      keys: [
        { secretKey: 'api-key', envVar: 'E2E_ROTATION_API_KEY' },
        { secretKey: 'webhook-secret', envVar: 'E2E_ROTATION_WEBHOOK_SECRET' },
      ],
    })
  )

  await waitForRolloutCondition(SERVER_NAME, adminToken, {
    expectStatus: 'True',
    sinceMs: 0,
    timeoutMs: ROLLOUT_TIMEOUT_MS,
  })
}, ROLLOUT_TIMEOUT_MS + 30_000)

afterAll(() => {
  if (!controlApiUp) return
  deleteMcpServerFixture(SERVER_NAME, SECRET_NAME)
})

describe('mcp-secret rotation — E3 preservación + C2 + C3 + C4', () => {
  it(
    'PUT with only api-key rotates that key, preserves webhook-secret, and triggers a real rollout (C2, C3)',
    async () => {
      if (!controlApiUp) return

      const sinceMs = Date.now()
      const { status, data } = await putMcpSecret(
        SECRET_NAME,
        { 'api-key': 'rotated-api-key-value' },
        adminToken
      )
      // C3: if the deployed Role lost the `patch` verb on secrets, mergeSecret
      // fails and this assertion fails loudly with the API server's message
      // embedded in the response body — never a silent skip or a swallowed
      // error. This IS the trip-wire the plan calls for.
      expect(status, `PUT /admin/mcp-secrets/${SECRET_NAME} failed: ${JSON.stringify(data)}`).toBe(
        200
      )
      const body = data as { keys: string[]; affectedConnectors: string[] }
      expect(body.keys.sort()).toEqual(['api-key', 'webhook-secret'])
      expect(body.affectedConnectors).toContain(SERVER_NAME)

      // Read the Secret back from the cluster (never assume from the PUT body
      // — the response is names-only by contract).
      const secret = kubectlJson<{ data: Record<string, string> }>(
        `get secret ${SECRET_NAME} -n ${MCP_SERVERS_NAMESPACE}`
      )
      const rotatedValue = Buffer.from(secret.data['api-key'], 'base64').toString('utf-8')
      const preservedValue = Buffer.from(secret.data['webhook-secret'], 'base64').toString('utf-8')
      expect(rotatedValue).toBe('rotated-api-key-value')
      expect(preservedValue).toBe('initial-webhook-secret-value')

      // C2: the ONLY way to prove the write-side namespace (control-api's
      // MCP_SERVERS_NAMESPACE) and the watch-side namespace (HCC's
      // CONTEXT_MAPPER_NAMESPACE) actually agree in THIS cluster is to see
      // the informer react — a NEW DeploymentReady transition after the PUT.
      // If they diverged, this call times out with full diagnostics instead
      // of silently reporting "some rollout happened at some point."
      const cond = await waitForRolloutCondition(SERVER_NAME, adminToken, {
        expectStatus: 'True',
        sinceMs,
        timeoutMs: ROLLOUT_TIMEOUT_MS,
      })
      expect(cond.status).toBe('True')
    },
    ROLLOUT_TIMEOUT_MS + 15_000
  )

  it('C4: the pod template credentials-revision annotation matches the REAL post-merge Secret hash', () => {
    if (!controlApiUp) return

    const actualHash = secretDataHash(MCP_SERVERS_NAMESPACE, SECRET_NAME)
    const annotation = deploymentCredentialsRevisionAnnotation(MCP_SERVERS_NAMESPACE, SERVER_NAME)

    expect(
      annotation,
      'Deployment pod template is missing clerum.io/credentials-revision'
    ).not.toBeNull()
    expect(annotation).toBe(actualHash)

    // Sanity: canonicalStringify really is order-independent, matching the
    // idempotence guarantee host-context-controller relies on (Fase 2 tests).
    expect(canonicalStringify({ b: '2', a: '1' })).toBe(canonicalStringify({ a: '1', b: '2' }))
  })

  it('rotating with the SAME value again is idempotent — no unnecessary rollout signal change', async () => {
    if (!controlApiUp) return

    const hashBefore = secretDataHash(MCP_SERVERS_NAMESPACE, SECRET_NAME)
    const { status } = await putMcpSecret(
      SECRET_NAME,
      { 'api-key': 'rotated-api-key-value' }, // same value as the prior rotation
      adminToken
    )
    expect(status).toBe(200)
    const hashAfter = secretDataHash(MCP_SERVERS_NAMESPACE, SECRET_NAME)
    expect(hashAfter).toBe(hashBefore)
  })
})
