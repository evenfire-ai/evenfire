/**
 * Integration: per-host channel-reader feature — E2E via control-api
 *
 * Mirrors the control-ui flow programmatically. Reproduces every step a
 * human admin performs in the channel-edit modal, then verifies HCC's
 * cluster-side reactions through kubectl.
 *
 * Pipeline under test:
 *   admin login
 *     → create ephemeral Host CRD (kubectl)
 *     → POST /admin/communication-channels (CC)
 *     → wait for HCC to materialize channel-reader-<host> Deployment
 *     → PUT /admin/communication-channels/:name/credentials (bot token)
 *     → wait for clerum.io/credentials-revision annotation patch
 *     → verify pod rolls with correct env wiring
 *     → (if TG_BOT_TOKEN set) verify "[Telegram] Connected as @<bot>" log
 *     → PUT /admin/communication-channels/:name/credentials (rotate)
 *     → verify annotation hash changes; pod rolls again
 *     → DELETE /admin/communication-channels/:name (credentials cleanup)
 *     → DELETE Host CRD; verify Deployment cascade
 *
 * Scope boundary: this test deliberately stops at "channel-reader connected
 * to Telegram". The TG → mcp-host round-trip is out of scope here.
 *
 * Requires:
 *   - minikube cluster with the per-host channel-reader feature deployed
 *   - port-forward to control-api on :8090 (`make minikube-pf-all`)
 *   - kubectl configured for context KUBECTL_CONTEXT (default clerum-test)
 *
 * Env:
 *   CONTROL_API_URL          (default http://localhost:8090)
 *   KUBECTL_CONTEXT          (default clerum-test)
 *   TEST_ADMIN_USERNAME      (default admin)
 *   TEST_ADMIN_PASSWORD      (default changeme123!)
 *   TEST_CONTEXT_REF         (default context1)
 *   TEST_HOST_SECRET_REF     (default chatllm-api-keys)
 *   TG_BOT_TOKEN             (optional — enables "[Telegram] Connected" assertion)
 *   TG_BOT_TOKEN_ROTATED     (optional — defaults to a random sha-distinct value)
 *
 * Run:
 *   cd tests/e2e && npx vitest run integration/channel-reader-via-api
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { randomBytes } from 'crypto'
import { CONTROL_API_URL, deleteJson, postJson, putJson } from './helpers.integration.js'
import {
  adminLogin,
  adminSessionHeader,
  requireControlApiUp,
  skipEachIfClusterDown,
} from './mcpCredentialRotation.helpers.js'

// ─── Configuration ──────────────────────────────────────────────────────────

const KUBECTL_CONTEXT = process.env.KUBECTL_CONTEXT ?? 'clerum-test'
const TEST_CONTEXT_REF = process.env.TEST_CONTEXT_REF ?? 'context1'
const TEST_HOST_SECRET_REF = process.env.TEST_HOST_SECRET_REF ?? 'chatllm-api-keys'
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN ?? 'fake-bot-token-for-shape-only'
const TG_BOT_TOKEN_ROTATED =
  process.env.TG_BOT_TOKEN_ROTATED ?? `rotated-${randomBytes(8).toString('hex')}`
const HAS_LIVE_BOT_TOKEN = process.env.TG_BOT_TOKEN !== undefined

const RUN_ID = randomBytes(3).toString('hex')
const TEST_HOST = `cr-e2e-${RUN_ID}`
const CHANNEL_NAME = `cr-e2e-channel-${RUN_ID}`
const SECRET_NAME = `cc-${CHANNEL_NAME}-credentials`
const DEPLOY_NAME = `channel-reader-${TEST_HOST}`
const HOST_NAMESPACE = 'mcp-host'
const CHANNELS_NAMESPACE = 'channels'

const POLL_INTERVAL_MS = 1_500
const HCC_TIMEOUT_MS = 60_000
const TG_CONNECT_TIMEOUT_MS = 90_000

// ─── kubectl wrappers (subprocess, returns stdout or null on error) ─────────

/**
 * WARNING: `args` is split on whitespace before being passed to execFileSync,
 * so no single token may contain a space (e.g. a jsonpath with embedded
 * spaces like `{range .items[*]}{.metadata.name}{" "}{end}`, or quoted
 * values). All current call sites use K8s names/label selectors/jsonpaths
 * without spaces. If you need a whitespace-containing token, call
 * execFileSync directly with an explicit argv array instead.
 */
function kubectl(args: string): string {
  const parts = args.split(/\s+/).filter(Boolean)
  return execFileSync('kubectl', [`--context=${KUBECTL_CONTEXT}`, ...parts], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function kubectlSafe(args: string): string | null {
  try {
    return kubectl(args)
  } catch {
    return null
  }
}

function kubectlApply(yaml: string): string {
  return execFileSync('kubectl', [`--context=${KUBECTL_CONTEXT}`, 'apply', '-f', '-'], {
    encoding: 'utf-8',
    input: yaml,
  }).trim()
}

async function waitFor<T>(
  description: string,
  predicate: () => T | null | undefined,
  timeoutMs: number
): Promise<T> {
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      const result = predicate()
      if (result) return result as T
    } catch (err) {
      lastErr = err
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }
  throw new Error(
    `Timed out waiting for: ${description} (${timeoutMs}ms). Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`
  )
}

// ─── Test fixture lifecycle ─────────────────────────────────────────────────

let controlApiUp = false
let adminToken = ''

skipEachIfClusterDown(() => controlApiUp)

beforeAll(async () => {
  controlApiUp = await requireControlApiUp('channel-reader-via-api')
  if (!controlApiUp) return

  adminToken = await adminLogin()

  // Pre-create supporting fixtures (Host CRD requires both).
  // We trust the cluster has TEST_CONTEXT_REF + TEST_HOST_SECRET_REF
  // already seeded (by `make minikube-setup`).

  // Create the test Host CRD via kubectl (this feature is HCC-bound, so
  // testing it requires a real Host CRD; the API surface for Host creation
  // is admin-gated and doesn't need to be exercised here).
  kubectlApply(`
apiVersion: clerum.io/v1alpha1
kind: Host
metadata:
  name: ${TEST_HOST}
  namespace: ${HOST_NAMESPACE}
spec:
  host: ${TEST_HOST}
  contextRef: ${TEST_CONTEXT_REF}
  secretRef: ${TEST_HOST_SECRET_REF}
  model:
    provider: openai
`)
}, 30_000)

afterAll(() => {
  if (!controlApiUp) return
  // Best-effort cleanup. trap-style — order: Secret → CC → Host (avoid
  // dangling Secret if Host delete cascades the Deployment).
  kubectlSafe(
    `delete secret ${SECRET_NAME} -n ${CHANNELS_NAMESPACE} --ignore-not-found --timeout=10s`
  )
  kubectlSafe(
    `delete communicationchannel ${CHANNEL_NAME} -n ${CHANNELS_NAMESPACE} --ignore-not-found --timeout=10s`
  )
  kubectlSafe(`delete host ${TEST_HOST} -n ${HOST_NAMESPACE} --ignore-not-found --timeout=10s`)
})

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('channel-reader via control-api', () => {
  let initialAnnotationHash = ''

  it('admin login produced a JWT', () => {
    expect(adminToken.length).toBeGreaterThan(0)
  })

  it(
    'Host CRD is reconciled by HCC into a per-host channel-reader Deployment',
    async () => {
      const dep = await waitFor(
        `Deployment ${DEPLOY_NAME} in ${CHANNELS_NAMESPACE}`,
        () =>
          kubectlSafe(
            `get deployment ${DEPLOY_NAME} -n ${CHANNELS_NAMESPACE} -o jsonpath={.metadata.uid}`
          ),
        HCC_TIMEOUT_MS
      )
      expect(dep).toMatch(/^[0-9a-f-]{36}/) // UUID

      const labels = kubectl(
        `get deployment ${DEPLOY_NAME} -n ${CHANNELS_NAMESPACE} -o jsonpath={.metadata.labels}`
      )
      expect(labels).toContain('"clerum.io/host":"' + TEST_HOST + '"')
      expect(labels).toContain('"clerum.io/managed-by":"host-context-controller"')
      expect(labels).toContain('"app":"channel-reader"')
    },
    HCC_TIMEOUT_MS
  )

  it('POST /admin/communication-channels creates the CC', async () => {
    // The generic admin/:resource router uses POST for create and PUT for
    // update (PUT requires existing resource). UI hits PUT for both because
    // its create flow first POSTs then re-GETs; here we go straight to POST.
    const { status } = await postJson(
      `${CONTROL_API_URL}/api/v1/admin/communication-channels`,
      {
        metadata: { name: CHANNEL_NAME },
        spec: {
          hostRef: TEST_HOST,
          telegram: [
            {
              channelId: '516801777',
              chatType: 'private',
              userIds: ['516801777'],
            },
          ],
        },
        credentials: { 'telegram-bot-token': TG_BOT_TOKEN },
      },
      adminSessionHeader(adminToken)
    )
    expect([200, 201]).toContain(status)

    // Verify the CRD landed
    const cc = kubectl(
      `get communicationchannel ${CHANNEL_NAME} -n ${CHANNELS_NAMESPACE} -o jsonpath={.spec.hostRef}`
    )
    expect(cc).toBe(TEST_HOST)
  })

  it('PUT /admin/communication-channels/:name updates the CC (rotation of allowed senders)', async () => {
    const { status } = await putJson(
      `${CONTROL_API_URL}/api/v1/admin/communication-channels/${encodeURIComponent(CHANNEL_NAME)}`,
      {
        spec: {
          hostRef: TEST_HOST,
          telegram: [
            {
              channelId: '516801777',
              chatType: 'private',
              userIds: ['516801777', '999999999'], // add another allowed sender
            },
          ],
        },
      },
      adminSessionHeader(adminToken)
    )
    expect(status).toBe(200)

    const userIds = kubectl(
      `get communicationchannel ${CHANNEL_NAME} -n ${CHANNELS_NAMESPACE} -o jsonpath={.spec.telegram[0].userIds}`
    )
    expect(userIds).toContain('999999999')
  })

  it('PUT /admin/communication-channels/:name/credentials rotates existing credentials', async () => {
    const { status, data } = await putJson<{
      name: string
      secretName: string
      namespace: string
      rotated: boolean
    }>(
      `${CONTROL_API_URL}/api/v1/admin/communication-channels/${encodeURIComponent(CHANNEL_NAME)}/credentials`,
      { 'telegram-bot-token': TG_BOT_TOKEN },
      adminSessionHeader(adminToken)
    )
    expect(status).toBe(200)
    expect(data.name).toBe(CHANNEL_NAME)
    expect(data.secretName).toBe(SECRET_NAME)
    expect(data.namespace).toBe(CHANNELS_NAMESPACE)
    expect(data.rotated).toBe(true)

    const secret = kubectl(
      `get secret ${SECRET_NAME} -n ${CHANNELS_NAMESPACE} -o jsonpath={.metadata.name}`
    )
    expect(secret).toBe(SECRET_NAME)

    const ref = kubectl(
      `get communicationchannel ${CHANNEL_NAME} -n ${CHANNELS_NAMESPACE} -o jsonpath={.spec.credentialsSecretRef.name}`
    )
    expect(ref).toBe(SECRET_NAME)
  })

  it(
    'HCC patches credentials-revision annotation within timeout',
    async () => {
      const annotationHash = await waitFor(
        `clerum.io/credentials-revision annotation on ${DEPLOY_NAME}`,
        () => {
          const ann = kubectlSafe(
            `get deployment ${DEPLOY_NAME} -n ${CHANNELS_NAMESPACE} -o jsonpath={.spec.template.metadata.annotations.clerum\\.io/credentials-revision}`
          )
          return ann && /^[0-9a-f]{64}$/.test(ann) ? ann : null
        },
        HCC_TIMEOUT_MS
      )
      expect(annotationHash).toMatch(/^[0-9a-f]{64}$/)
      initialAnnotationHash = annotationHash
    },
    HCC_TIMEOUT_MS
  )

  it(
    'pod rolls and ends up Running without static credential env values',
    async () => {
      // Wait for the new ReplicaSet's pod to be Ready
      await waitFor(
        `pod for ${DEPLOY_NAME} Running 1/1`,
        () => {
          const phase = kubectlSafe(
            `get pod -l clerum.io/host=${TEST_HOST} -n ${CHANNELS_NAMESPACE} -o jsonpath={.items[0].status.phase}`
          )
          const ready = kubectlSafe(
            `get pod -l clerum.io/host=${TEST_HOST} -n ${CHANNELS_NAMESPACE} -o jsonpath={.items[0].status.containerStatuses[0].ready}`
          )
          return phase === 'Running' && ready === 'true' ? 'ok' : null
        },
        HCC_TIMEOUT_MS
      )

      // Per-CC credentials stay behind credentialsSecretRef and are not
      // projected into the pod as static credential env vars.
      const env = kubectl(
        `get pod -l clerum.io/host=${TEST_HOST} -n ${CHANNELS_NAMESPACE} -o jsonpath={.items[0].spec.containers[0].env}`
      )
      const envFrom =
        kubectlSafe(
          `get pod -l clerum.io/host=${TEST_HOST} -n ${CHANNELS_NAMESPACE} -o jsonpath={.items[0].spec.containers[0].envFrom}`
        ) ?? ''
      expect(env).toContain(`"name":"CLERUM_HOST_REF"`)
      expect(env).toContain(`"value":"${TEST_HOST}"`)
      expect(env).not.toContain(`CLERUM_TELEGRAM_BOT_TOKEN`)
      expect(env).not.toContain(`telegram-bot-token`)
      expect(env).not.toContain(`CLERUM_CONTROL_API_URL`)
      expect(env).not.toContain(`CLERUM_CONTROL_API_SERVICE_NAME`)
      expect(env).not.toContain(`CLERUM_CONTROL_API_SERVICE_TOKEN`)
      expect(env).not.toContain(`CONTROL_API_SERVICE_TOKEN`)
      expect(envFrom).not.toContain(`channel-reader-internal-tokens`)
      expect(envFrom).not.toContain(`control-api`)
    },
    HCC_TIMEOUT_MS
  )

  it('channel-reader egress policy does not allow the workflow approval gateway', () => {
    const policy = kubectl(
      `get networkpolicy channel-reader-${TEST_HOST}-egress -n ${CHANNELS_NAMESPACE} -o yaml`
    )
    expect(policy).toContain(`channel-reader-${TEST_HOST}-egress`)
    expect(policy).toContain(`kubernetes.io/metadata.name: mcp-host`)
    expect(policy).toContain(`clerum.io/host: ${TEST_HOST}`)
    expect(policy).not.toContain(`nginx-workflow-approval-gateway`)
    expect(policy).not.toContain(`kubernetes.io/metadata.name: control-plane`)
    expect(policy).not.toContain(`app: control-api`)
  })

  it.skipIf(!HAS_LIVE_BOT_TOKEN)(
    'channel-reader connects to Telegram (requires real TG_BOT_TOKEN)',
    async () => {
      await waitFor(
        `"[Telegram] Connected as @" log line in pod`,
        () => {
          const logs = kubectlSafe(`logs deploy/${DEPLOY_NAME} -n ${CHANNELS_NAMESPACE} --tail=50`)
          return logs && logs.includes('[Telegram] Connected as @') ? 'ok' : null
        },
        TG_CONNECT_TIMEOUT_MS
      )
    },
    TG_CONNECT_TIMEOUT_MS
  )

  it('PUT /admin/communication-channels/:name/credentials with same data is idempotent', async () => {
    const { status, data } = await putJson<{ rotated: boolean }>(
      `${CONTROL_API_URL}/api/v1/admin/communication-channels/${encodeURIComponent(CHANNEL_NAME)}/credentials`,
      { 'telegram-bot-token': TG_BOT_TOKEN },
      adminSessionHeader(adminToken)
    )
    expect(status).toBe(200)
    expect(data.rotated).toBe(true)

    // Wait briefly for HCC to (potentially) react, then assert no change
    await new Promise(r => setTimeout(r, 5_000))
    const ann = kubectl(
      `get deployment ${DEPLOY_NAME} -n ${CHANNELS_NAMESPACE} -o jsonpath={.spec.template.metadata.annotations.clerum\\.io/credentials-revision}`
    )
    expect(ann).toBe(initialAnnotationHash)
  })

  it(
    'PUT /admin/communication-channels/:name/credentials with different data updates the annotation',
    async () => {
      const { status, data } = await putJson<{ rotated: boolean }>(
        `${CONTROL_API_URL}/api/v1/admin/communication-channels/${encodeURIComponent(CHANNEL_NAME)}/credentials`,
        { 'telegram-bot-token': TG_BOT_TOKEN_ROTATED },
        adminSessionHeader(adminToken)
      )
      expect(status).toBe(200)
      expect(data.rotated).toBe(true)

      const newHash = await waitFor(
        `credentials-revision annotation to change`,
        () => {
          const ann = kubectlSafe(
            `get deployment ${DEPLOY_NAME} -n ${CHANNELS_NAMESPACE} -o jsonpath={.spec.template.metadata.annotations.clerum\\.io/credentials-revision}`
          )
          return ann && ann !== initialAnnotationHash ? ann : null
        },
        HCC_TIMEOUT_MS
      )
      expect(newHash).not.toBe(initialAnnotationHash)
      expect(newHash).toMatch(/^[0-9a-f]{64}$/)
    },
    HCC_TIMEOUT_MS
  )

  it('CommunicationChannel still points at the credentials Secret after rotation', () => {
    const ref = kubectl(
      `get communicationchannel ${CHANNEL_NAME} -n ${CHANNELS_NAMESPACE} -o jsonpath={.spec.credentialsSecretRef.name}`
    )
    expect(ref).toBe(SECRET_NAME)
  })

  it('DELETE /admin/communication-channels/:name removes the credentials Secret', async () => {
    const { status } = await deleteJson(
      `${CONTROL_API_URL}/api/v1/admin/communication-channels/${encodeURIComponent(CHANNEL_NAME)}`,
      adminSessionHeader(adminToken)
    )
    expect(status).toBe(200)

    await waitFor(
      `CommunicationChannel ${CHANNEL_NAME} to be gone`,
      () => {
        const result = kubectlSafe(
          `get communicationchannel ${CHANNEL_NAME} -n ${CHANNELS_NAMESPACE} --ignore-not-found -o jsonpath={.metadata.name}`
        )
        return result === '' || result === null ? 'gone' : null
      },
      15_000
    )

    await waitFor(
      `Secret ${SECRET_NAME} to be gone`,
      () => {
        const result = kubectlSafe(
          `get secret ${SECRET_NAME} -n ${CHANNELS_NAMESPACE} --ignore-not-found -o jsonpath={.metadata.name}`
        )
        return result === '' || result === null ? 'gone' : null
      },
      15_000
    )
  })

  it(
    'DELETE Host CRD cascades the channel-reader Deployment',
    async () => {
      kubectl(`delete host ${TEST_HOST} -n ${HOST_NAMESPACE} --ignore-not-found`)

      await waitFor(
        `Deployment ${DEPLOY_NAME} to be gone`,
        () => {
          const result = kubectlSafe(
            `get deployment ${DEPLOY_NAME} -n ${CHANNELS_NAMESPACE} --ignore-not-found -o jsonpath={.metadata.name}`
          )
          return result === '' || result === null ? 'gone' : null
        },
        HCC_TIMEOUT_MS
      )
    },
    HCC_TIMEOUT_MS
  )
})
