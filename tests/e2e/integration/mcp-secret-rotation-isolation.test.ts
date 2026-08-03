/**
 * E2E: connector credential rotation — E4 "Aislamiento" (issue #223, Fase 4)
 *
 * Rotates connector A's credential and asserts NEGATIVELY that nothing else
 * moved: connector B's McpServer CRD `resourceVersion`, connector B's
 * Deployment `generation`, and connector B's own (unrelated) Secret content
 * all stay byte-for-byte identical.
 *
 * Also carries C6 (plan section 6): the recipe-secret ownership guard on
 * `PUT /admin/mcp-secrets/:name` must key off the SAME label its real
 * producer writes — `POST /admin/recipe-secrets` — not a label the test
 * fabricates itself. A fixture-fabricated label would validate itself even
 * if the guard's constant drifted from the producer's; going through the
 * real endpoint is what makes this a trip-wire instead of a tautology.
 *
 * Atajos evitados: ninguna de las aserciones "no cambió" se basa en el 200
 * del PUT — todas leen el estado real (kubectl / CRD) antes y después.
 *
 * Run:
 *   cd tests/e2e && npx vitest run integration/mcp-secret-rotation-isolation
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CONTROL_API_URL,
  MCP_SERVERS_NAMESPACE,
  ROLLOUT_TIMEOUT_MS,
  adminLogin,
  adminSessionHeader,
  deleteMcpServerFixture,
  fetchJson,
  kubectl,
  kubectlApply,
  kubectlSafe,
  localMcpServerYaml,
  postJson,
  putMcpSecret,
  randomSuffix,
  requireControlApiUp,
  secretDataHash,
  secretYaml,
  waitForRolloutCondition,
} from './mcpCredentialRotation.helpers.js'

const RUN_ID = randomSuffix()
const SERVER_A = `e2e-rot-iso-a-${RUN_ID}`
const SECRET_A = `${SERVER_A}-credentials`
const SERVER_B = `e2e-rot-iso-b-${RUN_ID}`
const SECRET_B = `${SERVER_B}-credentials`
const RECIPE_SECRET_NAME = `e2e-rot-recipe-secret-${RUN_ID}`

let controlApiUp = false
let adminToken = ''

beforeAll(async () => {
  controlApiUp = await requireControlApiUp('mcp-secret-rotation-isolation')
  if (!controlApiUp) return

  adminToken = await adminLogin()

  kubectlApply(secretYaml(SECRET_A, MCP_SERVERS_NAMESPACE, { 'api-key': 'a-initial-value' }))
  kubectlApply(
    localMcpServerYaml({
      name: SERVER_A,
      envSecretName: SECRET_A,
      keys: [{ secretKey: 'api-key', envVar: 'E2E_ROTATION_API_KEY' }],
    })
  )
  kubectlApply(secretYaml(SECRET_B, MCP_SERVERS_NAMESPACE, { 'api-key': 'b-initial-value' }))
  kubectlApply(
    localMcpServerYaml({
      name: SERVER_B,
      envSecretName: SECRET_B,
      keys: [{ secretKey: 'api-key', envVar: 'E2E_ROTATION_API_KEY' }],
    })
  )

  await Promise.all([
    waitForRolloutCondition(SERVER_A, adminToken, {
      expectStatus: 'True',
      sinceMs: 0,
      timeoutMs: ROLLOUT_TIMEOUT_MS,
    }),
    waitForRolloutCondition(SERVER_B, adminToken, {
      expectStatus: 'True',
      sinceMs: 0,
      timeoutMs: ROLLOUT_TIMEOUT_MS,
    }),
  ])
}, ROLLOUT_TIMEOUT_MS + 30_000)

afterAll(() => {
  if (!controlApiUp) return
  deleteMcpServerFixture(SERVER_A, SECRET_A)
  deleteMcpServerFixture(SERVER_B, SECRET_B)
  kubectlSafe(
    `delete secret ${RECIPE_SECRET_NAME} -n ${MCP_SERVERS_NAMESPACE} --ignore-not-found --timeout=10s`
  )
})

describe('mcp-secret rotation — E4 aislamiento', () => {
  it(
    'rotating connector A does not touch connector B: resourceVersion, generation, and neighbor Secret content all unchanged',
    async () => {
      if (!controlApiUp) return

      const bResourceVersionBefore = kubectl(
        `get mcpserver ${SERVER_B} -n ${MCP_SERVERS_NAMESPACE} -o jsonpath='{.metadata.resourceVersion}'`
      )
      const bGenerationBefore = kubectl(
        `get deployment ${SERVER_B} -n ${MCP_SERVERS_NAMESPACE} -o jsonpath='{.metadata.generation}'`
      )
      const bSecretHashBefore = secretDataHash(MCP_SERVERS_NAMESPACE, SECRET_B)

      const sinceMs = Date.now()
      const { status } = await putMcpSecret(SECRET_A, { 'api-key': 'a-rotated-value' }, adminToken)
      expect(status).toBe(200)

      // Wait for A's OWN rollout to actually land — the negative assertions
      // below are only meaningful once the system had time to touch
      // anything it might mistakenly touch.
      await waitForRolloutCondition(SERVER_A, adminToken, {
        expectStatus: 'True',
        sinceMs,
        timeoutMs: ROLLOUT_TIMEOUT_MS,
      })

      const bResourceVersionAfter = kubectl(
        `get mcpserver ${SERVER_B} -n ${MCP_SERVERS_NAMESPACE} -o jsonpath='{.metadata.resourceVersion}'`
      )
      const bGenerationAfter = kubectl(
        `get deployment ${SERVER_B} -n ${MCP_SERVERS_NAMESPACE} -o jsonpath='{.metadata.generation}'`
      )
      const bSecretHashAfter = secretDataHash(MCP_SERVERS_NAMESPACE, SECRET_B)

      expect(
        bResourceVersionAfter,
        'connector B McpServer resourceVersion changed — isolation broken'
      ).toBe(bResourceVersionBefore)
      expect(bGenerationAfter, 'connector B Deployment generation changed — isolation broken').toBe(
        bGenerationBefore
      )
      expect(bSecretHashAfter, "connector B's own Secret content changed — isolation broken").toBe(
        bSecretHashBefore
      )
    },
    ROLLOUT_TIMEOUT_MS + 15_000
  )

  it('C6: a Secret created through the REAL recipe-secrets endpoint is guarded — PUT /admin/mcp-secrets returns 409', async () => {
    if (!controlApiUp) return

    const { status: createStatus, data: createData } = await postJson(
      `${CONTROL_API_URL}/api/v1/admin/recipe-secrets`,
      {
        name: RECIPE_SECRET_NAME,
        data: { token: 'recipe-owned-value' },
        ownership: { kind: 'shared' },
        targetNamespace: MCP_SERVERS_NAMESPACE,
      },
      adminSessionHeader(adminToken)
    )
    expect(createStatus, `POST /admin/recipe-secrets failed: ${JSON.stringify(createData)}`).toBe(
      201
    )

    // Confirm the real producer actually wrote the label the guard checks —
    // otherwise a 409 below would prove nothing about drift.
    const { status: listStatus, data: listData } = await fetchJson<{
      items: Array<{ name: string }>
    }>(`${CONTROL_API_URL}/api/v1/admin/recipe-secrets`, {
      headers: adminSessionHeader(adminToken),
    })
    expect(listStatus).toBe(200)
    expect(listData.items.map(i => i.name)).toContain(RECIPE_SECRET_NAME)

    const { status: putStatus, data: putData } = await putMcpSecret(
      RECIPE_SECRET_NAME,
      { token: 'attempted-bypass-value' },
      adminToken
    )
    expect(putStatus, `expected 409, got ${putStatus}: ${JSON.stringify(putData)}`).toBe(409)
    expect((putData as { error: string }).error).toMatch(/recipe-secrets/i)
  })
})
