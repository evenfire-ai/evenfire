import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RECIPE_NAMESPACE, SANDBOX_NAMESPACE, kubectl, kubectlJson, sleep } from './helpers'

const POLICY_NAME = 'hostile-strict-policy'
const INVALID_DNS_RECIPE = 'hostile-invalid-dns'
const INVALID_FIELD_RECIPE = 'hostile-smuggled-field'
const DOWNGRADE_RECIPE = 'hostile-isolation-downgrade'

function cleanupRecipe(name: string): void {
  try {
    kubectl(`delete workflowrecipe ${name} -n ${RECIPE_NAMESPACE} --ignore-not-found --timeout=20s`)
  } catch {
    /* ignore */
  }
}

beforeAll(() => {
  cleanupRecipe(INVALID_DNS_RECIPE)
  cleanupRecipe(INVALID_FIELD_RECIPE)
  cleanupRecipe(DOWNGRADE_RECIPE)
  try {
    kubectl(
      `delete workflowrecipepolicies.clerum.io ${POLICY_NAME} -n ${RECIPE_NAMESPACE} --ignore-not-found`
    )
  } catch {
    /* ignore */
  }
})

afterAll(() => {
  cleanupRecipe(INVALID_DNS_RECIPE)
  cleanupRecipe(INVALID_FIELD_RECIPE)
  cleanupRecipe(DOWNGRADE_RECIPE)
  try {
    kubectl(
      `delete workflowrecipepolicies.clerum.io ${POLICY_NAME} -n ${RECIPE_NAMESPACE} --ignore-not-found`
    )
  } catch {
    /* ignore */
  }
})

describe('Hostile WorkflowRecipe E2E', () => {
  it('rejects egressBindings that use CIDR notation in dns', () => {
    expect(() =>
      kubectl(`apply -f - <<'EOF'
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${INVALID_DNS_RECIPE}
  namespace: ${RECIPE_NAMESPACE}
spec:
  contextRef: default
  workloads:
    - id: hostile-agent
      type: deployment
      image: nginx:1.30.1-alpine
      port: 3000
      transport:
        type: streamableHttp
      egressBindings:
        - dns: "0.0.0.0/0"
          port: 443
          protocol: TCP
  security:
    isolationLevel: strict
EOF`)
    ).toThrow(/CIDR|egressBindings|dns/i)

    expect(() => {
      kubectl(`get workflowrecipe ${INVALID_DNS_RECIPE} -n ${RECIPE_NAMESPACE}`)
    }).toThrow()
  })

  it('rejects egressBindings that smuggle fields not present in the schema', () => {
    expect(() =>
      kubectl(`apply -f - <<'EOF'
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${INVALID_FIELD_RECIPE}
  namespace: ${RECIPE_NAMESPACE}
spec:
  contextRef: default
  workloads:
    - id: hostile-agent
      type: deployment
      image: nginx:1.30.1-alpine
      port: 3000
      transport:
        type: streamableHttp
      egressBindings:
        - dns: "api.openai.com"
          port: 443
          protocol: TCP
          cidr: "10.0.0.0/8"
  security:
    isolationLevel: strict
EOF`)
    ).toThrow(/cidr|unknown field|additionalProperties/i)

    expect(() => {
      kubectl(`get workflowrecipe ${INVALID_FIELD_RECIPE} -n ${RECIPE_NAMESPACE}`)
    }).toThrow()
  })

  it('blocks isolation downgrade under a strict WorkflowRecipePolicy', async () => {
    kubectl(`apply -f - <<'EOF'
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipePolicy
metadata:
  name: ${POLICY_NAME}
  namespace: ${RECIPE_NAMESPACE}
spec:
  description: Strict policy for hostile workflow coverage
  governance:
    requiredSecurityLevel: strict
EOF`)

    kubectl(`apply -f - <<'EOF'
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${DOWNGRADE_RECIPE}
  namespace: ${RECIPE_NAMESPACE}
spec:
  workloads:
    - id: downgraded
      type: deployment
      image: nginx:1.30.1-alpine
      port: 8080
  security:
    isolationLevel: minimal
EOF`)

    await sleep(5_000)

    const recipe = kubectlJson<{
      status?: {
        phase?: string
        message?: string
      }
    }>(`get workflowrecipe ${DOWNGRADE_RECIPE} -n ${RECIPE_NAMESPACE}`)

    expect(recipe.status?.phase).toBe('failed')
    expect(recipe.status?.message ?? '').toContain('Policy violation')

    const deploys = kubectlJson<{ items: unknown[] }>(
      `get deploy -l clerum.io/recipe=${DOWNGRADE_RECIPE} -n ${SANDBOX_NAMESPACE}`
    )
    expect(deploys.items.length).toBe(0)
  })
})
