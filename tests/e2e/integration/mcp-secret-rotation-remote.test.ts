/**
 * E2E: connector credential rotation — E6 "Connector remoto" (issue #223, Fase 4)
 *
 * A remote McpServer's `authHeaders` forward an envSecret-backed credential
 * as an upstream header, resolved by nginx's envsubst at pod startup
 * (host-context-controller/src/reconciler.ts:644-660). This test rotates
 * that credential and makes a REAL request through the connector's own
 * egress-proxy Service, verifying the upstream actually received the NEW
 * value — not that "something changed on the Deployment".
 *
 * The upstream target must be a real internet HTTPS DNS host:
 * `sanitizeRemoteUrl()` (host-context-controller/src/reconciler.ts:348)
 * explicitly REJECTS any `*.svc` / `*.svc.cluster.local` hostname as an SSRF
 * guard, so this cannot point at another in-cluster fixture. It defaults to
 * https://httpbin.org/headers — the same public host this repo's
 * mock-mcp-server `fetch_http` egress-probe tool already allowlists by
 * default (EGRESS_PROBE_ALLOWED_HOSTS) — and can be overridden with
 * TEST_REMOTE_ECHO_URL if that host becomes unreliable in a given
 * environment. This is a real external-network dependency, not a mock.
 *
 * Atajo evitado: la petición no se hace contra el Secret ni contra el CRD —
 * se hace contra el proxy real, con las cabeceras reales que produjo nginx.
 *
 * Run:
 *   cd tests/e2e && npx vitest run integration/mcp-secret-rotation-remote
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MCP_SERVERS_NAMESPACE,
  ROLLOUT_TIMEOUT_MS,
  adminLogin,
  deleteMcpServerFixture,
  kubectlApply,
  putMcpSecret,
  randomSuffix,
  remoteMcpServerYaml,
  requireControlApiUp,
  secretYaml,
  waitForRolloutCondition,
  withServicePortForward,
} from './mcpRotation.helpers.js'

const REMOTE_ECHO_URL = process.env.TEST_REMOTE_ECHO_URL ?? 'https://httpbin.org/headers'
const REMOTE_ECHO_PATH = new URL(REMOTE_ECHO_URL).pathname

const RUN_ID = randomSuffix()
const SERVER_NAME = `e2e-rot-remote-${RUN_ID}`
const SECRET_NAME = `${SERVER_NAME}-credentials`
const AUTH_HEADER_NAME = 'X-E2e-Rotation-Key'
const TRANSPORT_PORT = 3000

let controlApiUp = false
let adminToken = ''

beforeAll(async () => {
  controlApiUp = await requireControlApiUp('mcp-secret-rotation-remote')
  if (!controlApiUp) return

  adminToken = await adminLogin()

  kubectlApply(
    secretYaml(SECRET_NAME, MCP_SERVERS_NAMESPACE, { 'api-key': 'initial-remote-value' })
  )
  kubectlApply(
    remoteMcpServerYaml({
      name: SERVER_NAME,
      baseUrl: REMOTE_ECHO_URL,
      envSecretName: SECRET_NAME,
      keys: [{ secretKey: 'api-key', envVar: 'E2E_ROTATION_API_KEY' }],
      authHeaders: [{ header: AUTH_HEADER_NAME, valueTemplate: '${E2E_ROTATION_API_KEY}' }],
      transportPort: TRANSPORT_PORT,
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

/** httpbin (and intermediate proxies) may title-case header names differently than sent. */
function lowerCaseKeys(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]))
}

async function fetchEchoedAuthHeader(): Promise<string | undefined> {
  return withServicePortForward(
    MCP_SERVERS_NAMESPACE,
    SERVER_NAME,
    TRANSPORT_PORT,
    async baseUrl => {
      const res = await fetch(`${baseUrl}${REMOTE_ECHO_PATH}`, {
        signal: AbortSignal.timeout(15_000),
      })
      expect(res.status, `proxy request to ${REMOTE_ECHO_URL} returned ${res.status}`).toBe(200)
      const json = (await res.json()) as { headers: Record<string, string> }
      return lowerCaseKeys(json.headers)[AUTH_HEADER_NAME.toLowerCase()]
    }
  )
}

describe('mcp-secret rotation — E6 connector remoto', () => {
  it('a real request through the proxy carries the INITIAL credential before rotation', async () => {
    if (!controlApiUp) return
    const header = await fetchEchoedAuthHeader()
    expect(header).toBe('initial-remote-value')
  }, 30_000)

  it(
    'after rotation, the proxy is redeployed and a real request carries the NEW credential',
    async () => {
      if (!controlApiUp) return

      const sinceMs = Date.now()
      const { status, data } = await putMcpSecret(
        SECRET_NAME,
        { 'api-key': 'rotated-remote-value' },
        adminToken
      )
      expect(status, `PUT failed: ${JSON.stringify(data)}`).toBe(200)

      await waitForRolloutCondition(SERVER_NAME, adminToken, {
        expectStatus: 'True',
        sinceMs,
        timeoutMs: ROLLOUT_TIMEOUT_MS,
      })

      const header = await fetchEchoedAuthHeader()
      expect(
        header,
        'the upstream echo endpoint did not observe the rotated credential — ' +
          'either the pod did not roll, or it rolled with a stale envsubst value'
      ).toBe('rotated-remote-value')
    },
    ROLLOUT_TIMEOUT_MS + 30_000
  )
})
