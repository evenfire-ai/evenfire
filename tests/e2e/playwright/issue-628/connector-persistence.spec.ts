import { type Page, type Response, expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { loginControlUiVisible } from '../helpers/visible-login'

const execFileAsync = promisify(execFile)
const root = realpathSync(path.resolve(__dirname, '../../../..'))
const profile = process.env.MINIKUBE_PROFILE ?? ''
const uiUrl = process.env.E2E_CONTROL_UI_URL ?? ''
const connector = 'issue628-' + randomBytes(6).toString('hex')

// The browser credential is not passed to the profile commands. The lease
// fields are required by the existing mutation wrapper and are never logged.
const clusterEnv: NodeJS.ProcessEnv = {}
for (const key of [
  'HOME',
  'PATH',
  'KUBECONFIG',
  'MINIKUBE_PROFILE',
  'CONTROL_API_REAL_PG_CONTEXT',
  'T2_PROFILE',
  'T2_CONTEXT',
  'T2_PROJECT_DIR',
  'T2_PINNED_ORIGIN_DEV',
  'T2_PROFILE_ROOT',
  'T2_PROFILE_ENV',
  'T2_PORTS_ENV',
  'T2_LOCK_ROOT',
  'T2_LOCK_TOKEN',
  'T2_SKIP_LOCK',
  'T2_MUTATION_LOCK_WRAPPED',
]) {
  if (process.env[key] !== undefined) clusterEnv[key] = process.env[key]
}
clusterEnv.ALLOWED_CONTEXTS = profile

async function run(command: string, args: string[], timeout = 60_000): Promise<string> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: root,
      env: clusterEnv,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    })
    return result.stdout
  } catch (error) {
    const code =
      (error as { code?: string | number; signal?: string }).code ??
      (error as { signal?: string }).signal ??
      'unknown'
    throw new Error('Profile command failed: ' + String(code))
  }
}

async function onProfile(command: string, args: string[], timeout = 90_000): Promise<string> {
  return run('bash', ['scripts/minikube/with-t2-mutation-lock.sh', '--', command, ...args], timeout)
}

async function kube(args: string[], timeout = 90_000, requestTimeout = '30s'): Promise<string> {
  return onProfile(
    'kubectl',
    ['--context', profile, '--request-timeout=' + requestTimeout, ...args],
    timeout
  )
}

async function verifyTarget(): Promise<void> {
  if (
    !/^clerum-[a-z0-9][a-z0-9._-]*-[0-9a-f]{7,8}$/.test(profile) ||
    process.env.CONTROL_API_REAL_PG_CONTEXT !== profile ||
    process.env.T2_PROFILE !== profile ||
    process.env.T2_CONTEXT !== profile ||
    process.env.T2_MUTATION_LOCK_WRAPPED !== 'true' ||
    process.env.T2_SKIP_LOCK !== 'true' ||
    !process.env.TEST_ADMIN_USERNAME ||
    !process.env.TEST_ADMIN_PASSWORD ||
    !process.env.T2_PROJECT_DIR ||
    realpathSync(process.env.T2_PROJECT_DIR) !== root
  ) {
    throw new Error(
      'The branch-owned profile, its active lease and local test credentials are required'
    )
  }
  const summary = await run('/usr/bin/make', [
    '-f',
    'scripts/minikube-profiles/branch.mk',
    'branch-profile-info',
  ])
  const port = summary.match(/^\s+control-ui:\s+(\d+)\s*$/m)?.[1]
  const target = new URL(uiUrl)
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    target.port !== port ||
    target.pathname !== '/' ||
    target.search ||
    target.hash
  ) {
    throw new Error('Control UI must use the profile-owned loopback port')
  }
  // Revalidate the actual inherited lease and profile identity before the UI
  // is allowed to create its fixture; environment variables alone are not proof.
  await onProfile('/usr/bin/true', [])
  await onProfile(
    '/usr/bin/make',
    ['-f', 'scripts/minikube-profiles/branch.mk', 'branch-profile-health'],
    180_000
  )
}

type Snapshot = { uid: string; servers: string[] }
type Policy = { namespace: string; name: string; uid: string; spec: unknown }

async function snapshot(): Promise<Snapshot> {
  const context = JSON.parse(
    await kube(['-n', 'mcp-server', 'get', 'contexts.clerum.io', 'context1', '-o', 'json'])
  )
  return { uid: context.metadata.uid, servers: context.spec.mcpServers ?? [] }
}

async function policies(): Promise<Policy[]> {
  const result = JSON.parse(
    await kube([
      'get',
      'networkpolicies',
      '-A',
      '-l',
      'clerum.io/mcpserver=' + connector + ',clerum.io/managed-by=host-context-controller',
      '-o',
      'json',
    ])
  )
  return result.items
    .map((item: { metadata: { namespace: string; name: string; uid: string }; spec: unknown }) => ({
      namespace: item.metadata.namespace,
      name: item.metadata.name,
      uid: item.metadata.uid,
      spec: item.spec,
    }))
    .sort((a: Policy, b: Policy) =>
      (a.namespace + '/' + a.name).localeCompare(b.namespace + '/' + b.name)
    )
}

const probe = [
  'const [name] = process.argv.slice(1)',
  "const url = 'http://' + name + '.mcp-server.svc.cluster.local:3000/mcp'",
  'let session',
  'async function rpc(id, method, params) {',
  "  const headers = {'content-type':'application/json', accept:'application/json, text/event-stream'}",
  "  if (session) headers['mcp-session-id'] = session",
  "  const response = await fetch(url, {method:'POST', headers,",
  "    body:JSON.stringify({jsonrpc:'2.0', ...(id === undefined ? {} : {id}), method, params}),",
  '    signal:AbortSignal.timeout(8000)})',
  "  if (!response.ok) throw new Error('MCP request failed')",
  "  session = response.headers.get('mcp-session-id') ?? session",
  '  const body = await response.text()',
  '  if (id === undefined) return',
  "  const messages = response.headers.get('content-type')?.includes('text/event-stream')",
  "    ? body.split('\\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))",
  '    : [JSON.parse(body)]',
  '  const message = messages.find(item => item.id === id)',
  "  if (!message || message.error) throw new Error('MCP response missing or rejected')",
  '  return message.result',
  '}',
  "await rpc(1, 'initialize', {protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{name:'issue628-e2e',version:'1'}})",
  "await rpc(undefined, 'notifications/initialized', {})",
  "const result = await rpc(2, 'tools/call', {name:'add', arguments:{a:17,b:25}})",
  "if (result.isError || !result.content?.some(item => item.type === 'text' && item.text === '42')) throw new Error('MCP result mismatch')",
  "console.log('42')",
].join('\n')

async function invokeConnector(): Promise<string> {
  const pods = JSON.parse(
    await kube(['-n', 'mcp-host', 'get', 'pods', '-l', 'clerum.io/context=context1', '-o', 'json'])
  )
  const pod = pods.items.find(
    (item: {
      metadata: { deletionTimestamp?: string }
      status: { conditions?: Array<{ type: string; status: string }> }
    }) =>
      !item.metadata.deletionTimestamp &&
      item.status.conditions?.some(
        condition => condition.type === 'Ready' && condition.status === 'True'
      )
  )
  if (!pod) throw new Error('No ready Host pod for context1')
  return (
    await kube([
      '-n',
      'mcp-host',
      'exec',
      pod.metadata.name,
      '--',
      'node',
      '--input-type=module',
      '-e',
      probe,
      connector,
    ])
  ).trim()
}

async function waitForBusinessResult(): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return await invokeConnector()
        } catch {
          return ''
        }
      },
      { timeout: 180_000, intervals: [2_000, 5_000] }
    )
    .toBe('42')
}

async function dismissReminder(page: Page): Promise<void> {
  const reminder = page.getByRole('button', { name: 'Remind me later' })
  if (await reminder.isVisible().catch(() => false)) await reminder.click()
}

async function openAgentConnectors(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Agents', exact: true }).click()
  const agent = page.getByRole('row', { name: 'Open agent chatllm', exact: true })
  await expect(agent).toBeVisible({ timeout: 30_000 })
  await agent.click()
  await expect(page.getByRole('tablist', { name: 'Agent sections' })).toBeVisible()
  await page.getByRole('tab', { name: 'Connectors', exact: true }).click()
  await expect(page).toHaveURL(/\/agents\/chatllm\/connectors\/?$/)
}

function matchesControlResponse(response: Response, method: string, path: string): boolean {
  const url = new URL(response.url())
  return (
    url.origin === new URL(uiUrl).origin &&
    url.pathname.endsWith(path) &&
    response.request().method() === method
  )
}

async function deleteFixture(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Installed Connectors', exact: true }).click()
  await page.getByLabel('Search connectors', { exact: true }).fill(connector)
  const row = page.getByRole('row', { name: new RegExp(connector) })
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.getByRole('button', { name: 'Actions for connector ' + connector }).click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete Connector' })
  await expect(dialog).toBeVisible()
  const deleted = page.waitForResponse(response =>
    matchesControlResponse(response, 'DELETE', '/api/v1/admin/mcp-servers/' + connector)
  )
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  expect((await deleted).ok()).toBe(true)
  await expect(row).toHaveCount(0)
}

test('unauthenticated access does not expose the agent connector inventory', async ({ page }) => {
  await verifyTarget()
  // E2E_GUARDIAN_NAVIGATION: negative-route-guard — verify the protected agent route without a session.
  await page.goto('/agents/chatllm/connectors')
  await expect(page.getByLabel('Username or email')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(page.getByLabel('Main navigation')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Add connector', exact: true })).toHaveCount(0)
  await expect(page.getByRole('columnheader', { name: 'Connector', exact: true })).toHaveCount(0)
})

test('Control UI connector survives provisioning and runtime restarts', async ({
  page,
  browser,
}) => {
  test.setTimeout(3_600_000)
  await verifyTarget()
  const original = await snapshot()
  expect(original.uid).toBeTruthy()
  expect(original.servers).not.toContain(connector)
  let created = false
  let creationAttempted = false
  let failure: unknown
  try {
    await page.goto('/')
    await loginControlUiVisible(page)
    await dismissReminder(page)
    await page.getByRole('link', { name: 'Installed Connectors', exact: true }).click()
    await expect(page).toHaveURL(/\/connectors\/?$/)
    await page.getByRole('button', { name: 'Connector actions' }).click()
    await page.getByRole('menuitem', { name: 'Create connector', exact: true }).click()
    await expect(page.getByPlaceholder('my-mcp-server')).toBeVisible()
    await page.getByPlaceholder('my-mcp-server').fill(connector)
    await page
      .getByPlaceholder('us-central1-docker.pkg.dev/my-project/repo/mcp-server:latest')
      .fill('clerum/mock-mcp-server:test')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Secrets and environment' })).toBeVisible()
    await page.getByRole('radio', { name: /No credentials required/ }).check()
    const createdResponse = page.waitForResponse(response =>
      matchesControlResponse(response, 'POST', '/api/v1/admin/mcp-servers')
    )
    creationAttempted = true
    await page.getByRole('button', { name: 'Create connector', exact: true }).click()
    expect((await createdResponse).ok()).toBe(true)
    created = true
    await expect(page).toHaveURL(/\/connectors\/?$/)

    await openAgentConnectors(page)
    await page.getByRole('button', { name: 'Add connector', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add connectors' })
    await expect(dialog.getByRole('option', { name: connector, exact: true })).toBeVisible()
    await dialog.getByRole('option', { name: connector, exact: true }).click()
    const saved = page.waitForResponse(response =>
      matchesControlResponse(response, 'PUT', '/api/v1/admin/contexts/context1')
    )
    await dialog.getByRole('button', { name: 'Add connector', exact: true }).click()
    expect((await saved).ok()).toBe(true)
    await expect(page.getByRole('row', { name: new RegExp(connector) })).toBeVisible()

    const assertContext = async () => {
      const current = await snapshot()
      expect(current.uid).toBe(original.uid)
      expect(current.servers).toEqual(expect.arrayContaining([...original.servers, connector]))
    }
    await assertContext()
    await expect
      .poll(
        async () => {
          try {
            const current = await policies()
            return (
              current.length >= 3 &&
              current.some(policy => policy.name === 'ctx-context1-' + connector)
            )
          } catch {
            return false
          }
        },
        { timeout: 180_000, intervals: [2_000, 5_000] }
      )
      .toBe(true)
    const baselinePolicies = await policies()
    expect(baselinePolicies.length).toBeGreaterThanOrEqual(3)
    await waitForBusinessResult()

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await run(
        'node',
        [
          'scripts/minikube/run-with-deadline.mjs',
          '--timeout-seconds',
          '1200',
          '--label',
          'issue628-provision',
          '--',
          'bash',
          'scripts/minikube/with-t2-mutation-lock.sh',
          '--',
          'bash',
          'deploy/scripts/provision-gfs-runtime.sh',
          '--context',
          profile,
          '--overlay',
          'deploy/overlays/minikube',
        ],
        1_230_000
      )
      await assertContext()
      expect(await policies()).toEqual(baselinePolicies)
      await waitForBusinessResult()
    }

    for (const [namespace, deployment] of [
      ['control-plane', 'host-context-controller'],
      ['mcp-host', 'chatllm'],
    ]) {
      await kube(['-n', namespace, 'rollout', 'restart', 'deployment/' + deployment])
      await kube(
        ['-n', namespace, 'rollout', 'status', 'deployment/' + deployment, '--timeout=300s'],
        360_000,
        '330s'
      )
    }
    await assertContext()
    expect(await policies()).toEqual(baselinePolicies)
    await waitForBusinessResult()

    await onProfile(
      '/usr/bin/make',
      ['-f', 'scripts/minikube-profiles/branch.mk', 'branch-profile-health'],
      180_000
    )
    const fresh = await browser.newContext({ baseURL: uiUrl })
    try {
      const freshPage = await fresh.newPage()
      await freshPage.goto('/')
      await loginControlUiVisible(freshPage)
      await dismissReminder(freshPage)
      await openAgentConnectors(freshPage)
      await expect(freshPage.getByRole('row', { name: new RegExp(connector) })).toBeVisible()
    } finally {
      await fresh.close()
    }
  } catch (error) {
    failure = error
  } finally {
    if (creationAttempted && !created) {
      test.info().annotations.push({
        type: 'fixture state unknown',
        description: 'Connector ' + connector + ' may need removal from the isolated profile',
      })
    }
    if (created) {
      try {
        await deleteFixture(page)
        await expect
          .poll(
            async () => {
              try {
                const server = await kube([
                  '-n',
                  'mcp-server',
                  'get',
                  'mcpservers.clerum.io',
                  connector,
                  '--ignore-not-found',
                  '-o',
                  'name',
                ])
                const resources = await kube([
                  'get',
                  'deployments,services,pods,replicasets,networkpolicies',
                  '-A',
                  '-l',
                  'clerum.io/mcpserver=' + connector,
                  '-o',
                  'name',
                ])
                const current = await snapshot()
                return !server.trim() && !resources.trim() && !current.servers.includes(connector)
              } catch {
                return false
              }
            },
            { timeout: 180_000, intervals: [2_000, 5_000] }
          )
          .toBe(true)
        const final = await snapshot()
        expect(final.uid).toBe(original.uid)
        expect(final.servers).toEqual(expect.arrayContaining(original.servers))
        expect(final.servers).not.toContain(connector)
      } catch (error) {
        test.info().annotations.push({
          type: 'fixture cleanup failed',
          description: 'Connector ' + connector + ' may need removal from the isolated profile',
        })
        if (!failure) failure = error
      }
    }
  }
  if (failure) throw failure
})
