import type { DbRunRow } from '../reconciler/dbRunProcessor.js'
import type { WorkflowRecipeGfsIntentSpec } from '../types.js'

const defaultedStep: Record<string, unknown> = {
  id: 'step-1',
  timeoutSeconds: 300,
  backoffSeconds: 30,
  maxRetries: 2,
  maxIterations: 50,
}

export function makeRun(overrides: Partial<DbRunRow> = {}): DbRunRow {
  return {
    run_id: '00000000-0000-0000-0000-000000000123',
    recipe_namespace: 'sandbox-recipes',
    recipe_name: 'demo-parent',
    phase: 'Pending',
    team_id: null,
    usage_team_id: null,
    actor_type: 'user',
    actor_id: null,
    inputs: null,
    intermediate_parameters: null,
    output_overrides: null,
    trigger_source: 'onDemand',
    owner_instance_id: null,
    max_duration_seconds: 600,
    started_at: null,
    child_recipe_name: null,
    child_recipe_namespace: null,
    ...overrides,
  }
}

export function makeParent(gfs?: WorkflowRecipeGfsIntentSpec) {
  return {
    metadata: {
      name: 'demo-parent',
      namespace: 'sandbox-recipes',
      uid: 'parent-uid-1',
    },
    spec: {
      coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
      inputContract: { properties: { greeting: { type: 'string', default: 'hello' } } },
      // The parent is read from Kubernetes, so CRD defaults are materialized.
      steps: [{ ...defaultedStep }],
      inputs: { greeting: 'hello' },
      computed: [{ name: 'db_mode', expression: "'readonly'" }],
      resources: [{ id: 'api-key', type: 'secret', data: { token: 'redacted' } }],
      runtimeEgress: { http: { allowedHosts: ['swapi.info'] } },
      ...(gfs ? { gfs } : {}),
    },
  }
}

export function makeExistingChild(gfs?: WorkflowRecipeGfsIntentSpec) {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: {
      name: 'demo-parent-00000000',
      namespace: 'sandbox-recipes',
      labels: {
        'clerum.io/workflow-run-id': '00000000-0000-0000-0000-000000000123',
        'clerum.io/parent-recipe': 'demo-parent',
      },
      annotations: { 'clerum.io/inherited-parent-resources': 'true' },
      ownerReferences: [
        {
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          name: 'demo-parent',
          uid: 'parent-uid-1',
          controller: true,
        },
      ],
    },
    spec: {
      coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
      steps: [{ ...defaultedStep }],
      resources: [{ id: 'api-key', type: 'secret', data: { token: 'redacted' } }],
      runtimeEgress: { http: { allowedHosts: ['swapi.info'] } },
      inputContract: { properties: { greeting: { type: 'string', default: 'hello' } } },
      computed: [{ name: 'db_mode', expression: "'readonly'" }],
      inputs: { greeting: 'hello' },
      ...(gfs ? { gfs } : {}),
    },
  }
}
