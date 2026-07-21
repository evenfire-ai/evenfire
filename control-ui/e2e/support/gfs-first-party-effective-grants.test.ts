import { type Locator, type Page, expect, test } from '@playwright/test'
import {
  type GfsFileFixture,
  getGfsGrantSummary,
  kubectlOut,
} from '../../../tests/e2e/gfsUiFixtures'

const HOST_NAMESPACE = 'mcp-host'
const STATEFUL_HOST_NAME = 'chatllm'
const STATEFUL_HOST_LABEL = 'chatllm (Stateful)'
const STATELESS_HOST_NAME = 'chatllm-stateless'
const STATELESS_HOST_LABEL = 'chatllm-stateless (Stateless)'
const SUBJECT_PICKER_LABEL = 'Add people, teams, agents, or workflows'
const FIRST_PARTY_HOSTS = {
  stateful: {
    hostName: STATEFUL_HOST_NAME,
    label: STATEFUL_HOST_LABEL,
    subjectId: '1st:mcp-host/chatllm',
  },
  stateless: {
    hostName: STATELESS_HOST_NAME,
    label: STATELESS_HOST_LABEL,
    subjectId: '1st:mcp-host/chatllm-stateless',
  },
} as const

export type FirstPartyHostKey = keyof typeof FIRST_PARTY_HOSTS

type GfsToolName = 'clerum__gfs_read' | 'clerum__gfs_stat' | 'clerum__gfs_write'
type GfsToolOutput = { content: string; is_error: boolean }
type GfsResourceEnvelope = { ok: boolean; data: { version: number } }
type FirstPartyHostRuntime = { hostName: string; podName: string }
type PodList = {
  items: Array<{
    metadata?: { deletionTimestamp?: string; name?: string }
    status?: { conditions?: Array<{ status?: string; type?: string }> }
  }>
}
type JourneyInput = {
  fixture: Pick<GfsFileFixture, 'fileResourceId' | 'name'>
  page: Page
  panel: Locator
  targetHost: FirstPartyHostKey
}

function readyFirstPartyHostPod(hostName: string): string {
  const selector = [
    `app=${hostName}`,
    `clerum.io/host=${hostName}`,
    'clerum.io/managed-by=host-context-controller',
  ].join(',')
  const deadline = Date.now() + 30_000
  do {
    try {
      kubectlOut(
        ['-n', HOST_NAMESPACE, 'wait', '--for=create', 'pod', '-l', selector, '--timeout=5s'],
        7_000
      )
      kubectlOut(
        [
          '-n',
          HOST_NAMESPACE,
          'wait',
          '--for=condition=Ready',
          'pod',
          '-l',
          selector,
          '--timeout=5s',
        ],
        7_000
      )
    } catch {
      // The bounded wait is the poll interval; inspect only converged Ready pods below.
    }
    const pods = JSON.parse(
      kubectlOut(['-n', HOST_NAMESPACE, 'get', 'pod', '-l', selector, '-o', 'json'], 10_000)
    ) as PodList
    const ready = pods.items.filter(
      pod =>
        !pod.metadata?.deletionTimestamp &&
        pod.status?.conditions?.some(
          condition => condition.type === 'Ready' && condition.status === 'True'
        )
    )
    if (ready.length === 1 && ready[0]?.metadata?.name) return ready[0].metadata.name
  } while (Date.now() < deadline)
  throw new Error(
    `first-party Host ${HOST_NAMESPACE}/${hostName} did not converge to one non-terminating Ready pod`
  )
}

function runGfsTool(
  runtime: FirstPartyHostRuntime,
  toolName: GfsToolName,
  args: Record<string, unknown>
): GfsToolOutput {
  const script = `
const { config } = require('./dist/config.js');
const { NativeToolRegistry } = require('./dist/core/tools/nativeToolRegistry.js');
const registry = new NativeToolRegistry(config.nativeTool, 'gfs-first-party-effective-grants-e2e');
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
      HOST_NAMESPACE,
      'exec',
      runtime.podName,
      '-c',
      'mcp-host',
      '--',
      'node',
      '-e',
      script,
      toolName,
      JSON.stringify(args),
    ],
    20_000
  ).trim()
  const result = JSON.parse(output.split('\n').filter(Boolean).at(-1) ?? '') as GfsToolOutput
  if (typeof result.is_error !== 'boolean' || typeof result.content !== 'string') {
    throw new Error(
      `first-party Host ${runtime.hostName} returned an invalid result for ${toolName}`
    )
  }
  return result
}

function parseEnvelope(result: GfsToolOutput): GfsResourceEnvelope {
  expect(result.is_error, result.content).toBe(false)
  const envelope = JSON.parse(result.content) as GfsResourceEnvelope
  expect(envelope).toMatchObject({ ok: true, data: { version: expect.any(Number) } })
  return envelope
}

function expectDenied(result: GfsToolOutput): void {
  expect(result.is_error).toBe(true)
  expect(result.content).toMatch(/gfsc 403/i)
}

function expectReadWriteDenied(
  runtime: FirstPartyHostRuntime,
  resourceId: string,
  content: string,
  ifMatch: number
): void {
  expectDenied(runGfsTool(runtime, 'clerum__gfs_read', { drive: 'main', resourceId }))
  expectDenied(
    runGfsTool(runtime, 'clerum__gfs_write', {
      drive: 'main',
      resourceId,
      content,
      ifMatch,
    })
  )
}

async function chooseHost(panel: Locator, targetHost: FirstPartyHostKey): Promise<void> {
  const host = FIRST_PARTY_HOSTS[targetHost]
  const input = panel.getByRole('combobox', { name: SUBJECT_PICKER_LABEL })
  await expect(input).toBeVisible()
  await input.fill(host.hostName)
  const option = panel.getByRole('option', { name: host.label, exact: true })
  await expect(option).toBeVisible({ timeout: 20_000 })
  await option.click()
  const selected = panel.getByLabel('Grant subject', { exact: true })
  await expect(selected.getByRole('button', { name: `Remove ${host.label}` })).toBeVisible()
  await expect(selected.getByRole('button', { name: /^Remove / })).toHaveCount(1)
}

async function choosePermissions(
  panel: Locator,
  permissionNames: Array<'Read' | 'Write'>
): Promise<void> {
  await panel.getByRole('button', { name: 'Permissions', exact: true }).click()
  const menu = panel.getByRole('menu', { name: 'Permissions' })
  await expect(menu).toBeVisible()
  for (const permissionName of permissionNames) {
    const checkbox = menu.getByRole('menuitemcheckbox', { name: permissionName, exact: true })
    await checkbox.click()
    await expect(checkbox).toHaveAttribute('aria-checked', 'true')
  }
}

async function submitGrant(
  page: Page,
  panel: Locator,
  permissions: Array<'read' | 'write'>,
  resourceId: string,
  targetHost: FirstPartyHostKey
): Promise<void> {
  const target = FIRST_PARTY_HOSTS[targetHost]
  const other = FIRST_PARTY_HOSTS[targetHost === 'stateful' ? 'stateless' : 'stateful']
  const responsePromise = page.waitForResponse(
    response =>
      response.request().method() === 'PUT' &&
      response.url().includes('/control-api/api/v1/gfs/grants')
  )
  await panel.getByRole('button', { name: 'Grant access', exact: true }).click()
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation).toContainText('Grant access?')
  await expect(confirmation).toContainText(/1 subject/i)
  for (const permission of permissions) {
    await expect(confirmation).toContainText(new RegExp(permission, 'i'))
  }
  await confirmation.getByRole('button', { name: 'Grant', exact: true }).click()

  const response = await responsePromise
  expect(response.status(), `${response.url()} ${await response.text()}`).toBe(200)
  const body = response.request().postDataJSON() as {
    resourceId?: string
    subject?: unknown
    subjects?: Array<{ type: string; id: string }>
    permissions?: string[]
  }
  expect(body).toMatchObject({
    resourceId,
    subjects: [{ type: 'host', id: target.subjectId }],
    permissions,
  })
  expect(body.subject).toBeUndefined()
  await expect(page.getByText('Grant saved.').last()).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(
      () =>
        getGfsGrantSummary({
          resourceId,
          subjectType: 'host',
          subjectId: target.subjectId,
        }),
      { timeout: 15_000, intervals: [250, 500, 1_000] }
    )
    .toMatchObject({ permissions, grantedBy: 'operator:' })
  expect(
    getGfsGrantSummary({
      resourceId,
      subjectType: 'host',
      subjectId: other.subjectId,
    })
  ).toBeNull()
}

export async function exerciseGfsFirstPartyEffectiveGrantJourney({
  fixture,
  page,
  panel,
  targetHost,
}: JourneyInput): Promise<void> {
  const resourceId = fixture.fileResourceId
  const initialContent = `E2E GFS file fixture: ${fixture.name}\n`
  const rejectedContent = `first-party rejected update for ${fixture.name}`
  const runtimes =
    await test.step('resolve each concrete first-party Host runtime once', async () => ({
      stateful: {
        hostName: STATEFUL_HOST_NAME,
        podName: readyFirstPartyHostPod(STATEFUL_HOST_NAME),
      },
      stateless: {
        hostName: STATELESS_HOST_NAME,
        podName: readyFirstPartyHostPod(STATELESS_HOST_NAME),
      },
    }))
  const targetRuntime = runtimes[targetHost]
  const otherRuntime = runtimes[targetHost === 'stateful' ? 'stateless' : 'stateful']
  const target = FIRST_PARTY_HOSTS[targetHost]

  await test.step('both concrete first-party Hosts are denied before any grant exists', async () => {
    for (const host of Object.values(FIRST_PARTY_HOSTS)) {
      expect(
        getGfsGrantSummary({ resourceId, subjectType: 'host', subjectId: host.subjectId })
      ).toBeNull()
    }
    expectReadWriteDenied(runtimes.stateful, resourceId, rejectedContent, 1)
    expectReadWriteDenied(runtimes.stateless, resourceId, rejectedContent, 1)
  })

  await test.step(`operator grants read only to ${target.hostName} through the visible Control UI`, async () => {
    await chooseHost(panel, targetHost)
    await choosePermissions(panel, ['Read'])
    await submitGrant(page, panel, ['read'], resourceId, targetHost)
  })

  let currentVersion = 0
  await test.step(`read-only enables ${target.hostName} read but not write and remains isolated`, async () => {
    expect(
      runGfsTool(targetRuntime, 'clerum__gfs_read', { drive: 'main', resourceId })
    ).toMatchObject({ content: initialContent, is_error: false })
    currentVersion = parseEnvelope(
      runGfsTool(targetRuntime, 'clerum__gfs_stat', { drive: 'main', resourceId })
    ).data.version
    expectDenied(
      runGfsTool(targetRuntime, 'clerum__gfs_write', {
        drive: 'main',
        resourceId,
        content: rejectedContent,
        ifMatch: currentVersion,
      })
    )
    expectReadWriteDenied(otherRuntime, resourceId, rejectedContent, currentVersion)
  })

  await test.step(`operator replaces the ${target.hostName} grant with write only through the UI`, async () => {
    await chooseHost(panel, targetHost)
    await choosePermissions(panel, ['Write'])
    await submitGrant(page, panel, ['write'], resourceId, targetHost)
  })

  const writeOnlyContent = `first-party write-only update for ${fixture.name}`
  await test.step(`write-only enables ${target.hostName} write but not read and remains isolated`, async () => {
    expectDenied(runGfsTool(targetRuntime, 'clerum__gfs_read', { drive: 'main', resourceId }))
    const write = parseEnvelope(
      runGfsTool(targetRuntime, 'clerum__gfs_write', {
        drive: 'main',
        resourceId,
        content: writeOnlyContent,
        ifMatch: currentVersion,
      })
    )
    expect(write.data.version).toBe(currentVersion + 1)
    currentVersion = write.data.version
    expectReadWriteDenied(otherRuntime, resourceId, writeOnlyContent, currentVersion)
  })

  await test.step(`operator upgrades the ${target.hostName} grant to read and write through the UI`, async () => {
    await chooseHost(panel, targetHost)
    await choosePermissions(panel, ['Read', 'Write'])
    await submitGrant(page, panel, ['read', 'write'], resourceId, targetHost)
  })

  const readWriteContent = `first-party read-write update for ${fixture.name}`
  await test.step('combined grant preserves read-back, versioned write, and host isolation', async () => {
    expect(
      runGfsTool(targetRuntime, 'clerum__gfs_read', { drive: 'main', resourceId })
    ).toMatchObject({ content: writeOnlyContent, is_error: false })
    const write = parseEnvelope(
      runGfsTool(targetRuntime, 'clerum__gfs_write', {
        drive: 'main',
        resourceId,
        content: readWriteContent,
        ifMatch: currentVersion,
      })
    )
    expect(write.data.version).toBe(currentVersion + 1)
    currentVersion = write.data.version
    expect(
      runGfsTool(targetRuntime, 'clerum__gfs_read', { drive: 'main', resourceId })
    ).toMatchObject({ content: readWriteContent, is_error: false })
    expect(
      parseEnvelope(runGfsTool(targetRuntime, 'clerum__gfs_stat', { drive: 'main', resourceId }))
        .data.version
    ).toBe(currentVersion)
    expectReadWriteDenied(otherRuntime, resourceId, readWriteContent, currentVersion)
  })
}
