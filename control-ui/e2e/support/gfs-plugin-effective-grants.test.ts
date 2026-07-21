import { type Locator, type Page, expect, test } from '@playwright/test'
import { getGfsGrantSummary, kubectlOut } from '../../../tests/e2e/gfsUiFixtures'

const RECIPE_NAMESPACE = 'sandbox-recipes'
const RECIPE_NAME = 'gfs-grant-e2e-plugin'
const RECIPE_SUBJECT_ID = `3rd:${RECIPE_NAMESPACE}/${RECIPE_NAME}`
const SUBJECT_PICKER_LABEL = 'Add people, teams, agents, or workflows'

type GfsToolName = 'clerum__gfs_read' | 'clerum__gfs_stat' | 'clerum__gfs_write'
type GfsToolOutput = { content: string; is_error: boolean }
type GfsResourceEnvelope = { ok: boolean; data: { gfsUri: string; version: number } }
type PluginGrantJourneyInput = {
  fileResourceId: string
  fileUri: string
  initialContent: string
  page: Page
  panel: Locator
  pod: string
  unrelatedPod: string
  updatedContent: string
}

function runGfsTool(
  pod: string,
  toolName: GfsToolName,
  args: Record<string, unknown>
): GfsToolOutput {
  const script = `
const { config } = require('./dist/config.js');
const { NativeToolRegistry } = require('./dist/core/tools/nativeToolRegistry.js');
const registry = new NativeToolRegistry(config.nativeTool, 'gfs-grant-e2e');
const registeredNames = registry.listDefinitions().map(definition => definition.name);
if (!registeredNames.includes('clerum__gfs_read') || !registeredNames.includes('clerum__gfs_write')) {
  throw new Error('NativeToolRegistry did not register the GFS tools');
}
const tool = registry.get(process.argv[1]);
if (!tool) throw new Error('requested GFS tool is unavailable');
tool.execute(JSON.parse(process.argv[2])).then(result => {
  process.stdout.write(JSON.stringify(result));
}).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
`
  const output = kubectlOut(
    [
      '-n',
      RECIPE_NAMESPACE,
      'exec',
      pod,
      '-c',
      'mcp-host',
      '--',
      'node',
      '-e',
      script,
      toolName,
      JSON.stringify(args),
    ],
    30_000
  ).trim()
  const result = JSON.parse(output.split('\n').filter(Boolean).at(-1) ?? '') as GfsToolOutput
  if (typeof result.is_error !== 'boolean' || typeof result.content !== 'string') {
    throw new Error(`run-scoped recipe GFS tool returned an invalid result for ${toolName}`)
  }
  return result
}

function parseResourceEnvelope(result: GfsToolOutput): GfsResourceEnvelope {
  expect(result.is_error, result.content).toBe(false)
  const envelope = JSON.parse(result.content) as GfsResourceEnvelope
  expect(envelope.ok).toBe(true)
  expect(envelope.data.version).toEqual(expect.any(Number))
  return envelope
}

function expectReadWriteDenied(
  pod: string,
  resourceId: string,
  content: string,
  ifMatch: number
): void {
  for (const result of [
    runGfsTool(pod, 'clerum__gfs_read', { drive: 'main', resourceId }),
    runGfsTool(pod, 'clerum__gfs_write', {
      drive: 'main',
      resourceId,
      content,
      ifMatch,
    }),
  ]) {
    expect(result.is_error).toBe(true)
    expect(result.content).toMatch(/gfsc 403/i)
  }
}

async function chooseRecipeSubject(panel: Locator): Promise<void> {
  const input = panel.getByRole('combobox', { name: SUBJECT_PICKER_LABEL })
  await expect(input).toBeVisible()
  await input.fill(RECIPE_NAME)
  const option = panel.getByRole('option', { name: RECIPE_NAME, exact: true })
  await expect(option).toBeVisible({ timeout: 20_000 })
  await option.click()
  await expect(panel.getByRole('button', { name: `Remove ${RECIPE_NAME}` })).toBeVisible()
}

async function choosePermission(panel: Locator, permissionName: 'Read' | 'Write'): Promise<void> {
  const menu = panel.getByRole('menu', { name: 'Permissions' })
  if (!(await menu.isVisible().catch(() => false))) {
    await panel.getByRole('button', { name: 'Permissions', exact: true }).click()
  }
  await menu.getByRole('menuitemcheckbox', { name: permissionName, exact: true }).click()
}

async function submitGrant(
  page: Page,
  panel: Locator,
  permissions: Array<'read' | 'write'>,
  resourceId: string
): Promise<void> {
  const responsePromise = page.waitForResponse(
    response =>
      response.request().method() === 'PUT' &&
      response.url().includes('/control-api/api/v1/gfs/grants')
  )
  await panel.getByRole('button', { name: 'Grant access', exact: true }).click()
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation).toContainText('Grant access?')
  await expect(confirmation).toContainText('Grant 1 subjects (1 host)')
  await expect(confirmation).toContainText(`[${permissions.join(', ')}]`)
  await expect(confirmation).toContainText('Scope: resource only')
  await confirmation.getByRole('button', { name: 'Grant', exact: true }).click()
  const response = await responsePromise
  expect(response.status(), `${response.url()} ${await response.text()}`).toBe(200)
  const body = response.request().postDataJSON() as {
    resourceId?: string
    subject?: unknown
    subjects?: Array<{ type: string; id: string }>
    permissions?: string[]
  }
  expect(body.resourceId).toBe(resourceId)
  expect(body.subject).toBeUndefined()
  expect(body.subjects).toEqual([{ type: 'host', id: RECIPE_SUBJECT_ID }])
  expect(body.permissions).toEqual(permissions)
  await expect(page.getByText('Grant saved.').last()).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(
      () =>
        getGfsGrantSummary({
          resourceId,
          subjectType: 'host',
          subjectId: RECIPE_SUBJECT_ID,
        }),
      { timeout: 15_000, intervals: [250, 500, 1_000] }
    )
    .toMatchObject({ permissions, grantedBy: 'operator:' })
}

export async function exerciseGfsPluginEffectiveGrantJourney({
  fileResourceId,
  fileUri,
  initialContent,
  page,
  panel,
  pod,
  unrelatedPod,
  updatedContent,
}: PluginGrantJourneyInput): Promise<void> {
  await test.step('run-scoped tools are denied before any resource grant exists', async () => {
    expectReadWriteDenied(pod, fileResourceId, updatedContent, 1)
    expectReadWriteDenied(unrelatedPod, fileResourceId, updatedContent, 1)
  })

  await test.step('operator grants read only to the exact parent recipe through the UI', async () => {
    await chooseRecipeSubject(panel)
    await choosePermission(panel, 'Read')
    await submitGrant(page, panel, ['read'], fileResourceId)
  })

  let currentVersion = 0
  await test.step('read grant survives into the child runtime while write remains denied', async () => {
    const read = runGfsTool(pod, 'clerum__gfs_read', {
      drive: 'main',
      resourceId: fileResourceId,
    })
    expect(read).toMatchObject({ is_error: false, content: initialContent })
    const stat = parseResourceEnvelope(
      runGfsTool(pod, 'clerum__gfs_stat', { drive: 'main', resourceId: fileResourceId })
    )
    expect(stat.data.gfsUri).toBe(fileUri)
    currentVersion = stat.data.version
    const write = runGfsTool(pod, 'clerum__gfs_write', {
      drive: 'main',
      resourceId: fileResourceId,
      content: updatedContent,
      ifMatch: currentVersion,
    })
    expect(write.is_error).toBe(true)
    expect(write.content).toMatch(/gfsc 403/i)
    expectReadWriteDenied(unrelatedPod, fileResourceId, updatedContent, currentVersion)
  })

  await test.step('operator replaces the grant with write only through the UI', async () => {
    await chooseRecipeSubject(panel)
    await choosePermission(panel, 'Write')
    await submitGrant(page, panel, ['write'], fileResourceId)
  })

  const writeOnlyContent = `${updatedContent} (write-only)`
  await test.step('write grant survives into the child runtime while read remains denied', async () => {
    const read = runGfsTool(pod, 'clerum__gfs_read', {
      drive: 'main',
      resourceId: fileResourceId,
    })
    expect(read.is_error).toBe(true)
    expect(read.content).toMatch(/gfsc 403/i)
    const write = parseResourceEnvelope(
      runGfsTool(pod, 'clerum__gfs_write', {
        drive: 'main',
        resourceId: fileResourceId,
        content: writeOnlyContent,
        ifMatch: currentVersion,
      })
    )
    expect(write.data.gfsUri).toBe(fileUri)
    expect(write.data.version).toBe(currentVersion + 1)
    currentVersion = write.data.version
    expectReadWriteDenied(unrelatedPod, fileResourceId, writeOnlyContent, currentVersion)
  })

  await test.step('operator upgrades the same parent recipe to read and write through the UI', async () => {
    await chooseRecipeSubject(panel)
    await choosePermission(panel, 'Read')
    await choosePermission(panel, 'Write')
    await submitGrant(page, panel, ['read', 'write'], fileResourceId)
  })

  await test.step('combined grant preserves both operations and the version contract', async () => {
    const beforeWrite = runGfsTool(pod, 'clerum__gfs_read', {
      drive: 'main',
      resourceId: fileResourceId,
    })
    expect(beforeWrite).toMatchObject({ is_error: false, content: writeOnlyContent })
    const write = parseResourceEnvelope(
      runGfsTool(pod, 'clerum__gfs_write', {
        drive: 'main',
        resourceId: fileResourceId,
        content: updatedContent,
        ifMatch: currentVersion,
      })
    )
    expect(write.data.gfsUri).toBe(fileUri)
    expect(write.data.version).toBe(currentVersion + 1)
    const readBack = runGfsTool(pod, 'clerum__gfs_read', {
      drive: 'main',
      resourceId: fileResourceId,
    })
    expect(readBack).toMatchObject({ is_error: false, content: updatedContent })
    const stat = parseResourceEnvelope(
      runGfsTool(pod, 'clerum__gfs_stat', { drive: 'main', resourceId: fileResourceId })
    )
    expect(stat.data.version).toBe(currentVersion + 1)
    expectReadWriteDenied(unrelatedPod, fileResourceId, updatedContent, currentVersion + 1)
  })
}
