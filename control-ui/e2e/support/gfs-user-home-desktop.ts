// E2E_GUARDIAN_IPC_FLOW: Desktop actions cross the Electron IPC bridge. The
// calling spec checks the visible transition and the persisted GFS signal.
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEV_ISOLATION_ENV, devIsolationPaths } from '../../../desktop-app/src/devIsolation'
import {
  HUMAN_E2E_RECORDED,
  humanRecordedPause,
} from '../../../desktop-app/test/e2e-playwright/helpers/humanPause'
import { awaitPasswordPace } from '../../../desktop-app/test/e2e-playwright/helpers/passwordPace'
import type { HomeFixtureUser } from './gfs-user-home-fixtures'

const desktopRoot = path.resolve(__dirname, '../../../desktop-app')

async function openResourcesNavItem(page: Page, itemTestId: string): Promise<void> {
  const item = page.getByTestId(itemTestId)
  if (!(await item.isVisible().catch(() => false))) {
    const settingsMenu = page.getByTestId('nav-settings-menu')
    await expect(settingsMenu).toBeVisible({ timeout: 15_000 })
    if ((await settingsMenu.getAttribute('aria-expanded')) !== 'true') {
      await settingsMenu.click()
    }
    await expect(settingsMenu).toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 })
  }
  await expect(item).toBeVisible({ timeout: 15_000 })
  await item.click()
}

function requiredLoopbackEndpoint(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for the isolated Desktop fixture`)
  const parsed = new URL(value)
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
    !parsed.port ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(`${name} must be an explicit local endpoint`)
  }
  return value
}

export async function launchHomeDesktop(
  user: HomeFixtureUser
): Promise<{ app: ElectronApplication; page: Page }> {
  if (!process.version.startsWith('v24.')) throw new Error('Desktop E2E requires Node 24')
  if (process.env.ELECTRON_RUN_AS_NODE)
    throw new Error('Unset ELECTRON_RUN_AS_NODE for Desktop E2E')
  const restUrl = requiredLoopbackEndpoint('EXTERNAL_REST_API_BASE_URL')
  const rpcUrl = requiredLoopbackEndpoint('RPC_PROXY_BASE_URL')
  const desktopRequire = createRequire(path.join(desktopRoot, 'package.json'))
  const executable = desktopRequire('electron') as string
  fs.accessSync(executable, fs.constants.X_OK)
  const appPath = fs.realpathSync(path.join(desktopRoot, 'dist'))
  fs.accessSync(path.join(appPath, 'main.js'))
  fs.accessSync(path.join(desktopRoot, 'ui-dist/index.html'))
  const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-e2e-home-')))
  const isolated = devIsolationPaths(runDir)
  fs.mkdirSync(isolated.userDataDir, { mode: 0o700 })
  let app: ElectronApplication
  try {
    app = await electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${isolated.userDataDir}`, path.join(appPath, 'main.js')],
      env: {
        ...process.env,
        EVENFIRE_DEV_ISOLATION: '1',
        [DEV_ISOLATION_ENV.runDir]: runDir,
        [DEV_ISOLATION_ENV.restUrl]: restUrl,
        [DEV_ISOLATION_ENV.rpcUrl]: rpcUrl,
        [DEV_ISOLATION_ENV.target]: path.basename(runDir),
        [DEV_ISOLATION_ENV.appPath]: appPath,
        EXTERNAL_REST_API_BASE_URL: restUrl,
        RPC_PROXY_BASE_URL: rpcUrl,
        CLERUM_DESKTOP_CONFIG_PATH: isolated.configPath,
        EVENFIRE_RENDERER_URL: '',
      },
      // Recorded runs (/human-e2e-recorder) keep each Desktop window's video.
      ...(HUMAN_E2E_RECORDED
        ? {
            recordVideo: {
              dir: test.info().outputPath(`video-desktop-${user.name}`),
              size: { width: 1280, height: 720 },
            },
          }
        : {}),
    })
  } catch (error) {
    fs.rmSync(runDir, { recursive: true, force: true })
    throw error
  }
  app.on('close', () => fs.rmSync(runDir, { recursive: true, force: true }))
  // Main-process and renderer output beside the test's artifacts: a refused
  // login is only a transient toast, so a failure needs this to be diagnosed.
  const outputLog = test.info().outputPath(`desktop-${user.name}.log`)
  fs.mkdirSync(path.dirname(outputLog), { recursive: true })
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on('data', chunk => fs.appendFileSync(outputLog, chunk))
  }
  try {
    const runtime = await app.evaluate(({ app: electronApp }) => ({
      executable: process.execPath,
      appPath: electronApp.getAppPath(),
      userData: electronApp.getPath('userData'),
      isPackaged: electronApp.isPackaged,
    }))
    expect(fs.realpathSync(runtime.executable)).toBe(fs.realpathSync(executable))
    expect(fs.realpathSync(runtime.appPath)).toBe(appPath)
    expect(fs.realpathSync(runtime.userData)).toBe(fs.realpathSync(isolated.userDataDir))
    expect(runtime.isPackaged).toBe(false)
    const page = await app.firstWindow()
    page.on('console', message =>
      fs.appendFileSync(outputLog, `[renderer ${message.type()}] ${message.text()}\n`)
    )
    expect(page.url()).toBe(pathToFileURL(path.join(desktopRoot, 'ui-dist/index.html')).href)
    // Fill and submit only after the boot splash leaves, as the Desktop lane's
    // loginVisible does.
    await expect(page.locator('.boot-overlay')).toBeHidden({ timeout: 30_000 })
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible()
    await page.getByLabel('Email', { exact: true }).fill(user.email)
    await page.getByLabel('Password', { exact: true }).fill(user.password)
    await awaitPasswordPace()
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByTestId('nav-settings-menu')).toBeVisible({ timeout: 60_000 })
    const id = await page.evaluate(async () => {
      const bridge = (
        window as unknown as {
          clerum: { auth: { getSessionState: () => Promise<{ me: { id: string } | null }> } }
        }
      ).clerum
      return (await bridge.auth.getSessionState()).me?.id
    })
    expect(id).toBe(user.id)
    return { app, page }
  } catch (error) {
    await app.close()
    throw error
  }
}

export async function openDesktopHome(page: Page, folderName: string): Promise<void> {
  await openResourcesNavItem(page, 'nav-files')
  await expect(page.getByRole('region', { name: 'EvenDrive browser' })).toBeVisible()
  const home = page.getByRole('treeitem', { name: 'My home', exact: true })
  await expect(home).toBeVisible({ timeout: 150_000 })
  await expect(async () => {
    await home.click()
    await expect(page.getByRole('navigation', { name: 'File location' })).toContainText(
      folderName,
      {
        timeout: 1_000,
      }
    )
  }).toPass({ timeout: 150_000, intervals: [2_000, 5_000] })
  await humanRecordedPause([600, 1200])
}

export async function uploadDesktopFile(page: Page, name: string, content: string): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfs-home-upload-'))
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, content)
  await page.getByLabel('Upload file', { exact: true }).setInputFiles(filePath)
  await expect(page.getByRole('button', { name: `Open ${name}` })).toBeVisible({
    timeout: 120_000,
  })
  fs.rmSync(dir, { recursive: true, force: true })
  await humanRecordedPause([600, 1200])
}

export async function shareDesktopFolder(
  page: Page,
  folderName: string,
  recipient: string
): Promise<void> {
  await page.getByRole('button', { name: `Options for ${folderName}`, exact: true }).click()
  await page
    .getByRole('menu', { name: `Actions for ${folderName}` })
    .getByRole('menuitem', { name: 'Share', exact: true })
    .hover()
  await page
    .getByRole('menu', { name: `Share options for ${folderName}` })
    .getByRole('menuitem', { name: 'Share', exact: true })
    .click()
  const dialog = page.getByRole('dialog', { name: `Share folder ${folderName}` })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('combobox', { name: 'Add people, teams, or agents' }).fill(recipient)
  await dialog
    .getByRole('listbox', { name: 'Available people, teams, and agents' })
    .getByRole('option', { name: new RegExp(recipient) })
    .click()
  await expect(
    dialog.getByRole('checkbox', { name: 'Include contents of this folder' })
  ).toBeChecked()
  await dialog.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(
    dialog.getByRole('list', { name: 'Resource access' }).getByText(recipient, { exact: true })
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Close share dialog' }).click()
  await humanRecordedPause([600, 1200])
}

export async function openDesktopLink(page: Page, uri: string): Promise<void> {
  await openResourcesNavItem(page, 'nav-files')
  const root = page
    .getByRole('navigation', { name: 'File location' })
    .getByRole('button', { name: 'Shared with me' })
  if (await root.isEnabled()) await root.click()
  await expect(root).toBeDisabled()
  await page.getByRole('button', { name: 'Options for Shared with me' }).click()
  await page
    .getByRole('menu', { name: 'Actions for Shared with me' })
    .getByRole('menuitem', { name: 'Open EvenDrive link' })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Open EvenDrive link' })
  // By role: a label substring also matches the "Close EvenDrive link dialog" button.
  await dialog.getByRole('textbox', { name: 'EvenDrive link' }).fill(uri)
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()
  await humanRecordedPause([600, 1200])
}

export async function readWithAgent(
  page: Page,
  agentName: string,
  uri: string,
  sentinel: string,
  allowed: boolean
): Promise<void> {
  await page.getByTestId('nav-chat').click()
  await page.getByTestId('nav-new-chat').click()
  await expect(page.getByTestId('agent-response')).toHaveCount(0)
  await page.getByRole('button', { name: 'Switch chat agent' }).click()
  await page.getByRole('menuitem', { name: agentName, exact: true }).click()
  await page
    .getByTestId('chat-input')
    .fill(`Use your GFS tools to read ${uri} and return the exact file contents.`)
  await page.getByTestId('send-button').click()
  const progress = page.getByTestId('progress-expand-btn')
  const approval = page.getByTestId('approval-approve-btn')
  const deadline = Date.now() + 300_000
  while ((await progress.count()) === 0) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Agent did not complete the GFS read')
    const ready = progress
      .waitFor({ state: 'visible', timeout: remaining })
      .then(() => 'result' as const)
    const pendingApproval = approval
      .waitFor({ state: 'visible', timeout: remaining })
      .then(() => 'approval' as const)
    void ready.catch(() => undefined)
    void pendingApproval.catch(() => undefined)
    if ((await Promise.race([ready, pendingApproval])) === 'approval') {
      await approval.click()
      await expect(approval).toHaveCount(0)
    }
  }
  await expect(page.getByTestId('agent-response')).toBeVisible()
  await progress.click()
  const stepper = page.getByTestId('progress-stepper')
  await expect(stepper).toBeVisible()
  await expect(stepper).not.toContainText(/not_mounted|\b503\b|timed out/i)
  const readSteps = stepper
    .getByTestId(/^step-row-/)
    .filter({ has: page.getByText('gfs_read', { exact: true }) })
  if (allowed) {
    await expect(readSteps).toHaveCount(1)
    await readSteps.click()
    await expect(page.getByTestId('step-output-panel')).toContainText(sentinel)
    return
  }
  await expect(page.getByTestId('agent-response')).not.toContainText(sentinel)
  const attempts = await readSteps.all()
  const resolveSteps = stepper
    .getByTestId(/^step-row-/)
    .filter({ has: page.getByText('gfs_resolve', { exact: true }) })
  const deniedSteps = attempts.length > 0 ? attempts : await resolveSteps.all()
  expect(deniedSteps.length).toBeGreaterThan(0)
  for (const row of deniedSteps) {
    const testId = await row.getAttribute('data-testid')
    const callId = testId?.replace(/^step-row-/, '')
    if (!callId || !/^[A-Za-z0-9_-]+$/.test(callId)) throw new Error('Invalid tool-call identifier')
    const output = page
      .getByTestId('step-output-panel')
      .and(page.locator(`[data-tool-call-id="${callId}"]`))
    if (!(await output.isVisible())) await row.click()
    await expect(output).toContainText(
      /403|forbidden|not authorized|permission denied|access denied|not.found/i
    )
    await expect(output).not.toContainText(sentinel)
  }
  await humanRecordedPause([600, 1200])
}
