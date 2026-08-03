/**
 * E2E: connector credential rotation — E7 "Upgrade" / blast radius R1
 * (issue #223, Fase 4)
 *
 * The credentials-revision annotation is baked into EVERY McpServer's pod
 * template the first time a HCC that knows about it reconciles — not just
 * the ones being rotated (plan section 3, R1). This test reproduces the
 * actual upgrade: connectors first reconciled by a baseline (pre-#223) HCC
 * image, then the branch's HCC image takes over, and asserts:
 *   - every connector WITH an envSecret rolls EXACTLY ONCE (Deployment
 *     generation advances by exactly 1, not more)
 *   - every connector WITHOUT an envSecret does not roll at all (generation
 *     unchanged — no annotation ever gets written for it)
 *
 * Precondition this scenario cannot fabricate: a real image built from
 * origin/dev (pre-#223 HCC code), reachable by the cluster. There is no safe
 * way to simulate "the old reconciler" without one — faking it would make
 * this test validate nothing. Required via TEST_HCC_BASELINE_IMAGE; if unset
 * this suite FAILS LOUDLY (not skips) with exactly what to provide.
 *
 * This test mutates a shared, cluster-wide Deployment
 * (host-context-controller in control-plane) for the duration of ONE test,
 * and restores the original image before returning control — both in the
 * test body's own assertions and, as a safety net, in afterAll.
 *
 * Run:
 *   TEST_HCC_BASELINE_IMAGE=<origin/dev HCC image> \
 *     cd tests/e2e && npx vitest run integration/mcp-hcc-upgrade-rollout
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MCP_SERVERS_NAMESPACE,
  ROLLOUT_TIMEOUT_MS,
  TEST_CONTEXT_REF,
  adminLogin,
  clusterDiagnostics,
  deleteMcpServerFixture,
  deploymentCredentialsRevisionAnnotation,
  kubectl,
  kubectlApply,
  kubectlSafe,
  localMcpServerYaml,
  randomSuffix,
  requireControlApiUp,
  secretYaml,
  waitFor,
  waitForDeploymentRolloutComplete,
  waitForRolloutCondition,
} from './mcpCredentialRotation.helpers.js'

const HCC_NAMESPACE = 'control-plane'
const HCC_DEPLOYMENT = 'host-context-controller'
const HCC_CONTAINER = 'host-context-controller'
const HCC_ROLLOUT_TIMEOUT_MS = 120_000

const BASELINE_IMAGE = process.env.TEST_HCC_BASELINE_IMAGE ?? ''

const RUN_ID = randomSuffix()
const WITH_SECRET_SERVER = `e2e-rot-upgrade-with-${RUN_ID}`
const WITH_SECRET_NAME = `${WITH_SECRET_SERVER}-credentials`
const WITHOUT_SECRET_SERVER = `e2e-rot-upgrade-without-${RUN_ID}`

let controlApiUp = false
let adminToken = ''
let originalHccImage = ''

function currentHccImage(): string {
  return kubectl(
    `get deployment ${HCC_DEPLOYMENT} -n ${HCC_NAMESPACE} -o jsonpath='{.spec.template.spec.containers[?(@.name=="${HCC_CONTAINER}")].image}'`
  )
}

async function setHccImage(image: string): Promise<void> {
  kubectl(`set image deployment/${HCC_DEPLOYMENT} ${HCC_CONTAINER}=${image} -n ${HCC_NAMESPACE}`)
  await waitFor(
    `HCC Deployment "${HCC_DEPLOYMENT}" rollout to image ${image}`,
    () => {
      try {
        execRolloutStatus()
        return 'ok'
      } catch {
        return null
      }
    },
    HCC_ROLLOUT_TIMEOUT_MS,
    {
      intervalMs: 3_000,
      diagnostics: () =>
        clusterDiagnostics(HCC_NAMESPACE, [
          `describe deployment ${HCC_DEPLOYMENT} -n ${HCC_NAMESPACE}`,
        ]),
    }
  )
}

function execRolloutStatus(): void {
  kubectl(`rollout status deployment/${HCC_DEPLOYMENT} -n ${HCC_NAMESPACE} --timeout=10s`)
}

function deploymentGeneration(name: string): string {
  return kubectl(
    `get deployment ${name} -n ${MCP_SERVERS_NAMESPACE} -o jsonpath='{.metadata.generation}'`
  )
}

beforeAll(
  async () => {
    controlApiUp = await requireControlApiUp('mcp-hcc-upgrade-rollout')
    if (!controlApiUp) return

    if (!BASELINE_IMAGE) {
      throw new Error(
        'TEST_HCC_BASELINE_IMAGE is required for E7 (upgrade / R1) and was not set. This scenario ' +
          'reproduces a real upgrade from a PRE-issue-#223 host-context-controller image to the ' +
          'branch\'s image — there is no safe way to fake "the old reconciler" without a real ' +
          'baseline image. Build one from origin/dev (e.g. `git worktree add ... origin/dev && ' +
          'scripts/minikube/build-images.sh host-context-controller` tagged distinctly, e.g. ' +
          'clerum/host-context-controller:origin-dev-baseline) and load it into the same minikube ' +
          'profile this suite runs against, then re-run with ' +
          'TEST_HCC_BASELINE_IMAGE=clerum/host-context-controller:origin-dev-baseline. ' +
          'Failing loud rather than skipping: a suite that quietly skips R1 coverage would let a ' +
          'real regression in the upgrade path ship silently.'
      )
    }

    adminToken = await adminLogin()
    originalHccImage = currentHccImage()
    if (!originalHccImage) {
      throw new Error(
        `Could not read the current image of deployment/${HCC_DEPLOYMENT} in ${HCC_NAMESPACE} — ` +
          `cannot safely proceed without knowing what to restore.\n${clusterDiagnostics(
            HCC_NAMESPACE,
            [`describe deployment ${HCC_DEPLOYMENT} -n ${HCC_NAMESPACE}`]
          )}`
      )
    }
    // Connector creation happens INSIDE the first `it()`, after the HCC is
    // already switched to the baseline image — NOT here. If the connectors
    // were created while the branch HCC is still running (the normal state
    // when this suite starts, since T2 deploys the branch first), they would
    // get the credentials-revision annotation from THAT reconcile, and
    // preserveDeploymentAnnotations' `{...existing, ...desired}` merge would
    // let a stale annotation survive the switch to baseline — the "baseline
    // never writes it" assertion would pass for the wrong reason.
  },
  ROLLOUT_TIMEOUT_MS + HCC_ROLLOUT_TIMEOUT_MS + 30_000
)

afterAll(async () => {
  if (!controlApiUp) return
  // Safety net: if the test body's own restore step (below) failed partway,
  // this puts the cluster back for every OTHER suite that runs after it.
  // Idempotent — re-setting the same image is a no-op rollout.
  if (originalHccImage) {
    kubectlSafe(
      `set image deployment/${HCC_DEPLOYMENT} ${HCC_CONTAINER}=${originalHccImage} -n ${HCC_NAMESPACE}`
    )
  }
  deleteMcpServerFixture(WITH_SECRET_SERVER, WITH_SECRET_NAME)
  kubectlSafe(
    `delete mcpserver ${WITHOUT_SECRET_SERVER} -n ${MCP_SERVERS_NAMESPACE} --ignore-not-found --timeout=20s`
  )
})

describe('mcp-secret rotation — E7 upgrade (R1)', () => {
  it(
    'baseline HCC (pre-#223) reconciles both connectors and never writes the credentials-revision annotation',
    async () => {
      if (!controlApiUp) return

      // Switch to the baseline image FIRST, then create the connectors, so
      // their FIRST-EVER reconcile is done by the pre-#223 reconciler. This
      // is what actually reproduces "connectors already existed when a
      // pre-#223 HCC was in charge" — the starting state E7 requires.
      await setHccImage(BASELINE_IMAGE)

      kubectlApply(
        secretYaml(WITH_SECRET_NAME, MCP_SERVERS_NAMESPACE, { 'api-key': 'upgrade-initial-value' })
      )
      kubectlApply(
        localMcpServerYaml({
          name: WITH_SECRET_SERVER,
          envSecretName: WITH_SECRET_NAME,
          keys: [{ secretKey: 'api-key', envVar: 'E2E_ROTATION_API_KEY' }],
        })
      )
      kubectlApply(localMcpServerYamlNoSecret(WITHOUT_SECRET_SERVER))

      // Wait for a REAL, positive signal that the baseline reconciler's
      // full-reconcile-on-startup actually swept THIS McpServer — never a
      // blind sleep. The line only exists once validateSecret() has run for
      // this specific server (reconciler.ts: `Secret "%s" validated for
      // McpServer %s`).
      await waitFor(
        `baseline HCC to log that it validated the Secret for "${WITH_SECRET_SERVER}"`,
        () => {
          const logs = kubectlSafe(`logs deploy/${HCC_DEPLOYMENT} -n ${HCC_NAMESPACE} --tail=500`)
          return logs &&
            logs.includes(
              `Secret "${WITH_SECRET_NAME}" validated for McpServer ${WITH_SECRET_SERVER}`
            )
            ? 'ok'
            : null
        },
        60_000,
        {
          intervalMs: 2_000,
          diagnostics: () =>
            clusterDiagnostics(HCC_NAMESPACE, [
              `logs deploy/${HCC_DEPLOYMENT} -n ${HCC_NAMESPACE} --tail=200`,
            ]),
        }
      )

      const annotation = deploymentCredentialsRevisionAnnotation(
        MCP_SERVERS_NAMESPACE,
        WITH_SECRET_SERVER
      )
      expect(
        annotation,
        'the baseline image already writes clerum.io/credentials-revision — ' +
          'TEST_HCC_BASELINE_IMAGE is not actually pre-#223, this test cannot prove anything'
      ).toBeNull()

      // Settle both connectors under the baseline reconciler before the next
      // test snapshots their "before" generation — otherwise a still-rolling
      // baseline-created Deployment could bump generation on its own and be
      // mistaken for the upgrade's rollout. We wait on the DEPLOYMENT's own
      // rollout (availableReplicas), NOT the McpServer CRD's DeploymentReady
      // condition: the baseline is a PRE-#204 image whose startup-fleet coupling
      // can delay the CRD condition long past when the pod is actually Available,
      // so asserting the condition here fails for a reason that has nothing to do
      // with issue #223. The workload being settled is exactly what the
      // generation snapshot needs.
      waitForDeploymentRolloutComplete(MCP_SERVERS_NAMESPACE, WITH_SECRET_SERVER)
      waitForDeploymentRolloutComplete(MCP_SERVERS_NAMESPACE, WITHOUT_SECRET_SERVER)
    },
    HCC_ROLLOUT_TIMEOUT_MS + ROLLOUT_TIMEOUT_MS + 60_000
  )

  it(
    'upgrading to the branch HCC rolls the envSecret connector EXACTLY ONCE and leaves the other untouched',
    async () => {
      if (!controlApiUp) return

      const withSecretGenBefore = deploymentGeneration(WITH_SECRET_SERVER)
      const withoutSecretGenBefore = deploymentGeneration(WITHOUT_SECRET_SERVER)

      const sinceMs = Date.now()
      await setHccImage(originalHccImage)

      const cond = await waitForRolloutCondition(WITH_SECRET_SERVER, adminToken, {
        expectStatus: 'True',
        sinceMs,
        timeoutMs: ROLLOUT_TIMEOUT_MS,
      })
      expect(cond.status).toBe('True')

      const annotation = deploymentCredentialsRevisionAnnotation(
        MCP_SERVERS_NAMESPACE,
        WITH_SECRET_SERVER
      )
      expect(annotation).toMatch(/^[0-9a-f]{64}$/)

      const withSecretGenAfter = deploymentGeneration(WITH_SECRET_SERVER)
      const withoutSecretGenAfter = deploymentGeneration(WITHOUT_SECRET_SERVER)

      const withSecretDelta = parseInt(withSecretGenAfter, 10) - parseInt(withSecretGenBefore, 10)
      expect(
        withSecretDelta,
        `expected exactly one rollout generation bump for the envSecret connector, got delta=${withSecretDelta} ` +
          `(before=${withSecretGenBefore}, after=${withSecretGenAfter})`
      ).toBe(1)

      expect(
        withoutSecretGenAfter,
        'a connector with no envSecret rolled during the HCC upgrade — R1 blast radius is wider than expected'
      ).toBe(withoutSecretGenBefore)
    },
    ROLLOUT_TIMEOUT_MS + HCC_ROLLOUT_TIMEOUT_MS + 30_000
  )
})

function localMcpServerYamlNoSecret(name: string): string {
  return `apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${name}
  namespace: ${MCP_SERVERS_NAMESPACE}
spec:
  contextRef: ${TEST_CONTEXT_REF}
  description: "issue #223 upgrade E2E fixture — no envSecret, must never roll"
  image: clerum/mock-mcp-server:test
  transport:
    type: streamableHttp
    url: http://${name}.${MCP_SERVERS_NAMESPACE}.svc.cluster.local:3000/mcp
    port: 3000
  healthCheck:
    port: 3001
  enabled: true
`
}
