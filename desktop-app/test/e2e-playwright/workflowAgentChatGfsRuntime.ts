import { expect } from '@playwright/test'
import {
  firstDataLine,
  runControlPostgresSql,
  splitSqlRow,
  sqlLiteral,
} from '../../../tests/e2e/gfsUiFixtures'
import { type WorkflowToolCall, singleSuccessfulToolCall } from './workflowAgentChatGfsToolCalls'
import { kubectl } from './workflowAgentChatTools'

export const GFS_PLUGIN_NAMESPACE = 'sandbox-recipes'
export const GFS_PLUGIN_RECIPE = 'gfs-grant-e2e-plugin'
export const GFS_PLUGIN_SUBJECT_ID = `3rd:${GFS_PLUGIN_NAMESPACE}/${GFS_PLUGIN_RECIPE}`

type WorkflowRecipeResource = {
  metadata?: {
    name?: string
    uid?: string
    labels?: Record<string, string>
    ownerReferences?: Array<{
      apiVersion?: string
      blockOwnerDeletion?: boolean
      controller?: boolean
      kind?: string
      name?: string
      uid?: string
    }>
  }
  spec?: {
    gfs?: { mounts?: Array<{ drive?: string; scopes?: string[]; target?: string }> }
    inputs?: Record<string, unknown>
  }
  status?: {
    steps?: Array<{
      id?: string
      phase?: string
      toolsCalled?: Array<{
        args?: Record<string, unknown>
        result?: unknown
        serverName?: string
        toolName?: string
      }>
    }>
  }
}

type ConfigMapResource = { data?: Record<string, string> }

type PodList = {
  items?: Array<{
    metadata?: { name?: string; deletionTimestamp?: string }
    status?: { conditions?: Array<{ type?: string; status?: string }> }
  }>
}

export type GfsWorkflowRun = { childName: string; runId: string }

function kubectlJson<T>(args: string[]): T {
  return JSON.parse(kubectl([...args, '-o', 'json'], undefined, 20_000)) as T
}

function workflowPodState(
  recipeName: string,
  component: 'workflow-coordinator' | 'workflow-mcp-host'
): { names: string[]; ready: boolean } {
  const pods = kubectlJson<PodList>([
    '-n',
    GFS_PLUGIN_NAMESPACE,
    'get',
    'pod',
    '-l',
    `clerum.io/recipe=${recipeName},clerum.io/component=${component}`,
  ])
  const items = pods.items ?? []
  return {
    names: items.map(item => item.metadata?.name ?? '').filter(Boolean),
    ready:
      items.length === 1 &&
      !items[0]?.metadata?.deletionTimestamp &&
      items[0]?.status?.conditions?.some(
        condition => condition.type === 'Ready' && condition.status === 'True'
      ) === true,
  }
}

function expectParentAndChild(
  runId: string,
  childName: string,
  expectedInputs: { resourceId: string; updatedContent: string }
): void {
  const parent = kubectlJson<WorkflowRecipeResource>([
    '-n',
    GFS_PLUGIN_NAMESPACE,
    'get',
    'workflowrecipe',
    GFS_PLUGIN_RECIPE,
  ])
  const child = kubectlJson<WorkflowRecipeResource>([
    '-n',
    GFS_PLUGIN_NAMESPACE,
    'get',
    'workflowrecipe',
    childName,
  ])
  expect(parent.metadata?.uid).toBeTruthy()
  expect(child.metadata?.labels).toMatchObject({
    'clerum.io/parent-recipe': GFS_PLUGIN_RECIPE,
    'clerum.io/workflow-run-id': runId,
  })
  expect(child.metadata?.ownerReferences).toEqual([
    expect.objectContaining({
      apiVersion: 'clerum.io/v1alpha1',
      blockOwnerDeletion: true,
      controller: true,
      kind: 'WorkflowRecipe',
      name: GFS_PLUGIN_RECIPE,
      uid: parent.metadata!.uid,
    }),
  ])
  expect(child.spec?.gfs?.mounts).toEqual([
    {
      drive: 'main',
      target: 'e2e/gfs-grant-e2e-plugin',
      scopes: ['gfs.read', 'gfs.write'],
    },
  ])
  expect(child.spec?.inputs).toEqual(expectedInputs)
  const workflowConfig = kubectlJson<ConfigMapResource>([
    '-n',
    GFS_PLUGIN_NAMESPACE,
    'get',
    'configmap',
    `${childName}-workflow-config`,
  ])
  const config = JSON.parse(workflowConfig.data?.['config.json'] ?? '{}') as {
    steps?: Array<{
      allowedTools?: { include?: string[] }
      dependsOn?: string[]
      id?: string
      maxIterations?: number
      toolChoice?: string
    }>
  }
  expect(config.steps).toEqual([
    expect.objectContaining({
      id: 'approval-held-gfs-read',
      maxIterations: 3,
      toolChoice: 'required',
      allowedTools: { include: ['clerum__gfs_read'] },
    }),
    expect.objectContaining({
      id: 'gfs-stat-probe',
      dependsOn: ['approval-held-gfs-read'],
      maxIterations: 3,
      toolChoice: 'required',
      allowedTools: { include: ['clerum__gfs_stat'] },
    }),
    expect.objectContaining({
      id: 'gfs-write-probe',
      dependsOn: ['gfs-stat-probe'],
      maxIterations: 3,
      toolChoice: 'required',
      allowedTools: { include: ['clerum__gfs_write'] },
    }),
    expect.objectContaining({
      id: 'read-back-gfs-probe',
      dependsOn: ['gfs-write-probe'],
      maxIterations: 3,
      toolChoice: 'required',
      allowedTools: { include: ['clerum__gfs_read'] },
    }),
  ])
  expect(workflowPodState(GFS_PLUGIN_RECIPE, 'workflow-mcp-host').names).toEqual([])
}

export async function waitForGfsRunScopedRuntime(
  runId: string,
  childName: string,
  expectedInputs: { resourceId: string; updatedContent: string }
): Promise<string> {
  expectParentAndChild(runId, childName, expectedInputs)
  const pod = `${childName}-mcp-host`
  await expect
    .poll(() => workflowPodState(childName, 'workflow-mcp-host'), {
      timeout: 60_000,
      intervals: [1_000, 2_000, 5_000],
      message: `run ${runId} should create exactly one Ready child mcp-host`,
    })
    .toEqual({ names: [pod], ready: true })
  await expect
    .poll(() => workflowPodState(childName, 'workflow-coordinator'), {
      timeout: 90_000,
      intervals: [1_000, 2_000, 5_000],
      message: `run ${runId} should create exactly one Ready child coordinator`,
    })
    .toEqual({ names: [`${childName}-coordinator`], ready: true })
  expect(workflowPodState(GFS_PLUGIN_RECIPE, 'workflow-mcp-host').names).toEqual([])
  return pod
}

export function listGfsWorkflowRuns(): GfsWorkflowRun[] {
  return runControlPostgresSql(`
    SELECT run_id::text || '|' || coalesce(child_recipe_name, '')
      FROM workflow_runs
     WHERE recipe_namespace = ${sqlLiteral(GFS_PLUGIN_NAMESPACE)}
       AND recipe_name = ${sqlLiteral(GFS_PLUGIN_RECIPE)}
     ORDER BY created_at, run_id;
  `)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [runId = '', childName = ''] = splitSqlRow(line)
      return { runId, childName }
    })
    .filter(run => /^[0-9a-f-]{36}$/i.test(run.runId))
}

export function gfsWorkflowRunsAfter(baselineIds: ReadonlySet<string>): GfsWorkflowRun[] {
  return listGfsWorkflowRuns().filter(run => !baselineIds.has(run.runId))
}

export async function expectWorkflowGfsProbeResult(input: {
  childName: string
  fileResourceId: string
  fileUri: string
  initialContent: string
  runId: string
  updatedContent: string
}): Promise<void> {
  const child = kubectlJson<WorkflowRecipeResource>([
    '-n',
    GFS_PLUGIN_NAMESPACE,
    'get',
    'workflowrecipe',
    input.childName,
  ])
  const readStep = child.status?.steps?.find(step => step.id === 'approval-held-gfs-read')
  const statStep = child.status?.steps?.find(step => step.id === 'gfs-stat-probe')
  const writeStep = child.status?.steps?.find(step => step.id === 'gfs-write-probe')
  const readBackStep = child.status?.steps?.find(step => step.id === 'read-back-gfs-probe')
  expect(
    readStep?.toolsCalled,
    'child WorkflowRecipe status must retain the initial read call'
  ).toBeDefined()
  expect(
    statStep?.toolsCalled,
    'child WorkflowRecipe status must retain the stat call'
  ).toBeDefined()
  expect(
    writeStep?.toolsCalled,
    'child WorkflowRecipe status must retain the write call'
  ).toBeDefined()
  expect(
    readBackStep?.toolsCalled,
    'dependent read-back step must retain its real GFS read'
  ).toBeDefined()
  expect(readStep?.phase).toBe('completed')
  expect(statStep?.phase).toBe('completed')
  expect(writeStep?.phase).toBe('completed')
  expect(readBackStep?.phase).toBe('completed')

  const row = firstDataLine(
    runControlPostgresSql(`
      SELECT count(*)
        FROM workflow_run_steps
       WHERE run_id = ${sqlLiteral(input.runId)}::uuid
         AND step_id IN (
           'approval-held-gfs-read',
           'gfs-stat-probe',
           'gfs-write-probe',
           'read-back-gfs-probe'
         )
         AND phase = 'Succeeded';
    `)
  )
  const [succeededStepCount = ''] = splitSqlRow(row)
  expect(succeededStepCount).toBe('4')
  const toolCallFor = (step: typeof readStep) => {
    return singleSuccessfulToolCall(step!.toolsCalled as WorkflowToolCall[])
  }
  const { rejected: rejectedReads, successful: readCall } = toolCallFor(readStep)
  const { rejected: rejectedStats, successful: statCall } = toolCallFor(statStep)
  const { rejected: rejectedWrites, successful: writeCall } = toolCallFor(writeStep)
  expect(rejectedReads).toHaveLength(0)
  expect(rejectedStats).toHaveLength(0)
  expect(`${readCall.serverName}__${readCall.toolName}`).toBe('clerum__gfs_read')
  expect(`${statCall.serverName}__${statCall.toolName}`).toBe('clerum__gfs_stat')
  expect(`${writeCall.serverName}__${writeCall.toolName}`).toBe('clerum__gfs_write')
  for (const tool of [readCall, statCall, writeCall]) {
    expect(tool.args).toMatchObject({ drive: 'main', resourceId: input.fileResourceId })
  }
  expect(readCall.result?.content).toBe(input.initialContent)
  const statEnvelope = JSON.parse(statCall.result!.content!) as {
    ok?: boolean
    data?: { gfsUri?: string; version?: number }
  }
  expect(statEnvelope).toMatchObject({ ok: true, data: { gfsUri: input.fileUri } })
  expect(typeof statEnvelope.data?.version).toBe('number')
  expect(writeCall.args).toMatchObject({
    content: input.updatedContent,
    ifMatch: statEnvelope.data!.version,
  })
  const writeEnvelope = JSON.parse(writeCall.result!.content!) as {
    ok?: boolean
    data?: { version?: number }
  }
  expect(writeEnvelope).toMatchObject({
    ok: true,
    data: { version: statEnvelope.data!.version! + 1 },
  })
  for (const retry of rejectedWrites) {
    expect(`${retry.serverName}__${retry.toolName}`).toBe('clerum__gfs_write')
    expect(retry.args).toEqual(writeCall.args)
    expect(retry.result?.error).toContain('precondition_failed')
  }
  const { rejected: rejectedReadBacks, successful: readBackCall } = toolCallFor(readBackStep)
  expect(rejectedReadBacks).toHaveLength(0)
  expect(`${readBackCall.serverName}__${readBackCall.toolName}`).toBe('clerum__gfs_read')
  expect(readBackCall.args).toMatchObject({ drive: 'main', resourceId: input.fileResourceId })
  expect(readBackCall.result).toMatchObject({ success: true, content: input.updatedContent })
}
