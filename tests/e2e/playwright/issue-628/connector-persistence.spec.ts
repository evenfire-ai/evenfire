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
const profileRestart = process.env.ISSUE628_PROFILE_RESTART === 'true'

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
  'T2_GATE_ID',
  'T2_SKIP_LOCK',
  'T2_MUTATION_LOCK_WRAPPED',
  'E2E_DISABLE_CANONICAL_DOTENV',
]) {
  if (process.env[key] !== undefined) clusterEnv[key] = process.env[key]
}
clusterEnv.ALLOWED_CONTEXTS = profile

async function run(
  command: string,
  args: string[],
  timeout = 60_000,
  operation = path.basename(command)
): Promise<string> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: root,
      env: clusterEnv,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    })
    return result.stdout
  } catch (error) {
    const result = error as {
      code?: string | number
      signal?: string
      stdout?: string
      stderr?: string
    }
    const code = result.code ?? result.signal ?? 'unknown'
    const phases = (result.stdout ?? '')
      .split('\n')
      .filter(line => /^(NODE_IP_(BEFORE|AFTER)=[0-9a-fA-F.:]+|RESTART_PHASE=[a-z-]+)$/.test(line))
    const reason = (result.stderr ?? '').match(/ISSUE628_RESTART_[A-Z_]+/)?.[0]
    throw new Error(
      ['Profile command ' + operation + ' failed: ' + String(code), reason, ...phases]
        .filter(Boolean)
        .join(' ')
    )
  }
}

async function onProfile(command: string, args: string[], timeout = 90_000): Promise<string> {
  return run(
    'bash',
    ['scripts/minikube/with-t2-mutation-lock.sh', '--', command, ...args],
    timeout,
    path.basename(command)
  )
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
    process.env.E2E_DISABLE_CANONICAL_DOTENV !== 'true' ||
    (profileRestart && process.env.T2_GATE_ID !== 'issue628-profile-restart') ||
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
type RestartIdentity = {
  nodes: { name: string; uid: string }[]
  namespaceUid: string
  connectorUid: string
  connectorSpec: unknown
  marker: Record<string, string>
  ports: string[]
}

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

async function restartIdentity(): Promise<RestartIdentity> {
  const nodes = JSON.parse(await kube(['get', 'nodes', '-o', 'json']))
  const namespace = JSON.parse(await kube(['get', 'namespace', 'kube-system', '-o', 'json']))
  const server = JSON.parse(
    await kube(['-n', 'mcp-server', 'get', 'mcpservers.clerum.io', connector, '-o', 'json'])
  )
  const marker = JSON.parse(
    await kube([
      '-n',
      'control-plane',
      'get',
      'configmap',
      process.env.T2_MARKER_NAME || 'clerum-pre-gate-sync-state',
      '-o',
      'json',
    ])
  )
  const summary = await run('/usr/bin/make', [
    '-f',
    'scripts/minikube-profiles/branch.mk',
    'branch-profile-info',
  ])
  const identity: RestartIdentity = {
    nodes: nodes.items
      .filter(
        (node: { metadata: { labels?: Record<string, string> } }) =>
          node.metadata.labels?.['minikube.k8s.io/name'] === profile
      )
      .map((node: { metadata: { name: string; uid: string } }) => ({
        name: node.metadata.name,
        uid: node.metadata.uid,
      }))
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
    namespaceUid: namespace.metadata.uid,
    connectorUid: server.metadata.uid,
    connectorSpec: server.spec,
    marker: Object.fromEntries(
      ['worktreeId', 'gitHead', 'clusterFingerprint', 'imagesGeneratedAt'].map(key => [
        key,
        marker.data?.[key] ?? '',
      ])
    ),
    ports: summary
      .split('\n')
      .filter(line => /^  [a-z-]+:\s+\d+\s*$/.test(line))
      .sort(),
  }
  if (
    !identity.nodes.length ||
    identity.nodes.some(node => !node.name || !node.uid) ||
    !identity.namespaceUid ||
    !identity.connectorUid ||
    !identity.connectorSpec ||
    Object.values(identity.marker).some(value => !value) ||
    !identity.ports.some(line => /^  control-ui:/.test(line))
  ) {
    throw new Error('Profile restart identity is incomplete')
  }
  const head = (await run('git', ['rev-parse', 'HEAD'])).trim()
  if (identity.marker.gitHead !== head) throw new Error('Profile marker does not match HEAD')
  return identity
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
  let lastFailure = ''
  try {
    await expect
      .poll(
        async () => {
          try {
            return await invokeConnector()
          } catch (error) {
            lastFailure =
              error instanceof Error && error.message.startsWith('Profile command ')
                ? error.message
                : 'connector probe unavailable'
            return ''
          }
        },
        { timeout: 180_000, intervals: [2_000, 5_000] }
      )
      .toBe('42')
  } catch {
    throw new Error('Connector probe did not return 42' + (lastFailure ? ': ' + lastFailure : ''))
  }
}

async function provisionInstances(): Promise<void> {
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
    1_230_000,
    'provision-instances'
  )
}

async function refreshProfileForwards(): Promise<void> {
  await onProfile(
    '/usr/bin/make',
    ['-f', 'scripts/minikube-profiles/branch.mk', 'branch-profile-pf'],
    180_000
  )
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
  const addDialog = page.getByRole('dialog', { name: 'Add connectors' })
  if (await addDialog.isVisible()) {
    await addDialog.getByRole('button', { name: 'Close dialog' }).click()
  }
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

test.beforeAll(async () => {
  await verifyTarget()
})

test('unauthenticated access does not expose the agent connector inventory', async ({ page }) => {
  // E2E_GUARDIAN_NAVIGATION: negative-route-guard — verify the protected agent route without a session.
  await page.goto('/agents/chatllm/connectors')
  await expect(page.getByLabel('Username or email')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(page.getByLabel('Main navigation')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Add connector', exact: true })).toHaveCount(0)
  await expect(page.getByRole('columnheader', { name: 'Connector', exact: true })).toHaveCount(0)
  // This negative case probes the protected API without a session; it does not
  // create or modify the state exercised by the visible journey below.
  const response = await page.request.get('/control-api/api/v1/admin/contexts/context1', {
    maxRedirects: 0,
  })
  expect(response.status()).toBe(401)
})

const persistenceTestName = profileRestart
  ? 'Control UI connector survives a full Minikube profile restart'
  : 'Control UI connector survives provisioning and runtime restarts'

test(persistenceTestName, async ({ page, browser }) => {
  test.setTimeout(3_600_000)
  const original = await snapshot()
  expect(original.uid).toBeTruthy()
  expect(original.servers).not.toContain(connector)
  let created = false
  let creationAttempted = false
  let profileMayBeUnavailable = false
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
    const connectorOption = dialog.getByRole('checkbox', { name: connector, exact: true })
    await expect(connectorOption).toBeVisible()
    await connectorOption.check()
    const saved = page.waitForResponse(response =>
      matchesControlResponse(response, 'PUT', '/api/v1/admin/contexts/context1')
    )
    await dialog.getByRole('button', { name: 'Add connector', exact: true }).click()
    expect((await saved).ok()).toBe(true)
    await expect(page.getByRole('row', { name: new RegExp(connector) })).toBeVisible()

    const assertContext = async () => {
      const current = await snapshot()
      expect(current.uid).toBe(original.uid)
      expect([...current.servers].sort()).toEqual([...original.servers, connector].sort())
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
      await provisionInstances()
      await assertContext()
      expect(await policies()).toEqual(baselinePolicies)
      await waitForBusinessResult()
    }

    // Exercise the supported full deployment path as well as the GFS helper.
    // The inherited profile lease and filtered GFS mode keep this scoped to
    // the isolated profile while the connector remains configured in the UI.
    await run(
      'node',
      [
        'scripts/minikube/run-with-deadline.mjs',
        '--timeout-seconds',
        '1200',
        '--label',
        'issue628-deploy-all',
        '--',
        'bash',
        'scripts/minikube/with-t2-mutation-lock.sh',
        '--',
        '/usr/bin/make',
        'minikube-deploy-all',
        'MINIKUBE_PROFILE=' + profile,
        'MINIKUBE_REAPPLY_INSTANCES=true',
        'MINIKUBE_GFS_MUTATION=false',
      ],
      1_230_000,
      'deploy-all'
    )
    await assertContext()
    expect(await policies()).toEqual(baselinePolicies)
    await waitForBusinessResult()

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
    // Port-forwards select a Pod and do not follow it through a rollout.
    await refreshProfileForwards()

    if (profileRestart) {
      const beforeRestart = await restartIdentity()
      profileMayBeUnavailable = true
      const restartLog = await run(
        'node',
        [
          'scripts/minikube/run-with-deadline.mjs',
          '--timeout-seconds',
          '1500',
          '--label',
          'issue628-profile-restart',
          '--',
          'bash',
          'scripts/e2e/issue-628-profile-restart.sh',
        ],
        1_530_000,
        'profile-restart'
      )
      test.info().annotations.push({
        type: 'profile restart',
        description: restartLog
          .split('\n')
          .filter(line => /^(NODE_IP_|RESTART_PHASE=)/.test(line))
          .join('; '),
      })
      // The bounded restart runner reaps its child process group on exit, so
      // forwards must be started by this longer-lived Playwright process.
      await refreshProfileForwards()
      await onProfile(
        '/usr/bin/make',
        ['-f', 'scripts/minikube-profiles/branch.mk', 'branch-profile-health'],
        180_000
      )
      profileMayBeUnavailable = false
      await kube(
        ['wait', '--for=condition=Ready', 'nodes', '--all', '--timeout=300s'],
        360_000,
        '330s'
      )
      expect(await restartIdentity()).toEqual(beforeRestart)
      await assertContext()
      expect(await policies()).toEqual(baselinePolicies)
      await waitForBusinessResult()
    }

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

      await freshPage.getByRole('button', { name: 'Actions for connector ' + connector }).click()
      await freshPage.getByRole('menuitem', { name: 'Remove connector', exact: true }).click()
      const confirm = freshPage.getByRole('alertdialog', {
        name: 'Remove connector from this agent?',
      })
      await expect(confirm).toBeVisible()
      const removed = freshPage.waitForResponse(response =>
        matchesControlResponse(response, 'PUT', '/api/v1/admin/contexts/context1')
      )
      await confirm.getByRole('button', { name: 'Remove connector', exact: true }).click()
      expect((await removed).ok()).toBe(true)
      await expect(freshPage.getByRole('row', { name: new RegExp(connector) })).toHaveCount(0)

      const afterRemoval = await snapshot()
      expect(afterRemoval.uid).toBe(original.uid)
      expect([...afterRemoval.servers].sort()).toEqual([...original.servers].sort())
      await provisionInstances()
      const afterRemovalDeploy = await snapshot()
      expect(afterRemovalDeploy.uid).toBe(original.uid)
      expect([...afterRemovalDeploy.servers].sort()).toEqual([...original.servers].sort())
      await expect
        .poll(
          async () => {
            try {
              return (await policies()).some(policy => policy.name === 'ctx-context1-' + connector)
            } catch {
              return true
            }
          },
          { timeout: 180_000, intervals: [2_000, 5_000] }
        )
        .toBe(false)
      await refreshProfileForwards()

      const afterRemovalBrowser = await browser.newContext({ baseURL: uiUrl })
      try {
        const afterRemovalPage = await afterRemovalBrowser.newPage()
        await afterRemovalPage.goto('/')
        await loginControlUiVisible(afterRemovalPage)
        await dismissReminder(afterRemovalPage)
        await openAgentConnectors(afterRemovalPage)
        if (original.servers.length === 0) {
          await expect(afterRemovalPage.getByText('No connectors attached yet.')).toBeVisible()
        } else {
          for (const server of original.servers) {
            await expect(
              afterRemovalPage
                .getByRole('row')
                .filter({ has: afterRemovalPage.getByText(server, { exact: true }) })
            ).toBeVisible()
          }
        }
        await expect(
          afterRemovalPage.getByRole('row', { name: new RegExp(connector) })
        ).toHaveCount(0)
      } finally {
        await afterRemovalBrowser.close()
      }
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
    if (created && profileMayBeUnavailable) {
      test.info().annotations.push({
        type: 'fixture cleanup deferred',
        description: 'The isolated profile may be unavailable; inspect connector ' + connector,
      })
      if (!failure) failure = new Error('Profile availability is unknown after restart')
    } else if (created) {
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
        expect([...final.servers].sort()).toEqual([...original.servers].sort())
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
