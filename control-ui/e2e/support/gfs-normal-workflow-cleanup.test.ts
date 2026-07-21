import { expect } from '@playwright/test'
import {
  UUID_RE,
  firstDataLine,
  kubectlOut,
  runControlPostgresSql,
  sqlLiteral,
} from '../../../tests/e2e/gfsUiFixtures'
import {
  GFS_PLUGIN_NAMESPACE,
  GFS_PLUGIN_RECIPE,
  type WorkflowRecipeResource,
} from './gfs-normal-workflow-run.test'

// Covers one 25s Kubernetes delete, a late-child observation allowance, and
// the required 10s quiet window within the enclosing 600s journey budget.
const CLEANUP_TIMEOUT_MS = 75_000
const LATE_CHILD_QUIET_WINDOW_MS = 10_000

function workflowRecipeOrUndefined(name: string): WorkflowRecipeResource | undefined {
  const raw = kubectlOut([
    '-n',
    GFS_PLUGIN_NAMESPACE,
    'get',
    'workflowrecipe',
    name,
    '--ignore-not-found=true',
    '-o',
    'json',
  ]).trim()
  return raw ? (JSON.parse(raw) as WorkflowRecipeResource) : undefined
}

function isVerifiedRunChild(
  child: WorkflowRecipeResource,
  input: { childName: string; parentName: string; parentUid: string; runId: string }
): boolean {
  const owners = child.metadata?.ownerReferences ?? []
  const owner = owners[0]
  return (
    child.metadata?.name === input.childName &&
    child.metadata?.namespace === GFS_PLUGIN_NAMESPACE &&
    child.metadata?.labels?.['clerum.io/workflow-run-id'] === input.runId &&
    child.metadata?.labels?.['clerum.io/parent-recipe'] === input.parentName &&
    owners.length === 1 &&
    owner?.controller === true &&
    owner.apiVersion === 'clerum.io/v1alpha1' &&
    owner.kind === 'WorkflowRecipe' &&
    owner.name === input.parentName &&
    owner.uid === input.parentUid
  )
}

function namesByLabel(namespace: string, resources: string, selector: string): string[] {
  return kubectlOut(['-n', namespace, 'get', resources, '-l', selector, '-o', 'name'])
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean)
    .sort()
}

function runChildNames(runId: string): string[] {
  return namesByLabel(GFS_PLUGIN_NAMESPACE, 'workflowrecipe', `clerum.io/workflow-run-id=${runId}`)
}

function deleteVerifiedRunChildren(
  runId: string,
  candidateNames: string[],
  recipeName: string
): { deleted: number; names: string[] } {
  const parent = workflowRecipeOrUndefined(recipeName)
  const parentUid = parent?.metadata?.uid ?? ''
  const discoveredNames = runChildNames(runId).map(name => name.slice(name.indexOf('/') + 1))
  const names = [...new Set([...candidateNames, ...discoveredNames])]
  let deleted = 0
  for (const childName of names) {
    if (childName === recipeName) {
      throw new Error(`Refusing to clean parent WorkflowRecipe for run ${runId}`)
    }
    const child = workflowRecipeOrUndefined(childName)
    if (!child) continue
    if (
      !parentUid ||
      !isVerifiedRunChild(child, { childName, parentName: recipeName, parentUid, runId })
    ) {
      throw new Error(
        `Refusing to delete unverified workflow child ${GFS_PLUGIN_NAMESPACE}/${childName} for run ${runId}`
      )
    }
    kubectlOut(
      [
        '-n',
        GFS_PLUGIN_NAMESPACE,
        'delete',
        'workflowrecipe',
        childName,
        '--wait=true',
        '--timeout=25s',
      ],
      CLEANUP_TIMEOUT_MS
    )
    deleted += 1
  }
  return { deleted, names }
}

function leakedRuntimeResources(candidateNames: string[], runId: string) {
  const childNames = runChildNames(runId).map(name => name.slice(name.indexOf('/') + 1))
  const names = [...new Set([...candidateNames, ...childNames])]
  const sandboxResources = names.flatMap(name =>
    namesByLabel(
      GFS_PLUGIN_NAMESPACE,
      'pod,service,secret,networkpolicy,configmap,persistentvolumeclaim',
      `clerum.io/recipe=${name}`
    )
  )
  const transportResources = names.flatMap(name =>
    namesByLabel(
      'mcp-server',
      'mcpserver,context,service,deployment,secret',
      `clerum.io/recipe=${name}`
    )
  )
  return {
    childRecipes: runChildNames(runId),
    sandboxResources: [...new Set(sandboxResources)].sort(),
    transportResources: [...new Set(transportResources)].sort(),
  }
}

export async function cleanupNormalGfsPluginRun(
  runId: string | undefined,
  observedChildName: string | undefined,
  recipeName = GFS_PLUGIN_RECIPE
): Promise<void> {
  if (!runId || !UUID_RE.test(runId)) return

  const persistedChildName = firstDataLine(
    runControlPostgresSql(`
      UPDATE workflow_runs
         SET phase = 'Canceled', completed_at = COALESCE(completed_at, now()), updated_at = now()
       WHERE run_id = ${sqlLiteral(runId)}::uuid
         AND recipe_namespace = ${sqlLiteral(GFS_PLUGIN_NAMESPACE)}
         AND recipe_name = ${sqlLiteral(recipeName)}
      RETURNING child_recipe_name;
    `)
  )
  let candidates = [...new Set([observedChildName, persistedChildName].filter(Boolean))] as string[]

  let lastChildActivityAt = Date.now()
  await expect
    .poll(
      () => {
        const cleanup = deleteVerifiedRunChildren(runId, candidates, recipeName)
        candidates = cleanup.names
        if (cleanup.deleted > 0) lastChildActivityAt = Date.now()
        return {
          ...leakedRuntimeResources(candidates, runId),
          quietWindowElapsed: Date.now() - lastChildActivityAt >= LATE_CHILD_QUIET_WINDOW_MS,
        }
      },
      {
        timeout: CLEANUP_TIMEOUT_MS,
        intervals: [500, 1_000, 2_000],
        message: `workflow run ${runId} should stop creating children after cancellation`,
      }
    )
    .toEqual({
      childRecipes: [],
      sandboxResources: [],
      transportResources: [],
      quietWindowElapsed: true,
    })

  runControlPostgresSql(`
    DELETE FROM workflow_approval_requests
     WHERE bound_workflow_run_id = ${sqlLiteral(runId)}::uuid
       AND recipe_namespace = ${sqlLiteral(GFS_PLUGIN_NAMESPACE)}
       AND recipe_name = ${sqlLiteral(recipeName)};
    DELETE FROM workflow_runs
     WHERE run_id = ${sqlLiteral(runId)}::uuid
       AND recipe_namespace = ${sqlLiteral(GFS_PLUGIN_NAMESPACE)}
       AND recipe_name = ${sqlLiteral(recipeName)};
  `)

  expect(leakedRuntimeResources(candidates, runId)).toEqual({
    childRecipes: [],
    sandboxResources: [],
    transportResources: [],
  })

  expect(
    firstDataLine(
      runControlPostgresSql(`
        SELECT
          (SELECT COUNT(*) FROM workflow_approval_requests
            WHERE bound_workflow_run_id = ${sqlLiteral(runId)}::uuid)::text || '|' ||
          (SELECT COUNT(*) FROM workflow_run_steps
            WHERE run_id = ${sqlLiteral(runId)}::uuid)::text || '|' ||
          (SELECT COUNT(*) FROM workflow_runs
            WHERE run_id = ${sqlLiteral(runId)}::uuid)::text;
      `)
    )
  ).toBe('0|0|0')
}
