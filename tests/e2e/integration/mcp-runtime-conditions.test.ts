/**
 * E2E: HCC runtime conditions (#606).
 *
 * Proves, on a live cluster, that HCC retracts DeploymentReady when it does
 * not run a managed server and never writes a NetworkReady condition.
 *
 * Actions go through control-api (DELETE + POST of the Secret; full-spec PUT
 * to disable). Writing the Secret with kubectl after setup, or merge-patching
 * it, is forbidden — PUT is merge-patch and cannot produce SecretMissingKey.
 *
 * Run:
 *   bash scripts/e2e/run-vitest-e2e.sh integration/mcp-runtime-conditions.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MCP_SERVERS_NAMESPACE,
  ROLLOUT_TIMEOUT_MS,
  adminLogin,
  deleteMcpSecret,
  deleteMcpServerFixture,
  getMcpServerResource,
  kubectlApply,
  kubectlSafe,
  localMcpServerYaml,
  postMcpSecret,
  putMcpServer,
  randomSuffix,
  requireControlApiUp,
  requireHccDevModeUnset,
  secretYaml,
  waitFor,
  waitForRolloutCondition,
  waitForStatusCondition,
} from './mcpCredentialRotation.helpers.js'

const RUN_ID = randomSuffix()
const SERVER_NAME = `e2e-runtime-cond-${RUN_ID}`
const SECRET_NAME = `${SERVER_NAME}-credentials`
const SECRET_KEY = 'api-key'
const INITIAL_SECRET_VALUE = 'initial-valid-value'
const RESTORED_SECRET_VALUE = 'restored-valid-value'

let controlApiUp = false
let adminToken = ''

function expectNoNetworkReady(resource: {
  status?: { conditions?: Array<{ type: string }> }
}): void {
  const types = (resource.status?.conditions ?? []).map(condition => condition.type)
  expect(types, `NetworkReady must be absent; saw ${types.join(',')}`).not.toContain('NetworkReady')
}

beforeAll(async () => {
  controlApiUp = await requireControlApiUp('mcp-runtime-conditions')
  if (!controlApiUp) return

  requireHccDevModeUnset()
  adminToken = await adminLogin()

  kubectlApply(
    secretYaml(SECRET_NAME, MCP_SERVERS_NAMESPACE, {
      [SECRET_KEY]: INITIAL_SECRET_VALUE,
    })
  )
  kubectlApply(
    localMcpServerYaml({
      name: SERVER_NAME,
      envSecretName: SECRET_NAME,
      keys: [{ secretKey: SECRET_KEY, envVar: 'E2E_ROTATION_API_KEY' }],
    })
  )
}, ROLLOUT_TIMEOUT_MS + 30_000)

afterAll(() => {
  if (!controlApiUp) return
  deleteMcpServerFixture(SERVER_NAME, SECRET_NAME)
})

describe('mcp runtime conditions (#606)', () => {
  it(
    'retracts DeploymentReady on Secret delete, restores it on recreate, and disables the runtime',
    async () => {
      if (!controlApiUp) return

      const ready = await waitForRolloutCondition(SERVER_NAME, adminToken, {
        expectStatus: 'True',
        expectReason: 'ReplicasAvailable',
        sinceMs: 0,
        timeoutMs: ROLLOUT_TIMEOUT_MS,
      })
      expectNoNetworkReady(await getMcpServerResource(SERVER_NAME, adminToken))
      expect(ready.reason).toBe('ReplicasAvailable')

      const deletedAt = Date.now()
      const deleted = await deleteMcpSecret(SECRET_NAME, adminToken)
      expect(deleted.status, `DELETE secret failed: ${JSON.stringify(deleted.data)}`).toBe(200)

      await waitForStatusCondition(SERVER_NAME, adminToken, {
        type: 'SecretResolved',
        expectStatus: 'False',
        expectReason: 'SecretNotFound',
        sinceMs: deletedAt,
        timeoutMs: ROLLOUT_TIMEOUT_MS,
      })
      await waitForStatusCondition(SERVER_NAME, adminToken, {
        type: 'Ready',
        expectStatus: 'False',
        expectReason: 'SecretValidationFailed',
        sinceMs: deletedAt,
        timeoutMs: ROLLOUT_TIMEOUT_MS,
      })
      const retired = await waitForRolloutCondition(SERVER_NAME, adminToken, {
        expectStatus: 'False',
        expectReason: 'RuntimeNotDesired',
        sinceMs: deletedAt,
        timeoutMs: ROLLOUT_TIMEOUT_MS,
      })
      expect(retired.message).toContain('Env Secret validation failed')
      expectNoNetworkReady(await getMcpServerResource(SERVER_NAME, adminToken))
      await waitFor(
        `Deployment "${SERVER_NAME}" absent after fail-closed delete`,
        () =>
          kubectlSafe(`get deploy ${SERVER_NAME} -n ${MCP_SERVERS_NAMESPACE}`) === null
            ? 'absent'
            : null,
        ROLLOUT_TIMEOUT_MS,
        {
          diagnostics: () =>
            kubectlSafe(
              `get deploy,pods -n ${MCP_SERVERS_NAMESPACE} -l clerum.io/mcpserver=${SERVER_NAME}`
            ) ?? '(kubectl failed)',
        }
      )

      const restoredAt = Date.now()
      const created = await postMcpSecret(
        SECRET_NAME,
        { [SECRET_KEY]: RESTORED_SECRET_VALUE },
        adminToken
      )
      expect(created.status, `POST secret failed: ${JSON.stringify(created.data)}`).toBe(201)

      const restored = await waitForRolloutCondition(SERVER_NAME, adminToken, {
        expectStatus: 'True',
        expectReason: 'ReplicasAvailable',
        sinceMs: restoredAt,
        timeoutMs: ROLLOUT_TIMEOUT_MS,
      })
      expect(Date.parse(restored.lastTransitionTime)).toBeGreaterThan(
        Date.parse(retired.lastTransitionTime)
      )
      expectNoNetworkReady(await getMcpServerResource(SERVER_NAME, adminToken))

      const current = await getMcpServerResource(SERVER_NAME, adminToken)
      const disabledAt = Date.now()
      const disabled = await putMcpServer(
        SERVER_NAME,
        {
          metadata: { resourceVersion: current.metadata.resourceVersion },
          spec: { ...current.spec, enabled: false },
        },
        adminToken
      )
      expect(disabled.status, `PUT disable failed: ${JSON.stringify(disabled.data)}`).toBe(200)

      await waitForStatusCondition(SERVER_NAME, adminToken, {
        type: 'Ready',
        expectStatus: 'False',
        expectReason: 'Disabled',
        sinceMs: disabledAt,
        timeoutMs: ROLLOUT_TIMEOUT_MS,
      })
      const disabledReady = await waitForRolloutCondition(SERVER_NAME, adminToken, {
        expectStatus: 'False',
        expectReason: 'RuntimeNotDesired',
        sinceMs: disabledAt,
        timeoutMs: ROLLOUT_TIMEOUT_MS,
      })
      expect(disabledReady.message).toContain('McpServer is disabled')
      expectNoNetworkReady(await getMcpServerResource(SERVER_NAME, adminToken))
    },
    ROLLOUT_TIMEOUT_MS * 4 + 30_000
  )
})
