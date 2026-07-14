import { afterAll, describe, expect, it } from 'vitest'
import { SANDBOX_NAMESPACE, kubectl, kubectlJson } from './helpers'

const STATEFULSET_NAME_POLICY_NAME = 'wrc-statefulset-name-budget'
const CRONJOB_NAME_POLICY_NAME = 'wrc-cronjob-name-budget'

function nameOfLength(prefix: string, length: number): string {
  return `${prefix}${'a'.repeat(length - prefix.length)}`
}

const TOO_LONG_STATEFULSET = nameOfLength('admission-sts-', 53)
const TOO_LONG_CRONJOB = nameOfLength('admission-cj-', 53)

afterAll(() => {
  try {
    kubectl(`delete statefulset ${TOO_LONG_STATEFULSET} -n ${SANDBOX_NAMESPACE} --ignore-not-found`)
    kubectl(`delete cronjob ${TOO_LONG_CRONJOB} -n ${SANDBOX_NAMESPACE} --ignore-not-found`)
  } catch {
    /* ignore */
  }
})

describe('WRC runtime workload name admission enforcement', () => {
  it.each([
    ['StatefulSet', STATEFULSET_NAME_POLICY_NAME, '52 characters or fewer'],
    ['CronJob', CRONJOB_NAME_POLICY_NAME, '52 characters or fewer'],
  ])('publishes the %s name-budget policy and binding', (_kind, policyName, expectedMsg) => {
    const policy = kubectlJson<{
      metadata: { name: string }
      spec: { validations: Array<{ message?: string }> }
    }>(`get validatingadmissionpolicy ${policyName}`)
    expect(policy.metadata.name).toBe(policyName)
    expect(policy.spec.validations.some(v => v.message?.includes(expectedMsg))).toBe(true)

    const binding = kubectlJson<{
      metadata: { name: string }
      spec: { policyName: string; validationActions: string[] }
    }>(`get validatingadmissionpolicybinding ${policyName}`)
    expect(binding.metadata.name).toBe(policyName)
    expect(binding.spec.policyName).toBe(policyName)
    expect(binding.spec.validationActions).toContain('Deny')
  })

  it('rejects direct StatefulSet manifests above the 52-character runtime budget', () => {
    expect(TOO_LONG_STATEFULSET).toHaveLength(53)
    expect(() =>
      kubectl(`apply -f - <<'EOF'
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${TOO_LONG_STATEFULSET}
  namespace: ${SANDBOX_NAMESPACE}
spec:
  serviceName: admission-sts-headless
  replicas: 1
  selector:
    matchLabels:
      app: admission-sts-name-budget
  template:
    metadata:
      labels:
        app: admission-sts-name-budget
    spec:
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: app
          image: nginx:1.30.1-alpine
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
          ports:
            - containerPort: 80
EOF`)
    ).toThrow(/52 characters|denied|invalid/i)
  })

  it('rejects direct CronJob manifests above the 52-character runtime budget', () => {
    expect(TOO_LONG_CRONJOB).toHaveLength(53)
    expect(() =>
      kubectl(`apply -f - <<'EOF'
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ${TOO_LONG_CRONJOB}
  namespace: ${SANDBOX_NAMESPACE}
spec:
  schedule: "*/5 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: app
              image: nginx:1.30.1-alpine
EOF`)
    ).toThrow(/52 characters|no more than 52|denied|invalid/i)
  })
})
