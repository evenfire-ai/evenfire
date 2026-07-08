import { afterAll, describe, expect, it } from 'vitest'
import { MCP_SERVER_NAMESPACE, SANDBOX_NAMESPACE, kubectl, kubectlJson } from './helpers'

const WRONG_NAMESPACE_RECIPE = 'admission-wrong-namespace'
const OWNERREF_RECIPE = 'admission-ownerref-denied'
const OWNERREF_UPDATE_PARENT = 'admission-ownerref-update-parent'
const OWNERREF_UPDATE_CHILD = 'admission-ownerref-update-child'
const OWNERREF_WRC_PARENT = 'admission-ownerref-wrc-parent'
const OWNERREF_WRC_CHILD = 'admission-ownerref-wrc-child'
const POLICY_NAME = 'workflowrecipe-namespace-allowlist'
const POLICY_BINDING_NAME = 'workflowrecipe-namespace-allowlist'
const NETPOL_POLICY_NAME = 'managed-networkpolicy-label-immutability'
const NETPOL_POLICY_BINDING_NAME = 'managed-networkpolicy-label-immutability'
const MANAGED_NETPOL = 'admission-managed-netpol'
const MANAGED_NETPOL_CREATE = 'admission-managed-netpol-create'
const UNMANAGED_NETPOL = 'admission-unmanaged-netpol'
const IMPERSONATED_UNMANAGED_NETPOL = 'admission-impersonated-unmanaged-netpol'
const NETPOL_CREATOR_USER = 'admission-netpol-creator'
const NETPOL_CREATOR_ROLE = 'admission-netpol-creator'
const NETPOL_CREATOR_BINDING = 'admission-netpol-creator'
const WRC_SERVICE_ACCOUNT = 'system:serviceaccount:control-plane:workflow-recipes'

function applyStepRecipe(name: string): void {
  kubectl(`apply -f - <<'EOF'
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${name}
  namespace: ${SANDBOX_NAMESPACE}
spec:
  steps:
    - id: noop
      instruction: "noop"
EOF`)
}

function workflowRecipeUid(name: string): string {
  return kubectl(`get workflowrecipe ${name} -n ${SANDBOX_NAMESPACE} -o jsonpath='{.metadata.uid}'`)
}

afterAll(() => {
  try {
    kubectl(
      `delete workflowrecipe ${WRONG_NAMESPACE_RECIPE} -n ${SANDBOX_NAMESPACE} --ignore-not-found`
    )
    kubectl(
      `delete workflowrecipe ${WRONG_NAMESPACE_RECIPE} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found`
    )
    kubectl(`delete workflowrecipe ${OWNERREF_RECIPE} -n ${SANDBOX_NAMESPACE} --ignore-not-found`)
    kubectl(
      `delete workflowrecipe ${OWNERREF_UPDATE_CHILD} ${OWNERREF_UPDATE_PARENT} ${OWNERREF_WRC_CHILD} ${OWNERREF_WRC_PARENT} -n ${SANDBOX_NAMESPACE} --ignore-not-found`
    )
    kubectl(
      `delete networkpolicy ${MANAGED_NETPOL} ${MANAGED_NETPOL_CREATE} ${UNMANAGED_NETPOL} ${IMPERSONATED_UNMANAGED_NETPOL} -n ${SANDBOX_NAMESPACE} --ignore-not-found`
    )
    kubectl(
      `delete rolebinding ${NETPOL_CREATOR_BINDING} -n ${SANDBOX_NAMESPACE} --ignore-not-found`
    )
    kubectl(`delete role ${NETPOL_CREATOR_ROLE} -n ${SANDBOX_NAMESPACE} --ignore-not-found`)
  } catch {
    /* ignore */
  }
})

describe('WorkflowRecipe admission enforcement', () => {
  it('publishes the namespace admission policy and binding', () => {
    const policy = kubectlJson<{
      metadata: { name: string }
      spec: {
        validations: Array<{ message?: string }>
      }
    }>(`get validatingadmissionpolicy ${POLICY_NAME}`)
    expect(policy.metadata.name).toBe(POLICY_NAME)
    expect(policy.spec.validations[0]?.message ?? '').toContain('sandbox-recipes')
    expect(policy.spec.validations[0]?.message ?? '').toContain('mcp-server is only')
    expect(policy.spec.validations.some(v => v.message?.includes('ownerReferences'))).toBe(true)

    const binding = kubectlJson<{
      metadata: { name: string }
      spec: {
        policyName: string
        validationActions: string[]
      }
    }>(`get validatingadmissionpolicybinding ${POLICY_BINDING_NAME}`)
    expect(binding.metadata.name).toBe(POLICY_BINDING_NAME)
    expect(binding.spec.policyName).toBe(POLICY_NAME)
    expect(binding.spec.validationActions).toContain('Deny')
  })

  it('rejects WorkflowRecipe creation in mcp-server before reconcile runs', () => {
    expect(() =>
      kubectl(`apply -f - <<'EOF'
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${WRONG_NAMESPACE_RECIPE}
  namespace: ${MCP_SERVER_NAMESPACE}
spec:
  workloads:
    - id: api
      type: deployment
      image: nginx:1.30.1-alpine
      port: 8080
  security:
    isolationLevel: strict
EOF`)
    ).toThrow(/sandbox-recipes|denied/i)

    expect(() => {
      kubectl(`get workflowrecipe ${WRONG_NAMESPACE_RECIPE} -n ${MCP_SERVER_NAMESPACE}`)
    }).toThrow()

    const recipes = kubectlJson<{ items: Array<{ metadata: { name: string } }> }>(
      `get workflowrecipes.clerum.io -n ${SANDBOX_NAMESPACE}`
    )
    expect(recipes.items.find(item => item.metadata.name === WRONG_NAMESPACE_RECIPE)).toBeFalsy()
  })

  it('rejects client-authored WorkflowRecipe ownerReferences', () => {
    expect(() =>
      kubectl(`apply -f - <<'EOF'
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${OWNERREF_RECIPE}
  namespace: ${SANDBOX_NAMESPACE}
  ownerReferences:
    - apiVersion: clerum.io/v1alpha1
      kind: WorkflowRecipe
      name: victim-recipe
      uid: "00000000-0000-0000-0000-000000000000"
      controller: true
spec:
  steps:
    - id: noop
      instruction: "noop"
EOF`)
    ).toThrow(/ownerReferences|denied|forbidden/i)

    expect(() => {
      kubectl(`get workflowrecipe ${OWNERREF_RECIPE} -n ${SANDBOX_NAMESPACE}`)
    }).toThrow()
  })

  it('rejects ownerReferences added by update even when the attacker uses a live parent UID', () => {
    applyStepRecipe(OWNERREF_UPDATE_PARENT)
    applyStepRecipe(OWNERREF_UPDATE_CHILD)
    const parentUid = workflowRecipeUid(OWNERREF_UPDATE_PARENT)

    expect(() =>
      kubectl(
        `patch workflowrecipe ${OWNERREF_UPDATE_CHILD} -n ${SANDBOX_NAMESPACE} --type=merge -p '{"metadata":{"ownerReferences":[{"apiVersion":"clerum.io/v1alpha1","kind":"WorkflowRecipe","name":"${OWNERREF_UPDATE_PARENT}","uid":"${parentUid}","controller":true}]}}'`
      )
    ).toThrow(/ownerReferences|denied|forbidden/i)

    const child = kubectlJson<{ metadata: { ownerReferences?: unknown[] } }>(
      `get workflowrecipe ${OWNERREF_UPDATE_CHILD} -n ${SANDBOX_NAMESPACE}`
    )
    expect(child.metadata.ownerReferences ?? []).toHaveLength(0)
  })

  it('allows the workflow-recipes ServiceAccount to create controller ownerReferences', () => {
    applyStepRecipe(OWNERREF_WRC_PARENT)
    const parentUid = workflowRecipeUid(OWNERREF_WRC_PARENT)

    kubectl(`--as=${WRC_SERVICE_ACCOUNT} apply -f - <<'EOF'
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${OWNERREF_WRC_CHILD}
  namespace: ${SANDBOX_NAMESPACE}
  ownerReferences:
    - apiVersion: clerum.io/v1alpha1
      kind: WorkflowRecipe
      name: ${OWNERREF_WRC_PARENT}
      uid: "${parentUid}"
      controller: true
spec:
  steps:
    - id: noop
      instruction: "noop"
EOF`)

    const child = kubectlJson<{
      metadata: { ownerReferences?: Array<{ name?: string; uid?: string; controller?: boolean }> }
    }>(`get workflowrecipe ${OWNERREF_WRC_CHILD} -n ${SANDBOX_NAMESPACE}`)
    expect(child.metadata.ownerReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: OWNERREF_WRC_PARENT,
          uid: parentUid,
          controller: true,
        }),
      ])
    )
  })
})

describe('Managed NetworkPolicy admission enforcement', () => {
  it('publishes the label immutability admission policy and binding', () => {
    const policy = kubectlJson<{
      metadata: { name: string }
      spec: {
        matchConstraints: {
          resourceRules: Array<{ operations: string[] }>
        }
        validations: Array<{ message?: string }>
      }
    }>(`get validatingadmissionpolicy ${NETPOL_POLICY_NAME}`)
    expect(policy.metadata.name).toBe(NETPOL_POLICY_NAME)
    expect(policy.spec.matchConstraints.resourceRules[0]?.operations).toEqual(
      expect.arrayContaining(['CREATE', 'UPDATE'])
    )
    expect(policy.spec.validations.some(v => v.message?.includes('managed-by'))).toBe(true)
    expect(policy.spec.validations.some(v => v.message?.includes('policy-type'))).toBe(true)

    const binding = kubectlJson<{
      metadata: { name: string }
      spec: { policyName: string; validationActions: string[] }
    }>(`get validatingadmissionpolicybinding ${NETPOL_POLICY_BINDING_NAME}`)
    expect(binding.metadata.name).toBe(NETPOL_POLICY_BINDING_NAME)
    expect(binding.spec.policyName).toBe(NETPOL_POLICY_NAME)
    expect(binding.spec.validationActions).toContain('Deny')
  })

  it('blocks mutation and removal of critical labels on managed NetworkPolicies', () => {
    kubectl(`apply -f - <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${MANAGED_NETPOL}
  namespace: ${SANDBOX_NAMESPACE}
  labels:
    clerum.io/managed-by: wrc
    clerum.io/policy-type: runtime-egress
    clerum.io/recipe: admission-recipe
    clerum.io/component: workflow-mcp-host
spec:
  podSelector:
    matchLabels:
      app: admission-managed
  policyTypes:
    - Egress
EOF`)

    expect(() =>
      kubectl(
        `label networkpolicy ${MANAGED_NETPOL} -n ${SANDBOX_NAMESPACE} clerum.io/managed-by=host-context-controller --overwrite`
      )
    ).toThrow(/immutable|denied|forbidden/i)

    expect(() =>
      kubectl(`label networkpolicy ${MANAGED_NETPOL} -n ${SANDBOX_NAMESPACE} clerum.io/recipe-`)
    ).toThrow(/immutable|denied|forbidden/i)

    kubectl(
      `annotate networkpolicy ${MANAGED_NETPOL} -n ${SANDBOX_NAMESPACE} admission.clerum.io/spec-update=allowed --overwrite`
    )
  })

  it('does not block ordinary unmanaged NetworkPolicy updates', () => {
    kubectl(`apply -f - <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${UNMANAGED_NETPOL}
  namespace: ${SANDBOX_NAMESPACE}
spec:
  podSelector:
    matchLabels:
      app: admission-unmanaged
  policyTypes:
    - Egress
EOF`)

    kubectl(
      `label networkpolicy ${UNMANAGED_NETPOL} -n ${SANDBOX_NAMESPACE} example.com/scope=test --overwrite`
    )

    expect(() =>
      kubectl(
        `label networkpolicy ${UNMANAGED_NETPOL} -n ${SANDBOX_NAMESPACE} clerum.io/managed-by=wrc --overwrite`
      )
    ).toThrow(/managed controller label|denied|forbidden/i)
  })

  it('blocks non-controller creation of NetworkPolicies with managed labels', () => {
    kubectl(`apply -f - <<'EOF'
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${NETPOL_CREATOR_ROLE}
  namespace: ${SANDBOX_NAMESPACE}
rules:
  - apiGroups:
      - networking.k8s.io
    resources:
      - networkpolicies
    verbs:
      - create
      - get
      - patch
      - update
      - delete
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${NETPOL_CREATOR_BINDING}
  namespace: ${SANDBOX_NAMESPACE}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${NETPOL_CREATOR_ROLE}
subjects:
  - kind: User
    name: ${NETPOL_CREATOR_USER}
    apiGroup: rbac.authorization.k8s.io
EOF`)

    kubectl(`--as=${NETPOL_CREATOR_USER} apply -f - <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${IMPERSONATED_UNMANAGED_NETPOL}
  namespace: ${SANDBOX_NAMESPACE}
spec:
  podSelector:
    matchLabels:
      app: admission-impersonated-unmanaged
  policyTypes:
    - Egress
EOF`)

    expect(() =>
      kubectl(`--as=${NETPOL_CREATOR_USER} apply -f - <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${MANAGED_NETPOL_CREATE}
  namespace: ${SANDBOX_NAMESPACE}
  labels:
    clerum.io/managed-by: wrc
    clerum.io/policy-type: runtime-egress
    clerum.io/recipe: admission-recipe
spec:
  podSelector:
    matchLabels:
      app: admission-managed-create
  policyTypes:
    - Egress
EOF`)
    ).toThrow(/owning controllers|managed controller|denied|forbidden/i)
  })
})
