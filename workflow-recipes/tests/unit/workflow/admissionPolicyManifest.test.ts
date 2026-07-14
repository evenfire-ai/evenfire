import { describe, expect, it } from 'vitest'
import { loadAll } from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const ADMISSION_MANIFEST = path.join(
  REPO_ROOT,
  'deploy/base/cluster-wide/workflowrecipe-admission.yaml'
)

type AdmissionResource = {
  kind?: string
  metadata?: { name?: string }
  spec?: {
    policyName?: string
    validationActions?: string[]
    matchConstraints?: {
      resourceRules?: Array<{
        apiGroups?: string[]
        apiVersions?: string[]
        operations?: string[]
        resources?: string[]
        scope?: string
      }>
    }
    validations?: Array<{
      expression?: string
      message?: string
      reason?: string
    }>
  }
}

function resources(): AdmissionResource[] {
  return loadAll(fs.readFileSync(ADMISSION_MANIFEST, 'utf8')) as AdmissionResource[]
}

function findResource(kind: string, name: string): AdmissionResource {
  const resource = resources().find(r => r.kind === kind && r.metadata?.name === name)
  if (!resource) throw new Error(`Missing ${kind} ${name}`)
  return resource
}

describe('cluster admission policy manifest', () => {
  // Per-kind budget: CronJob 52 (hardcoded K8s child-Job limit), StatefulSet 52
  // (Pod `controller-revision-hash=<name>-<hash>` reserves 1 dash + 10 hash
  // chars off the 63-byte label-value limit). DaemonSet/Deployment have no
  // name-budget policy by design.
  it.each([
    ['StatefulSet', 'wrc-statefulset-name-budget', 'apps', 'statefulsets', 52],
    ['CronJob', 'wrc-cronjob-name-budget', 'batch', 'cronjobs', 52],
  ])('enforces the WRC %s runtime name budget', (_kind, policyName, group, resource, maxLen) => {
    const policy = findResource('ValidatingAdmissionPolicy', policyName)
    const binding = findResource('ValidatingAdmissionPolicyBinding', policyName)

    expect(policy.spec?.matchConstraints?.resourceRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          apiGroups: [group],
          apiVersions: ['v1'],
          operations: expect.arrayContaining(['CREATE', 'UPDATE']),
          resources: [resource],
          scope: 'Namespaced',
        }),
      ])
    )
    expect(policy.spec?.validations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expression: expect.stringContaining(`size(object.metadata.name) <= ${maxLen}`),
          message: expect.stringContaining(`${maxLen} characters or fewer`),
          reason: 'Invalid',
        }),
      ])
    )
    expect(policy.spec?.validations?.[0]?.expression).toContain('sandbox-recipes')
    expect(policy.spec?.validations?.[0]?.expression).toContain('mcp-server')
    expect(binding.spec?.policyName).toBe(policyName)
    expect(binding.spec?.validationActions).toContain('Deny')
  })
})
