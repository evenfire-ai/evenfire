/**
 * E2E_GUARDIAN_IPC_FLOW: launches only after an independently inspected Linux
 * runner receipt matches actual OS, namespaces and mounts. No legacy reset,
 * seeding, API login, or IPC that advances the journey belongs in this fixture.
 * Main must inspect fresh HOME/keychain, bind mounts, namespace ownership,
 * no personal-home/DBus/SSH mounts, target relays, source and stack marker first.
 * A fresh userData directory or an env assertion cannot prove auth isolation.
 */
import {
  type ElectronApplication,
  type Page,
  test as base,
  _electron as electron,
  expect,
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { requirePixelRenderer } from './subscriptionImageChallenge.js'
import {
  type ProviderBinding,
  type RunnerObservation,
  type SubscriptionImageRun,
  requireSubscriptionImageRun,
  verifyRunnerObservation,
} from './subscriptionImageRunContract.js'

export const subscriptionImageRun = requireSubscriptionImageRun()
const repoRoot = path.resolve(__dirname, '../../..')
const mainEntry = path.join(repoRoot, 'desktop-app/dist/main.js')
export const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex')

function readPrivateJson(filename: string, maxBytes: number): unknown {
  if (fs.realpathSync(path.dirname(filename)) !== path.dirname(filename))
    throw new Error('Runner evidence parent must not be a symlink')
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > maxBytes
    ) {
      throw new Error('Runner evidence must be bounded, private and owned')
    }
    return JSON.parse(fs.readFileSync(fd, 'utf8'))
  } finally {
    fs.closeSync(fd)
  }
}
function observeRunner(): RunnerObservation {
  if (process.platform !== 'linux' || !process.getuid || !process.getgid)
    throw new Error('Inspected non-root Linux runner required before Electron')
  return {
    platform: process.platform,
    uid: process.getuid(),
    gid: process.getgid(),
    home: fs.realpathSync(os.userInfo().homedir),
    mountNamespace: fs.readlinkSync('/proc/self/ns/mnt'),
    pidNamespace: fs.readlinkSync('/proc/self/ns/pid'),
    userNamespace: fs.readlinkSync('/proc/self/ns/user'),
    mountInfoSha256: sha256(fs.readFileSync('/proc/self/mountinfo')),
  }
}
export function verifyPhysicalRunner(run: SubscriptionImageRun): void {
  const observed = observeRunner()
  const receipt = readPrivateJson(run.runnerReceipt, 64 * 1024) as {
    kind?: string
    runId?: string
    repoRoot?: string
    gitHead?: string
    profile?: string
    context?: string
    restUrl?: string
    rpcUrl?: string
    bindings?: ProviderBinding[]
    observation?: RunnerObservation
  }
  const gitHead = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    timeout: 5_000,
  }).trim()
  if (
    receipt.kind !== 'evenfire-subscription-image-runner-v1' ||
    receipt.runId !== run.runId ||
    receipt.repoRoot !== fs.realpathSync(repoRoot) ||
    receipt.gitHead !== gitHead ||
    receipt.profile !== run.profile ||
    receipt.context !== run.context ||
    receipt.restUrl !== run.restUrl ||
    receipt.rpcUrl !== run.rpcUrl ||
    !isDeepStrictEqual(receipt.bindings, run.bindings) ||
    !receipt.observation
  ) {
    throw new Error('Physical runner receipt does not bind this run/source/stack/targets')
  }
  verifyRunnerObservation(receipt.observation, observed, process.env)
  const root = fs.lstatSync(run.runRoot)
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== observed.uid ||
    (root.mode & 0o077) !== 0 ||
    fs.realpathSync(run.runRoot) !== run.runRoot
  )
    throw new Error('Runner root must be private and physically owned')
  for (const name of [
    'XDG_RUNTIME_DIR',
    'XAUTHORITY',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
  ]) {
    const value = process.env[name]
    if (value && !(value.startsWith(`${observed.home}/`) || value.startsWith(`${run.runRoot}/`))) {
      throw new Error(`Runner ${name} must remain inside the inspected private home/run root`)
    }
  }
  if (Number(process.versions.node.split('.')[0]) !== 24 || !fs.existsSync(mainEntry))
    throw new Error('Node24 and actual built Desktop are prerequisites')
  requirePixelRenderer()
}
export type VendorAttempt = {
  sequence: number
  provider: string
  model: string
  receiptId: string
  imageSha256: string[]
  mimeTypes: string[]
  requestSha256: string
  responseKind: 'pixels' | 'text' | 'rejected'
  outputSha256?: string
}
export function readVendorAttempts(
  run: SubscriptionImageRun,
  binding: ProviderBinding
): VendorAttempt[] {
  if (run.mode !== 'fixture')
    throw new Error('External fixture evidence is not real-subscription G8 evidence')
  const evidencePath = run.evidencePaths?.[binding.provider]
  if (!evidencePath) throw new Error('Physical proxy evidence path is missing')
  const ledger = readPrivateJson(evidencePath, 4 * 1024 * 1024) as {
    kind?: string
    runId?: string
    attempts?: VendorAttempt[]
  }
  if (
    ledger.kind !== 'evenfire-subscription-image-vendor-v1' ||
    ledger.runId !== run.runId ||
    !Array.isArray(ledger.attempts) ||
    ledger.attempts.length > 256
  )
    throw new Error('External vendor ledger does not belong to this run')
  for (const [index, row] of ledger.attempts.entries()) {
    if (
      row.sequence !== index + 1 ||
      row.provider !== binding.provider ||
      typeof row.model !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(row.receiptId) ||
      !Array.isArray(row.imageSha256) ||
      row.imageSha256.length > 20 ||
      row.imageSha256.some(value => !/^[a-f0-9]{64}$/.test(value)) ||
      !Array.isArray(row.mimeTypes) ||
      row.mimeTypes.length !== row.imageSha256.length ||
      !/^[a-f0-9]{64}$/.test(row.requestSha256) ||
      !['pixels', 'text', 'rejected'].includes(row.responseKind)
    ) {
      throw new Error('External vendor ledger has invalid bounded evidence')
    }
  }
  return ledger.attempts
}
type Fixtures = {
  electronApp: ElectronApplication
  appPage: Page
  subscriptionRun: SubscriptionImageRun
}
export const test = base.extend<Fixtures>({
  subscriptionRun: async ({}, use) => {
    await use(subscriptionImageRun)
  },
  electronApp: async ({ subscriptionRun: run }, use, testInfo) => {
    verifyPhysicalRunner(run)
    const launchRoot = fs.mkdtempSync(path.join(run.runRoot, 'desktop-'))
    fs.chmodSync(launchRoot, 0o700)
    const userData = path.join(launchRoot, 'user-data')
    fs.mkdirSync(userData, { mode: 0o700 })
    const runtimeConfig = path.join(launchRoot, 'runtime-config.json')
    const launchEnv: Record<string, string> = {}
    for (const name of [
      'PATH',
      'HOME',
      'USER',
      'LOGNAME',
      'LANG',
      'LC_ALL',
      'DISPLAY',
      'XDG_RUNTIME_DIR',
      'XAUTHORITY',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'XDG_DATA_HOME',
      'TMPDIR',
    ]) {
      if (process.env[name]) launchEnv[name] = process.env[name]!
    }
    Object.assign(launchEnv, {
      EXTERNAL_REST_API_BASE_URL: run.restUrl,
      RPC_PROXY_BASE_URL: run.rpcUrl,
      EVENFIRE_DEV_ISOLATION: '1',
      EVENFIRE_DEV_ISOLATION_RUN_DIR: launchRoot,
      EVENFIRE_DEV_ISOLATION_TARGET: run.runId,
      EVENFIRE_DEV_ISOLATION_PR: '806',
      EVENFIRE_DEV_ISOLATION_REST_URL: run.restUrl,
      EVENFIRE_DEV_ISOLATION_RPC_URL: run.rpcUrl,
      EVENFIRE_DEV_ISOLATION_APP_PATH: path.dirname(mainEntry),
      CLERUM_DESKTOP_CONFIG_PATH: runtimeConfig,
    })
    const app = await electron.launch({
      args: [`--user-data-dir=${userData}`, mainEntry],
      env: launchEnv,
      timeout: 30_000,
      recordVideo: { dir: testInfo.outputPath('video'), size: { width: 1280, height: 720 } },
    })
    try {
      const actual = await app.evaluate(({ app: desktopApp }) => ({
        pid: process.pid,
        uid: process.getuid?.(),
        userData: desktopApp.getPath('userData'),
        appPath: desktopApp.getAppPath(),
      }))
      expect(actual.pid).toBe(app.process().pid)
      expect(actual.uid).toBe(process.getuid!())
      expect(fs.realpathSync(actual.userData)).toBe(fs.realpathSync(userData))
      expect(fs.realpathSync(actual.appPath)).toBe(fs.realpathSync(path.dirname(mainEntry)))
      await use(app)
    } finally {
      await app.close()
    }
  },
  appPage: async ({ electronApp, subscriptionRun: run }, use) => {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const config = await page.evaluate(async () => {
      const state = await window.clerum.auth.getRuntimeConfigState()
      return {
        storagePath: state.storagePath,
        restUrl: state.currentConfig?.externalRestApiBaseUrl,
        rpcUrl: state.currentConfig?.rpcProxyBaseUrl,
      }
    })
    const actualUserData = await electronApp.evaluate(({ app: desktopApp }) =>
      desktopApp.getPath('userData')
    )
    expect(path.resolve(config.storagePath)).toBe(
      path.join(path.dirname(actualUserData), 'runtime-config.json')
    )
    expect(config.restUrl).toBe(run.restUrl)
    expect(config.rpcUrl).toBe(run.rpcUrl)
    const loginEmail = page.locator('#email-input')
    await expect(loginEmail).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('#password-input')).toBeVisible()
    await loginEmail.fill(process.env.E2E_SUBSCRIPTION_IMAGE_LOGIN_EMAIL!)
    await page.locator('#password-input').fill(process.env.E2E_SUBSCRIPTION_IMAGE_LOGIN_PASSWORD!)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(loginEmail).toHaveCount(0)
    await expect(page.getByTestId('nav-settings-menu')).toBeVisible({ timeout: 30_000 })
    try {
      await use(page)
    } finally {
      // End only the owned test session through UI; no shared session reset.
      if (!page.isClosed()) {
        const settings = page.getByTestId('nav-settings-menu')
        if ((await settings.getAttribute('aria-expanded')) !== 'true') await settings.click()
        await expect(settings).toHaveAttribute('aria-expanded', 'true')
        await page.getByTestId('logout-btn').click()
        await expect(page.locator('#email-input')).toBeVisible({ timeout: 20_000 })
      }
    }
  },
})
export { expect }
