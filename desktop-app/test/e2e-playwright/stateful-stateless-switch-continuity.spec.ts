/**
 * #825 Desktop journey: one conversation survives stateful -> stateless ->
 * stateful switches of its Host. Every Host keeps its database on the PVC
 * root, so a lifecycle switch replaces the Pod and leaves the history where
 * the next Pod reads it.
 *
 * The spec creates its own Host (a copy of the seeded source Host's spec)
 * through the Control API admin API, grants it to the Desktop user, switches
 * its lifecycle only through that API, and deletes it with its PVC at the end.
 * It sends three real model turns.
 *
 * Environment (this header is the reference):
 * - `E2E_825_DESKTOP_CONTINUITY=1` opts in. Without exactly `1` the file is
 *   skipped, so the default lane never mutates a cluster.
 * - `E2E_K8S_CONTEXT` (or `KUBECONTEXT`) names the branch-owned Minikube
 *   profile; the spec refuses any context whose name is not branch-scoped
 *   (`clerum-<branch>-<8 hex>`) or that is not a Minikube node of that name.
 * - `CONTROL_API_BASE_URL` (or `E2E_CONTROL_API_URL`) and the admin password
 *   (`E2E_ADMIN_PASSWORD` / `ADMIN_PASSWORD` / `ADMIN_PASS` /
 *   `TEST_ADMIN_PASSWORD`) are required; `TEST_ADMIN_USERNAME` defaults to
 *   `admin`.
 * - `EXTERNAL_REST_API_BASE_URL` and `RPC_PROXY_BASE_URL` (aliases and
 *   defaults in `qa-recorder-helpers.ts`) are the Desktop targets. All three
 *   URLs must be loopback and healthy; `assertAllowedTarget` waives both
 *   checks only under `QA_RECORDER_ALLOW_REMOTE=1`, which this lane does not
 *   set.
 * - `E2E_DEV_LOGIN_EMAIL` is required and names the Desktop user
 *   (admin@evenfire.local on a T2 profile). The Desktop password is read by
 *   `desktopCredentials()`: `E2E_DESKTOP_PASSWORD` / `E2E_TEST_PASSWORD` /
 *   `ADMIN_PASSWORD`.
 * - `E2E_825_SOURCE_HOST` (default `chatllm`) is the Host whose spec is copied.
 *
 * Run: `make test-e2e-825-desktop-continuity`.
 */
import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import nodePath from 'node:path'
import { promisify } from 'node:util'
import { assertBranchProfileContext } from './helpers/branchProfileContext'
import {
  DESKTOP_APP_ROOT,
  EXTERNAL_REST_API_BASE_URL,
  MAIN_ENTRY,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
  openAgentsPage,
} from './qa-recorder-helpers'

const execFileAsync = promisify(execFile)

/**
 * The journey only proves this branch if Desktop runs from this checkout: the
 * Electron runtime from its node_modules and the main bundle it just built.
 */
async function expectCheckoutBuild(app: ElectronApplication): Promise<void> {
  const identity = await app.evaluate(({ app: electronApp }) => ({
    packaged: electronApp.isPackaged,
    execPath: process.execPath,
    argv: process.argv,
  }))
  const electronDist = realpathSync(nodePath.join(DESKTOP_APP_ROOT, 'node_modules/electron/dist'))
  console.info(
    `[825] desktop build execPath=${identity.execPath} main=${MAIN_ENTRY} packaged=${identity.packaged}`
  )
  expect(identity.packaged, 'Desktop must not be a packaged app').toBe(false)
  expect(realpathSync(identity.execPath).startsWith(`${electronDist}${nodePath.sep}`)).toBe(true)
  expect(identity.argv).toContain(MAIN_ENTRY)
}

const HOST_NAMESPACE = 'mcp-host'
const WORKSPACE_PATH = '/workspace'
const POD_READY_TIMEOUT_MS = 300_000
const ADMIN_SESSION_COOKIE = 'control_ui_admin_session'

// E2E_GUARDIAN_IPC_FLOW: Desktop sends RPC through Electron's main process,
// which page.waitForResponse cannot observe. The business signals are the
// Host's own session list and per-turn replies, read through the app's
// window.clerum.rpc bridge (rpc-proxy -> Host), plus the Pod witness.

function kubeContext(): string {
  const context = (process.env.E2E_K8S_CONTEXT || process.env.KUBECONTEXT || '').trim()
  if (!context) {
    throw new Error('E2E_K8S_CONTEXT (or KUBECONTEXT) must name the branch-owned Minikube profile.')
  }
  return context
}

async function kubectl(args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync('kubectl', ['--context', kubeContext(), ...args], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout.toString()
}

async function kubectlJson(args: string[]): Promise<any> {
  return JSON.parse(await kubectl([...args, '-o', 'json']))
}

async function assertMinikubeProfile(): Promise<void> {
  assertBranchProfileContext(kubeContext())
  const nodes = await kubectlJson(['get', 'nodes'])
  const names = (nodes.items ?? []).map(
    (node: any) => node.metadata?.labels?.['minikube.k8s.io/name'] ?? ''
  )
  if (!names.includes(kubeContext())) {
    throw new Error(
      `Context ${kubeContext()} is not the Minikube profile of that name (nodes: ${JSON.stringify(names)}).`
    )
  }
}

function requiredEnv(label: string, candidates: Array<string | undefined>): string {
  const value = candidates.find(candidate => candidate?.trim())?.trim()
  if (!value) throw new Error(`${label} is required for the #825 Desktop continuity spec.`)
  return value
}

/**
 * Control API admin session. It uses Node's fetch, never a Playwright request
 * context, so the password and the session cookie stay out of the failure
 * trace. The cookie is issued Secure, so it is sent as an explicit header.
 */
class AdminApi {
  private constructor(
    private readonly origin: string,
    private readonly cookie: string
  ) {}

  static async login(baseUrl: string): Promise<AdminApi> {
    const origin = new URL(baseUrl).origin
    const username = process.env.TEST_ADMIN_USERNAME?.trim() || 'admin'
    const password = requiredEnv('The admin password', [
      process.env.E2E_ADMIN_PASSWORD,
      process.env.ADMIN_PASSWORD,
      process.env.ADMIN_PASS,
      process.env.TEST_ADMIN_PASSWORD,
    ])
    const response = await fetch(`${origin}/api/v1/admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!response.ok) {
      throw new Error(`admin login returned HTTP ${response.status}: ${await response.text()}`)
    }
    const pair = response.headers
      .getSetCookie()
      .map(value => value.split(';')[0].trim())
      .find(p => p.startsWith(`${ADMIN_SESSION_COOKIE}=`))
    if (!pair || pair === `${ADMIN_SESSION_COOKIE}=`) {
      throw new Error(`admin login did not set ${ADMIN_SESSION_COOKIE}`)
    }
    return new AdminApi(origin, pair)
  }

  private async call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    data?: unknown
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${this.origin}/api/v1${path}`, {
      method,
      headers: {
        cookie: this.cookie,
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    const text = await response.text()
    let body: any = text
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      // Non-JSON bodies are kept as text and reported in the failure message.
    }
    return { status: response.status, body }
  }

  private async expectStatus(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    expected: number,
    data?: unknown
  ): Promise<any> {
    const { status, body } = await this.call(method, path, data)
    if (status !== expected) {
      throw new Error(
        `${method} ${path} returned ${status} (expected ${expected}): ${JSON.stringify(body)}`
      )
    }
    return body
  }

  async userIdByEmail(email: string): Promise<string> {
    const body = await this.expectStatus('GET', `/admin/users?q=${encodeURIComponent(email)}`, 200)
    const user = (body?.items ?? []).find((item: any) => item?.email === email)
    if (!user?.id) throw new Error(`Desktop user ${email} not found through the admin API`)
    return String(user.id)
  }

  async firstTeamId(userId: string): Promise<string | null> {
    const body = await this.expectStatus('GET', `/admin/users/${userId}/teams`, 200)
    return body?.items?.[0]?.id ? String(body.items[0].id) : null
  }

  async createHost(name: string, sourceSpec: any, stateless: boolean): Promise<void> {
    const { channels: _channels, desktop: _desktop, ...rest } = sourceSpec
    const spec = { ...rest, host: name, lifecycle: { stateless } }
    await this.expectStatus('POST', '/admin/hosts', 201, { metadata: { name }, spec })
  }

  /**
   * GET then PUT with the read's resourceVersion, echoing the full spec as
   * Control UI does. HCC writes the Host status between the two calls, so a
   * `409 resource_changed` re-reads and retries (bounded); any other status,
   * or a fifth conflict, fails.
   */
  async setLifecycle(name: string, stateless: boolean): Promise<void> {
    const attempts = 5
    let last = ''
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const host = await this.expectStatus('GET', `/admin/hosts/${name}`, 200)
      const resourceVersion = host?.metadata?.resourceVersion
      if (!resourceVersion) throw new Error(`Host ${name} read has no resourceVersion`)
      const { status, body } = await this.call('PUT', `/admin/hosts/${name}`, {
        metadata: { resourceVersion },
        spec: { ...host.spec, lifecycle: { stateless } },
      })
      if (status === 200) return
      last = `${status}: ${JSON.stringify(body)}`
      if (status !== 409 || body?.reason !== 'resource_changed') {
        throw new Error(`PUT /admin/hosts/${name} returned ${last}`)
      }
      console.info(`[825] ${name}: lifecycle PUT conflict on attempt ${attempt}, re-reading`)
    }
    throw new Error(`PUT /admin/hosts/${name} conflicted ${attempts} times; last ${last}`)
  }

  async deleteHost(name: string): Promise<void> {
    const { status, body } = await this.call('DELETE', `/admin/hosts/${name}`)
    if (status !== 200 && status !== 404) {
      throw new Error(`DELETE Host ${name} returned ${status}: ${JSON.stringify(body)}`)
    }
  }

  /**
   * PUT /admin/{users|teams}/:id/agents filters names against the active
   * agent set, so a just-created Host can lag; retry until the response
   * echoes it back (bounded).
   */
  async setAgentGrant(path: string, name: string, op: 'add' | 'remove'): Promise<void> {
    let last = ''
    for (let attempt = 1; attempt <= 20; attempt++) {
      const current = await this.expectStatus('GET', path, 200)
      const agentNames: string[] = current?.agentNames ?? []
      const expectedCurrentAgentNames = [...agentNames, ...(current?.deletedAgentNames ?? [])]
      const next =
        op === 'add'
          ? Array.from(new Set([...agentNames, name]))
          : agentNames.filter(agent => agent !== name)
      const { status, body } = await this.call('PUT', path, {
        agentNames: next,
        expectedCurrentAgentNames,
      })
      if (status >= 200 && status < 300) {
        if (op === 'remove' || (body?.agentNames ?? []).includes(name)) return
      }
      last = `${status} ${JSON.stringify(body)}`
      await new Promise(resolve => setTimeout(resolve, 3_000))
    }
    throw new Error(`${op} grant '${name}' on ${path} did not converge: ${last}`)
  }
}

type PodStorage = {
  mounts: Array<{ mountPath: string; name: string }>
  store: string | undefined
  dbDir: string | undefined
  inits: string[]
}

function mcpHostContainer(pod: any): any {
  const container = (pod.spec?.containers ?? []).find((c: any) => c.name === 'mcp-host')
  if (!container) throw new Error(`Pod ${pod.metadata?.name} has no mcp-host container`)
  return container
}

function envValue(pod: any, name: string): string | undefined {
  return (mcpHostContainer(pod).env ?? []).find((e: any) => e.name === name)?.value
}

function podStorage(pod: any): PodStorage {
  return {
    mounts: (mcpHostContainer(pod).volumeMounts ?? [])
      .filter((m: any) => m.name === 'workspace')
      .map((m: any) => ({
        mountPath: m.mountPath,
        name: m.name,
        ...(m.subPath ? { subPath: m.subPath } : {}),
      })),
    store: envValue(pod, 'CLERUM_SESSION_STORE'),
    dbDir: envValue(pod, 'CLERUM_SESSION_DB_DIR'),
    inits: (pod.spec?.initContainers ?? []).map((c: any) => c.name),
  }
}

/** Exactly one Pod, Ready, not terminating, with a UID different from `oldUid`. */
async function waitNewReadyPod(hostName: string, oldUid: string): Promise<any> {
  let found: any = null
  // The poll returns 'READY' or the observed Pods, so a timeout prints what it saw.
  await expect
    .poll(
      async () => {
        const pods = await kubectlJson([
          'get',
          'pods',
          '-n',
          HOST_NAMESPACE,
          '-l',
          `app=${hostName}`,
        ])
        const items: any[] = pods.items ?? []
        const observed = JSON.stringify(
          items.map(p => ({
            uid: p.metadata?.uid,
            phase: p.status?.phase,
            deleting: Boolean(p.metadata?.deletionTimestamp),
            init: (p.status?.initContainerStatuses ?? []).map((s: any) => s.state),
          }))
        )
        const pod = items.length === 1 ? items[0] : null
        const ready =
          pod &&
          !pod.metadata?.deletionTimestamp &&
          pod.metadata?.uid !== oldUid &&
          (pod.status?.conditions ?? []).some((c: any) => c.type === 'Ready' && c.status === 'True')
        found = ready ? pod : null
        return found ? 'READY' : observed
      },
      {
        timeout: POD_READY_TIMEOUT_MS,
        intervals: [3_000],
        message: `${hostName}: a new Ready Pod replacing ${oldUid || '<none>'}`,
      }
    )
    .toBe('READY')
  return found
}

/** The lifecycle witness: the new Pod runs the requested lifecycle on the one root layout. */
function assertPod(pod: any, stateless: boolean): PodStorage {
  const name = pod.metadata?.name
  const flag = envValue(pod, 'CLERUM_STATELESS_LIFECYCLE')
  const priority = pod.spec?.priorityClassName ?? ''
  if (stateless) {
    expect(flag, `${name}: CLERUM_STATELESS_LIFECYCLE`).toBe('true')
    expect(priority, `${name}: priority class`).toBe('clerum-interactive-host')
  } else {
    expect(flag, `${name}: CLERUM_STATELESS_LIFECYCLE`).toBeUndefined()
    expect(priority, `${name}: priority class`).not.toBe('clerum-interactive-host')
  }
  const storage = podStorage(pod)
  expect(storage, `${name}: storage layout`).toEqual({
    mounts: [{ mountPath: WORKSPACE_PATH, name: 'workspace' }],
    store: 'sqlite',
    dbDir: WORKSPACE_PATH,
    inits: ['workspace-layout-merge'],
  })
  const merge = (pod.status?.initContainerStatuses ?? []).find(
    (s: any) => s.name === 'workspace-layout-merge'
  )
  expect(merge?.state?.terminated?.exitCode, `${name}: workspace-layout-merge exit code`).toBe(0)
  return storage
}

async function newChatFromAgentsPage(page: Page, hostName: string): Promise<void> {
  await openAgentsPage(page)
  await page.getByRole('button', { name: `More actions for ${hostName}`, exact: true }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible({ timeout: 15_000 })
  const newChat = menu
    .getByRole('button', { name: /^New chat$/ })
    .or(menu.getByRole('menuitem', { name: /^New chat$/ }))
  await newChat.click()
  await expect(page.getByRole('textbox', { name: 'Agent message composer' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole('button', { name: /^Switch chat agent$/ })).toContainText(hostName, {
    timeout: 30_000,
  })
}

async function sendMarker(page: Page, marker: string): Promise<void> {
  const composer = page.getByRole('textbox', { name: 'Agent message composer' })
  const sendButton = page.getByTestId('send-button')
  await composer.fill(`Reply with exactly: ${marker}`)
  await expect(sendButton).toBeEnabled()
  await sendButton.click()
  await expect(page.getByTestId('message-list')).toContainText(marker, { timeout: 30_000 })
  await expect(page.getByTestId('agent-response').filter({ hasText: marker })).toBeVisible({
    timeout: 180_000,
  })
  await expect(composer).toHaveValue('', { timeout: 30_000 })
  await expect(sendButton).toHaveAttribute('aria-label', 'Send message', { timeout: 180_000 })
}

async function renameActiveSession(page: Page, title: string): Promise<void> {
  const row = page.locator('.nav-latest-session.active')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.getByRole('button', { name: /^Session options for / }).click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Rename session', exact: true })
  await expect(input).toBeVisible()
  await input.fill(title)
  await input.press('Enter')
  await expect(page.getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible({
    timeout: 30_000,
  })
}

async function localChatId(page: Page, hostName: string, title: string): Promise<string> {
  let chatId: string | null = null
  await expect
    .poll(
      async () => {
        const chats = await page.evaluate(
          async hostRef => (window as any).clerum.chat.list(hostRef),
          hostName
        )
        const chat = (Array.isArray(chats) ? chats : []).find((c: any) => c.title === title)
        chatId = chat ? (chat.chatId ?? chat.id ?? null) : null
        return chatId
      },
      { timeout: 20_000, message: `local chat titled ${title} for ${hostName}` }
    )
    .not.toBeNull()
  return chatId as unknown as string
}

/** The Host's own view of the conversation, read through rpc-proxy. */
async function hostConversation(
  page: Page,
  hostName: string,
  chatId: string
): Promise<{ sessions: Array<{ chatId: string; turnCount: number }>; responses: string[] }> {
  return page.evaluate(
    async ({ hostRef, chatId: id }) => {
      const list = await (window as any).clerum.rpc.listSessions(hostRef)
      const sessions = (list?.items ?? []).map((item: any) => ({
        chatId: item.chatId,
        turnCount: item.turnCount,
        agent: item.agent,
      }))
      const own = sessions.find((s: any) => s.chatId === id)
      const messages = own
        ? await (window as any).clerum.rpc.loadSessionMessages(hostRef, own.agent, id)
        : null
      return {
        sessions: sessions.map(({ chatId: c, turnCount }: any) => ({ chatId: c, turnCount })),
        // Assistant replies only: the prompt also carries the marker, so a
        // match on user_input would pass for a turn the model never answered.
        responses: messages ? messages.turns.map((t: any) => String(t.response ?? '')) : [],
      }
    },
    { hostRef: hostName, chatId }
  )
}

/** The Host lists exactly this one conversation with `turns` turns, and turn i's reply holds marker i. */
async function expectHostHistory(
  page: Page,
  hostName: string,
  chatId: string,
  turns: number,
  markers: string[]
): Promise<void> {
  // The poll returns what the Host reports, so a timeout prints the difference.
  await expect
    .poll(
      async () => {
        const view = await hostConversation(page, hostName, chatId)
        return {
          sessions: view.sessions,
          missingMarkers: markers.filter(
            (marker, i) => !(view.responses[i] ?? '').includes(marker)
          ),
        }
      },
      {
        timeout: 60_000,
        intervals: [2_000],
        message: `${hostName}: one session ${chatId} with ${turns} turns holding every marker`,
      }
    )
    .toEqual({ sessions: [{ chatId, turnCount: turns }], missingMarkers: [] })
}

async function closeDesktop(app: ElectronApplication): Promise<void> {
  const child = app.process()
  await app.close()
  await expect
    .poll(() => child.exitCode !== null || child.signalCode !== null, {
      timeout: 30_000,
      message: `Electron process ${child.pid} must exit`,
    })
    .toBe(true)
}

test.skip(
  process.env.E2E_825_DESKTOP_CONTINUITY !== '1',
  'Set E2E_825_DESKTOP_CONTINUITY=1 for this cluster-mutating #825 journey'
)
test.describe.configure({ retries: 0 })

test('#825 — a conversation survives stateful -> stateless -> stateful switches', async ({}, testInfo) => {
  test.setTimeout(1_800_000)

  await assertMinikubeProfile()
  const controlApiUrl = requiredEnv('CONTROL_API_BASE_URL', [
    process.env.E2E_CONTROL_API_URL,
    process.env.CONTROL_API_BASE_URL,
  ])
  await assertAllowedTarget('CONTROL_API_BASE_URL', controlApiUrl)
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)
  const credentials = desktopCredentials()
  requiredEnv('E2E_DEV_LOGIN_EMAIL', [process.env.E2E_DEV_LOGIN_EMAIL])
  const sourceHost = process.env.E2E_825_SOURCE_HOST?.trim() || 'chatllm'

  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const hostName = `e2e-825-desk-${runId}`
  const title = `E2E_825_${runId}`
  const markers = [`E825_A_${runId}`, `E825_B_${runId}`, `E825_C_${runId}`]

  const admin = await AdminApi.login(controlApiUrl)
  let hostCreated = false
  let journeyFailed = false
  const grantPaths: string[] = []
  let app: ElectronApplication | undefined
  let page: Page | undefined
  const currentPage = (): Page => {
    if (!page) throw new Error('Desktop page is not open at this step')
    return page
  }

  try {
    let pod: any
    let storage: PodStorage

    await test.step('precondition: create and grant a stateful Host through the admin API', async () => {
      const source = await kubectlJson(['get', 'host', sourceHost, '-n', HOST_NAMESPACE])
      const userId = await admin.userIdByEmail(credentials.email)
      const teamId = await admin.firstTeamId(userId)
      await admin.createHost(hostName, source.spec, false)
      hostCreated = true
      grantPaths.push(`/admin/users/${userId}/agents`)
      if (teamId) grantPaths.push(`/admin/teams/${teamId}/agents`)
      for (const path of grantPaths) await admin.setAgentGrant(path, hostName, 'add')
      pod = await waitNewReadyPod(hostName, '')
      storage = assertPod(pod, false)
    })

    await test.step('1. log in through the UI', async () => {
      ;({ app, page } = await launchDesktopApp(testInfo))
      await expectCheckoutBuild(app)
      await login(currentPage(), credentials)
      await expect(currentPage().getByTestId('nav-chat')).toBeVisible({ timeout: 30_000 })
    })

    let chatId = ''
    await test.step('2. create a conversation and send the first marker', async () => {
      const p = currentPage()
      await newChatFromAgentsPage(p, hostName)
      await sendMarker(p, markers[0])
      await renameActiveSession(p, title)
      chatId = await localChatId(p, hostName, title)
      await expectHostHistory(p, hostName, chatId, 1, markers.slice(0, 1))
    })

    const rounds: Array<{ stateless: boolean; marker: string; turns: number }> = [
      { stateless: true, marker: markers[1], turns: 2 },
      { stateless: false, marker: markers[2], turns: 3 },
    ]
    for (const round of rounds) {
      const label = round.stateless ? 'stateless' : 'stateful'

      await test.step(`3. switch the Host to ${label} and witness the new Pod`, async () => {
        const oldUid = pod.metadata.uid
        await admin.setLifecycle(hostName, round.stateless)
        pod = await waitNewReadyPod(hostName, oldUid)
        expect(assertPod(pod, round.stateless), 'storage is unchanged across the switch').toEqual(
          storage
        )
      })

      await test.step(`4. restart Desktop and reopen the conversation from the sidebar (${label})`, async () => {
        if (!app) throw new Error('Electron app is not running at this step')
        await closeDesktop(app)
        app = undefined
        page = undefined
        ;({ app, page } = await launchDesktopApp(testInfo))
        await expectCheckoutBuild(app)
        const p = currentPage()
        await expect(p.locator('.boot-overlay')).toBeHidden({ timeout: 30_000 })
        await expect(p.getByTestId('nav-chat')).toBeVisible({ timeout: 30_000 })
        await expect(p.locator('#email-input')).toBeHidden()
        await p.getByRole('button', { name: `Open ${title}`, exact: true }).click()
        const composer = p.getByRole('textbox', { name: 'Agent message composer' })
        await expect(composer).toHaveAttribute(
          'placeholder',
          `Message ${hostName}... (Enter to send, Shift+Enter for newline)`,
          { timeout: 30_000, ignoreCase: true }
        )
        const previous = markers.slice(0, round.turns - 1)
        for (const marker of previous) {
          await expect(p.getByTestId('message-list')).toContainText(marker, { timeout: 60_000 })
        }
        await expectHostHistory(p, hostName, chatId, round.turns - 1, previous)
      })

      await test.step(`5. send a follow-up in the same conversation (${label})`, async () => {
        const p = currentPage()
        await sendMarker(p, round.marker)
        expect(await localChatId(p, hostName, title)).toBe(chatId)
        await expectHostHistory(p, hostName, chatId, round.turns, markers.slice(0, round.turns))
      })
    }
  } catch (error) {
    journeyFailed = true
    throw error
  } finally {
    await finalizeRecording(app, page)
    const cleanupErrors: string[] = []
    if (hostCreated) {
      for (const step of [
        () => admin.deleteHost(hostName),
        ...grantPaths.map(path => () => admin.setAgentGrant(path, hostName, 'remove')),
        () =>
          kubectl(
            [
              'wait',
              '--for=delete',
              `deployment/${hostName}`,
              '-n',
              HOST_NAMESPACE,
              '--timeout=120s',
            ],
            150_000
          ).then(() => undefined),
        () =>
          kubectl(
            [
              'delete',
              'pvc',
              `${hostName}-workspace`,
              '-n',
              HOST_NAMESPACE,
              '--ignore-not-found',
              '--wait=true',
              '--timeout=120s',
            ],
            150_000
          ).then(() => undefined),
      ]) {
        try {
          await step()
        } catch (error) {
          cleanupErrors.push(String(error))
        }
      }
    }
    // Cleanup failures leave cluster state behind. They fail the test; when the
    // journey already failed they are printed so its own error stays the cause.
    if (cleanupErrors.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`[e2e-825] cleanup of ${hostName} failed:\n${cleanupErrors.join('\n')}`)
      if (!journeyFailed)
        throw new Error(`cleanup of ${hostName} failed: ${cleanupErrors.join('; ')}`)
    }
  }
})
