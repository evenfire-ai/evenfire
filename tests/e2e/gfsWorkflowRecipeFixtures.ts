import { assertFixtureName, kubectlOut } from './gfsFixtureCore'

export interface GfsWorkflowRecipeFixture {
  name: string
  namespace: string
  subjectId: string
}

export function seedGfsWorkflowRecipeFixture(name: string): GfsWorkflowRecipeFixture {
  assertFixtureName(name)
  const namespace = 'sandbox-recipes'
  // This remains a small text manifest submitted to the Kubernetes API; the Node 20
  // workaround is only needed for blob bytes streamed through `kubectl exec -i`.
  kubectlOut(
    ['apply', '-f', '-'],
    30_000,
    `apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${name}
  namespace: ${namespace}
  labels:
    clerum.io/e2e: "true"
spec:
  description: E2E GFS grant selector workflow fixture.
  triggers:
    onDemand: {}
  output:
    destination: pvc
    format: json
    storageSize: 64Mi
  steps:
    - id: noop
      run:
        type: snippet
        language: typescript
        code: |
          return { ok: true }
`
  )
  return { name, namespace, subjectId: `3rd:${namespace}/${name}` }
}

export function cleanupGfsWorkflowRecipeFixture(name: string): void {
  assertFixtureName(name)
  kubectlOut(
    ['-n', 'sandbox-recipes', 'delete', 'workflowrecipe', name, '--ignore-not-found=true'],
    20_000
  )
}
