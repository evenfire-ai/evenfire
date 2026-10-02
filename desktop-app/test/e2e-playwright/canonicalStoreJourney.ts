/// <reference path="../../src/renderer.d.ts" />
// E2E_GUARDIAN_IPC_FLOW: real Desktop RPC uses main-process IPC. Visible
// transitions and the independent read-only catalog observe business writes.
import {
  type ElectronApplication,
  type Page,
  type TestInfo,
  _electron as electron,
  expect,
} from '@playwright/test'
import { type ChildProcess, execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  openCanonicalStoreRecordDirectory,
  readCanonicalStoreRecord,
} from '../../../scripts/e2e/_lib/canonical-store-record.cjs'
import { admitIsolationBaseDir, defaultIsolationBaseDir } from '../../src/devIsolation'
import { openAgentsPage } from './navigationHelpers'

const execute = promisify(execFile)
export const repoRoot = path.resolve(__dirname, '../../..')
export function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}
export type RuntimeEvidence = {
  schemaVersion: 1
  hostUid: string
  pvcUid: string
  catalogHash: string
  counts: Record<string, number>
  ids: { sessions: string[]; messages: string[]; pending_approvals: string[] }
  rowHashes: Record<string, Array<{ id: string; sha256: string }>>
  identity: null | { storeId: string; hostUid: string; pvcUid: string; layoutVersion: 1 }
}
export type Checkpoint = {
  schemaVersion: 1
  runId: string
  sequence: number
  phase: string
  kind: 'hold' | 'rollout' | 'activation'
  runtime: {
    hostUid: string
    pvcUid: string
    podUid: string
    storageContract: string
    storeId: string | null
  }
}
type Journey = {
  app: ElectronApplication
  page: Page
  directory: string
  owner: Record<string, unknown>
  testInfo: TestInfo
}
const owners = new WeakMap<Page, Journey>()
function record(journey: Journey, phase: string): void {
  const temporary = path.join(journey.directory, 'journey-owner.next.json')
  fs.writeFileSync(temporary, JSON.stringify({ ...journey.owner, phase }), { mode: 0o600 })
  fs.renameSync(temporary, path.join(journey.directory, 'journey-owner.json'))
}
export function verifyJourneyInputs(): void {
  if (process.env.E2E_CANONICAL_STORE_JOURNEY !== '1')
    throw new Error('E2E_CANONICAL_STORE_JOURNEY=1 is required; no skipped gate')
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Desktop requires Node 24')
  if (process.env.QA_RECORDER_CONFIRM_CHAT !== '1')
    throw new Error('Real synthetic model turns require confirmation')
  const context = required('KUBECONTEXT')
  if (
    !/^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/.test(context) ||
    context !== required('MINIKUBE_PROFILE')
  )
    throw new Error('Owned profile/context mismatch')
  execFileSync('bash', [path.join(repoRoot, 'scripts/minikube/require-t2-mutation-lock.sh')], {
    env: process.env,
    timeout: 20000,
    stdio: 'ignore',
  })
  execFileSync('npm', ['run', 'verify:electron'], {
    cwd: path.join(repoRoot, 'desktop-app'),
    timeout: 30000,
    stdio: 'ignore',
  })
  for (const [name, key] of [
    ['EXTERNAL_REST_API_BASE_URL', 'EXTERNAL_REST_API_URL'],
    ['RPC_PROXY_BASE_URL', 'RPC_PROXY_URL'],
  ] as const) {
    const values = fs
      .readFileSync(required('E2E_PROFILE_PORTS_ENV'), 'utf8')
      .split('\n')
      .filter(line => line.startsWith(key + '='))
    if (
      values.length !== 1 ||
      values[0]!.slice(key.length + 1).replace(/\/$/, '') !== required(name).replace(/\/$/, '')
    )
      throw new Error('Persisted endpoint mismatch')
    const url = new URL(required(name))
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.port ||
      url.username ||
      url.password
    )
      throw new Error('Expected credential-free loopback endpoint')
  }
}
export async function launchJourney(testInfo: TestInfo): Promise<Journey> {
  const base = defaultIsolationBaseDir({
    platform: process.platform,
    homedir: os.homedir(),
    env: process.env,
  })
  const admitted = admitIsolationBaseDir({
    requested: base,
    repoRoot,
    platform: process.platform,
    homedir: os.homedir(),
    env: process.env,
  })
  if (!admitted.ok) throw new Error(admitted.code)
  fs.mkdirSync(admitted.baseDir, { recursive: true, mode: 0o700 })
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(admitted.baseDir), 'canonical825-'))
  fs.chmodSync(directory, 0o700)
  const userData = path.join(directory, 'user-data')
  fs.mkdirSync(userData, { mode: 0o700 })
  const entry = path.join(repoRoot, 'desktop-app/dist/main.js')
  if (!fs.existsSync(entry)) throw new Error('Desktop build missing')
  const laneId = createHash('sha256')
    .update(required('E2E_CANONICAL_RUN_ID') + ':' + testInfo.testId)
    .digest('hex')
    .slice(0, 12)
  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, entry],
    // No trace/video producer is started: pinned Playwright serializes secrets.
    env: {
      ...process.env,
      DEBUG: '',
      PWDEBUG: '0',
      ELECTRON_RENDERER_URL: '',
      EVENFIRE_DEV_ISOLATION: '1',
      EVENFIRE_DEV_ISOLATION_RUN_DIR: directory,
      EVENFIRE_DEV_ISOLATION_TARGET: `canonical825-${laneId}`,
      EVENFIRE_DEV_ISOLATION_REST_URL: required('EXTERNAL_REST_API_BASE_URL'),
      EVENFIRE_DEV_ISOLATION_RPC_URL: required('RPC_PROXY_BASE_URL'),
      EVENFIRE_DEV_ISOLATION_APP_PATH: path.dirname(entry),
      CLERUM_DESKTOP_CONFIG_PATH: path.join(directory, 'runtime-config.json'),
    },
  })
  const actual = await app.evaluate(({ app: application }) => application.getPath('userData'))
  expect(fs.realpathSync(actual)).toBe(fs.realpathSync(userData))
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const journey: Journey = {
    app,
    page,
    directory,
    testInfo,
    owner: {
      schemaVersion: 1,
      runId: required('E2E_CANONICAL_RUN_ID'),
      laneId,
      testId: testInfo.testId,
      context: required('KUBECONTEXT'),
      hostRef: required('E2E_CANONICAL_HOST_REF'),
      pid: app.process().pid,
      userData: fs.realpathSync(userData),
      worktree: repoRoot,
      buildSha256: createHash('sha256').update(fs.readFileSync(entry)).digest('hex'),
    },
  }
  owners.set(page, journey)
  record(journey, 'launched-private-profile')
  return journey
}
export async function closeJourney(journey: Journey): Promise<void> {
  let cleanupError: Error | undefined
  try {
    if (await journey.page.getByTestId('nav-settings-menu').count()) {
      const settings = journey.page.getByTestId('nav-settings-menu')
      if ((await settings.getAttribute('aria-expanded')) !== 'true') await settings.click()
      const logout = journey.page.getByTestId('logout-btn')
      await expect(logout).toBeVisible()
      await logout.click()
      // This product success status is emitted only after auth.logout() has
      // awaited the now-strict private store clear promise.
      await expect(journey.page.getByRole('status').filter({ hasText: 'Logged out.' })).toBeVisible(
        { timeout: 30000 }
      )
      await expect(journey.page.locator('#email-input')).toBeVisible({ timeout: 30000 })
      await expect(journey.page.locator('#password-input')).toHaveAttribute('type', 'password')
      record(journey, 'visible-logout-completed')
    } else record(journey, 'no-authenticated-ui-observed')
  } catch {
    cleanupError = new Error('Owned profile logout could not be verified')
    record(journey, 'logout-unverified-retained')
  }
  const child = journey.app.process()
  const exited =
    child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve()
  await journey.app.close()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned Electron did not exit')), 20000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  if (cleanupError) {
    record(journey, 'closed-cleanup-unverified-retained')
    throw cleanupError
  }
  const descriptor = JSON.parse(
    fs.readFileSync(path.join(journey.directory, 'journey-owner.json'), 'utf8')
  )
  // Only confirmed logout permits directory cleanup. A missing authenticated
  // surface after a negative rendering fault is uncertainty, so retain it.
  if (descriptor.phase !== 'visible-logout-completed') {
    record(journey, 'closed-auth-cleanup-unverified-retained')
    return
  }
  expect(descriptor.runId).toBe(required('E2E_CANONICAL_RUN_ID'))
  expect(descriptor.testId).toBe(journey.testInfo.testId)
  expect(descriptor.userData).toBe(fs.realpathSync(path.join(journey.directory, 'user-data')))
  const directoryInfo = fs.lstatSync(journey.directory)
  expect(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink()).toBe(true)
  expect(directoryInfo.mode & 0o777).toBe(0o700)
  record(journey, 'closed-private-cleanup-pending')
  try {
    fs.rmSync(journey.directory, { recursive: true, force: true })
  } catch {
    journey.owner.phase = 'closed-private-cleanup-retained'
    const error = new Error('Owned profile directory cleanup failed; recovery required')
    try {
      record(journey, 'closed-private-cleanup-retained')
    } catch {
      throw error
    }
    throw error
  }
  // The descriptor was inside the removed directory. Confirm only in memory,
  // after removal succeeded; never recreate a descriptor in the deleted path.
  journey.owner.phase = 'closed-private-cleanup-confirmed'
}
export async function signInVisibly(page: Page): Promise<void> {
  await expect(page.locator('#email-input')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('#password-input')).toBeVisible()
  await expect(page.locator('#password-input')).toHaveAttribute('type', 'password')
  await page.locator('#email-input').fill(required('E2E_DEV_LOGIN_EMAIL'))
  await page.locator('#password-input').fill(required('E2E_USER_PASSWORD'))
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('#email-input')).toBeHidden({ timeout: 30000 })
  await expect(page.getByTestId('nav-chat')).toBeVisible()
  await page.getByTestId('nav-settings-menu').click()
  await expect(page.getByTestId('user-display-name')).toHaveText(
    required('E2E_CANONICAL_USER_DISPLAY')
  )
  await expect(page.getByTestId('nav-agents')).toBeVisible()
  const journey = owners.get(page)
  if (journey) record(journey, 'visible-login-completed')
}
export async function createChatVisibly(
  page: Page,
  hostDisplay: string,
  timeout = 30000
): Promise<void> {
  await openAgentsPage(page)
  const action = page.getByRole('button', { name: `More actions for ${hostDisplay}`, exact: true })
  await expect(action).toBeVisible({ timeout })
  await action.click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  const create = menu
    .getByRole('button', { name: 'New chat', exact: true })
    .or(menu.getByRole('menuitem', { name: 'New chat', exact: true }))
  await expect(create).toBeVisible()
  await create.click()
  await expect(page.getByRole('textbox', { name: 'Agent message composer' })).toBeVisible({
    timeout,
  })
  await expect(page.getByRole('button', { name: 'Switch chat agent', exact: true })).toContainText(
    hostDisplay
  )
  await expect(page.getByRole('navigation', { name: 'Chat breadcrumb' })).toContainText('Chat')
}
export async function sendTurnVisibly(
  page: Page,
  marker: string,
  timeout = 180000
): Promise<{ userId: string; assistantId: string }> {
  const prompt = `Reply with exactly ${marker}.`,
    composer = page.getByRole('textbox', { name: 'Agent message composer' })
  await composer.fill(prompt)
  const send = page.getByTestId('send-button')
  await expect(send).toBeEnabled()
  await send.click()
  const user = page
    .locator('[data-chat-message-id]')
    .filter({ has: page.getByText(prompt, { exact: true }) })
  const reply = page.getByTestId('agent-response').filter({ hasText: marker })
  await expect(user).toBeVisible({ timeout })
  await expect(reply).toBeVisible({ timeout })
  await expect(user).toHaveAttribute('data-chat-message-id', /\S+/)
  await expect(reply).toHaveAttribute('data-chat-message-id', /\S+/)
  await expect(composer).toHaveValue('')
  await expect(send).toBeDisabled()
  await expect(send).toHaveAttribute('aria-label', 'Send message')
  return {
    userId: (await user.getAttribute('data-chat-message-id'))!,
    assistantId: (await reply.getAttribute('data-chat-message-id'))!,
  }
}
export async function observedChats(
  page: Page,
  hostRef: string
): Promise<Array<{ id: string; title: string }>> {
  // Observe IDs produced by visible clicks. No mutation/auth/send IPC shortcut.
  return page.evaluate(async host => {
    const records = await window.clerum.chat.list(host)
    return records.map(record => {
      if (typeof record.title !== 'string') throw new Error('Visible chat title missing')
      return { id: record.id, title: record.title }
    })
  }, hostRef)
}
export async function renameChatVisibly(
  page: Page,
  oldTitle: string,
  title: string
): Promise<void> {
  await expect(page.getByRole('button', { name: `Open ${oldTitle}`, exact: true })).toBeVisible()
  await page.getByRole('button', { name: `Session options for ${oldTitle}`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Rename session', exact: true })
  await input.fill(title)
  await input.press('Enter')
  await expect(page.getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible()
}
export async function reopenChatVisibly(
  page: Page,
  title: string,
  hostDisplay: string,
  markers: string[]
): Promise<void> {
  await openAgentsPage(page)
  await expect(
    page.getByRole('button', { name: `More actions for ${hostDisplay}`, exact: true })
  ).toBeVisible()
  await page.getByRole('button', { name: `Open ${title}`, exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Chat breadcrumb' })).toContainText(hostDisplay)
  await expect(page.getByRole('textbox', { name: 'Agent message composer' })).toBeVisible()
  for (const marker of markers)
    await expect(page.getByTestId('agent-response').filter({ hasText: marker })).toBeVisible({
      timeout: 30000,
    })
}
export async function captureCatalog(): Promise<RuntimeEvidence> {
  const args = ['--context', required('KUBECONTEXT'), '--request-timeout=30s', '-n', 'mcp-host']
  const host = required('E2E_CANONICAL_HOST_REF')
  const pods = JSON.parse(
    (
      await execute('kubectl', [...args, 'get', 'pods', '-l', `app=${host}`, '-o', 'json'], {
        timeout: 35000,
      })
    ).stdout
  )
  const live = pods.items.filter(
    (pod: any) =>
      !pod.metadata.deletionTimestamp &&
      pod.status.containerStatuses?.some(
        (container: any) => container.name === 'mcp-host' && container.state?.running
      )
  )
  expect(live).toHaveLength(1)
  const child = execFile(
    'kubectl',
    [
      ...args,
      'exec',
      '-i',
      live[0].metadata.name,
      '-c',
      'mcp-host',
      '--',
      '/usr/bin/env',
      '-i',
      'PATH=/usr/local/bin:/usr/bin:/bin',
      '/usr/local/bin/node',
      '-',
      'catalog',
      required('E2E_CANONICAL_HOST_UID'),
      required('E2E_CANONICAL_PVC_UID'),
      '/var/lib/clerum/state',
    ],
    { timeout: 35000 }
  )
  let output = ''
  child.stdout?.on('data', chunk => {
    output += chunk
  })
  child.stdin?.end(
    fs.readFileSync(
      path.join(repoRoot, 'scripts/e2e/_lib/canonical-store-runtime-probe.cjs'),
      'utf8'
    )
  )
  const [code] = await once(child, 'exit')
  expect(code).toBe(0)
  const catalog = JSON.parse(output) as RuntimeEvidence
  expect(catalog.hostUid).toBe(required('E2E_CANONICAL_HOST_UID'))
  expect(catalog.pvcUid).toBe(required('E2E_CANONICAL_PVC_UID'))
  expect(catalog.catalogHash).toMatch(/^[0-9a-f]{64}$/)
  return catalog
}
export function waitCheckpoint(
  directory: string,
  sequence: number,
  runId: string,
  gate: ChildProcess
): Promise<Checkpoint> {
  return new Promise((resolve, reject) => {
    const filename = path.join(directory, `${sequence}.json`)
    let done = false
    const directoryDescriptor = openCanonicalStoreRecordDirectory(directory)
    let watcher: fs.FSWatcher
    try {
      watcher = fs.watch(directory, check)
    } catch (error) {
      fs.closeSync(directoryDescriptor)
      throw error
    }
    const timer = setTimeout(() => finish(new Error('Runtime checkpoint deadline')), 300000)
    const failed = () => finish(new Error('Runtime gate ended before required checkpoint'))
    gate.once('exit', failed)
    gate.once('error', failed)
    function finish(error?: Error, value?: Checkpoint) {
      if (done) return
      done = true
      watcher.close()
      fs.closeSync(directoryDescriptor)
      clearTimeout(timer)
      gate.removeListener('exit', failed)
      gate.removeListener('error', failed)
      if (error) reject(error)
      else resolve(value!)
    }
    function check() {
      try {
        const record = readCanonicalStoreRecord(filename, directoryDescriptor) as Checkpoint
        if (
          record.schemaVersion !== 1 ||
          record.runId !== runId ||
          record.sequence !== sequence ||
          record.runtime.hostUid !== required('E2E_CANONICAL_HOST_UID') ||
          record.runtime.pvcUid !== required('E2E_CANONICAL_PVC_UID')
        )
          throw new Error('Stale checkpoint binding')
        finish(undefined, record)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        finish(error as Error)
      }
    }
    check()
  })
}
export function acknowledgeCheckpoint(directory: string, checkpoint: Checkpoint): void {
  const temporary = path.join(directory, `${checkpoint.sequence}.ack.next`),
    final = path.join(directory, `${checkpoint.sequence}.ack.json`)
  if (fs.existsSync(final)) throw new Error('Duplicate UI acknowledgement')
  fs.writeFileSync(
    temporary,
    JSON.stringify({
      runId: checkpoint.runId,
      sequence: checkpoint.sequence,
      phase: checkpoint.phase,
      uiVerified: true,
    }),
    { mode: 0o600, flag: 'wx' }
  )
  fs.renameSync(temporary, final)
}
