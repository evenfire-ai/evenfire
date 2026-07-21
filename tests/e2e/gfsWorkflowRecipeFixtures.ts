import {
  assertFixtureName,
  firstDataLine,
  kubectlOut,
  runControlPostgresSql,
  sqlLiteral,
} from './gfsFixtureCore'

const DNS_1123_SUBDOMAIN = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/

function assertReadonlyRecipeName(name: string): void {
  if (name.length > 253 || !DNS_1123_SUBDOMAIN.test(name)) {
    throw new Error(`invalid source WorkflowRecipe name "${name}"`)
  }
}

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
  const namespace = 'sandbox-recipes'
  kubectlOut(['-n', namespace, 'delete', 'workflowrecipe', name, '--ignore-not-found=true'], 20_000)
  runControlPostgresSql(`
    DELETE FROM user_workflow_triggers
     WHERE recipe_namespace = ${sqlLiteral(namespace)}
       AND recipe_name = ${sqlLiteral(name)};
  `)
  const remainingGrantCount = firstDataLine(
    runControlPostgresSql(`
      SELECT COUNT(*)::text
        FROM user_workflow_triggers
       WHERE recipe_namespace = ${sqlLiteral(namespace)}
         AND recipe_name = ${sqlLiteral(name)};
    `)
  )
  if (remainingGrantCount !== '0') {
    throw new Error(
      `WorkflowRecipe fixture ${namespace}/${name} retained ${remainingGrantCount || 'unknown'} user grants after cleanup`
    )
  }
}

export function seedGfsWorkflowRecipeCloneFixture(
  name: string,
  sourceName: string
): GfsWorkflowRecipeFixture {
  assertFixtureName(name)
  assertReadonlyRecipeName(sourceName)
  const namespace = 'sandbox-recipes'
  const source = JSON.parse(
    kubectlOut(['-n', namespace, 'get', 'workflowrecipe', sourceName, '-o', 'json'])
  ) as { spec?: unknown }
  if (!source.spec) {
    throw new Error(`WorkflowRecipe ${namespace}/${sourceName} has no spec to clone`)
  }
  kubectlOut(
    ['apply', '-f', '-'],
    30_000,
    JSON.stringify({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: {
        name,
        namespace,
        labels: { 'clerum.io/e2e': 'true' },
      },
      spec: source.spec,
    })
  )
  const sourceGrantCount = firstDataLine(
    runControlPostgresSql(`
      WITH copied AS (
        INSERT INTO user_workflow_triggers (user_id, recipe_namespace, recipe_name)
        SELECT user_id, ${sqlLiteral(namespace)}, ${sqlLiteral(name)}
          FROM user_workflow_triggers
         WHERE recipe_namespace = ${sqlLiteral(namespace)}
           AND recipe_name = ${sqlLiteral(sourceName)}
        ON CONFLICT DO NOTHING
        RETURNING user_id
      )
      SELECT COUNT(*)::text
        FROM user_workflow_triggers
       WHERE recipe_namespace = ${sqlLiteral(namespace)}
         AND recipe_name = ${sqlLiteral(sourceName)};
    `)
  )
  if (!/^\d+$/.test(sourceGrantCount) || Number(sourceGrantCount) < 1) {
    throw new Error(
      `WorkflowRecipe ${namespace}/${sourceName} has no user grant to copy into ${namespace}/${name}`
    )
  }
  return { name, namespace, subjectId: `3rd:${namespace}/${name}` }
}
