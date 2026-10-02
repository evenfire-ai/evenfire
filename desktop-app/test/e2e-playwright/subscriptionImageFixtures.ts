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
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  MAIN_RECEIPT_FILES,
  observeLinuxRunner,
  observePrivateIsolation,
  readMainRecord as readMainAdmission,
  refusePlaintextSessionFiles,
  validateVendorLedger,
  verifyEncryptedKeyringFiles,
  verifyMainAdmission,
  verifyMountIsolation,
  verifyNativePrivateKeychain,
  verifySourceManifest,
} from '../../../scripts/tests/lib/subscription-image-runner-contract.mjs'
import { requirePixelRenderer } from './subscriptionImageChallenge.js'
import {
  type PrivateIsolationObservation,
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
      (stat.mode & 0o777) !== 0o600 ||
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
  return observeLinuxRunner().observation
}
export function verifyPhysicalRunner(run: SubscriptionImageRun): void {
  const observed = observeRunner()
  const receipt = readPrivateJson(run.runnerReceipt, 64 * 1024) as {
    kind?: string
    runId?: string
    repoRoot?: string
    gitHead?: string
    gitTree?: string
    inputManifestSha256?: string
    profile?: string
    context?: string
    restUrl?: string
    rpcUrl?: string
    bindings?: ProviderBinding[]
    observation?: RunnerObservation
    isolation?: PrivateIsolationObservation
    mainAdmissionFile?: string
    mainAdmissionSha256?: string
    sourceManifestSha256?: string
    admittedAt?: string
  }
  const sourceBytes = fs.readFileSync(path.join(repoRoot, 'subscription-image-source.json'))
  const source = JSON.parse(sourceBytes.toString('utf8'))
  verifySourceManifest(source, repoRoot)
  if (
    receipt.kind !== 'evenfire-subscription-image-runner-v2' ||
    receipt.runId !== run.runId ||
    receipt.repoRoot !== fs.realpathSync(repoRoot) ||
    receipt.gitHead !== source.gitHead ||
    receipt.gitTree !== source.gitTree ||
    receipt.inputManifestSha256 !== source.inputManifestSha256 ||
    receipt.profile !== run.profile ||
    receipt.context !== run.context ||
    receipt.restUrl !== run.restUrl ||
    receipt.rpcUrl !== run.rpcUrl ||
    !isDeepStrictEqual(receipt.bindings, run.bindings) ||
    !receipt.observation ||
    !receipt.isolation ||
    !receipt.mainAdmissionFile ||
    !receipt.sourceManifestSha256 ||
    path.dirname(receipt.mainAdmissionFile) !== '/runner-admission'
  ) {
    throw new Error('Physical runner receipt does not bind this run/source/stack/targets')
  }
  const physical = observeLinuxRunner()
  const mountIds = verifyMountIsolation(
    physical.mounts,
    observed.home,
    '/run/evenfire-e2e',
    '/runner-admission'
  )
  const actualIsolation = observePrivateIsolation(
    receipt.isolation,
    observed,
    process.env,
    run.runRoot,
    mountIds
  )
  verifyRunnerObservation(
    receipt.observation,
    observed,
    process.env,
    receipt.isolation,
    actualIsolation
  )
  const mainRecord = readMainAdmission(receipt.mainAdmissionFile)
  const receipts = {
    inspect: readMainAdmission(`/runner-admission/${MAIN_RECEIPT_FILES.inspect}`),
    stack: readMainAdmission(`/runner-admission/${MAIN_RECEIPT_FILES.stack}`),
    portForwards: readMainAdmission(`/runner-admission/${MAIN_RECEIPT_FILES.portForwards}`),
  }
  if (
    receipt.sourceManifestSha256 !== sha256(sourceBytes) ||
    receipt.mainAdmissionSha256 !== mainRecord.sha256
  )
    throw new Error('Sealed source/main admission changed')
  const mainAdmission = mainRecord.value
  if (
    !receipt.admittedAt ||
    !Number.isFinite(Date.parse(receipt.admittedAt)) ||
    Date.parse(receipt.admittedAt) < Date.parse(mainAdmission.runtime.createdAt) ||
    Date.parse(receipt.admittedAt) - Date.parse(mainAdmission.runtime.createdAt) > 600_000
  )
    throw new Error('Runner was not admitted from a fresh container')
  verifyMainAdmission(
    mainAdmission,
    physical,
    {
      gitHead: source.gitHead,
      gitTree: source.gitTree,
      inputManifestSha256: source.inputManifestSha256,
      manifestSha256: receipt.sourceManifestSha256,
    },
    repoRoot,
    process.env,
    'verify',
    receipts
  )
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
  responseKind: 'pixels' | 'text' | 'rejected' | 'tool_calls'
  outputSha256?: string
  journey?: 'tool-screenshot' | 'gfs-image'
  stage?: 'prepare' | 'capture' | 'read' | 'pixels'
  toolCalls?: Array<{
    id: string
    name: 'shell_exec' | 'desktop_screenshot' | 'clerum__gfs_read'
    argumentsSha256: string
  }>
  toolOutputs?: Array<{
    id: string
    outputSha256: string
    resource?: { kind: 'gfs'; drive: string; resourceId: string; version: number; gfsUri: string }
  }>
  referencedFiles?: Array<{
    referenceId: string
    drive: string
    resourceId: string
    version: number
    availability: 'available'
    byteLength: number
  }>
  receivedImageDigests?: string[]
  receivedImageOrder?: string[]
  decodedPixels?: Array<{ width: number; height: number }>
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
  if (!Array.isArray(ledger.attempts))
    throw new Error('External vendor ledger does not belong to this run')
  validateVendorLedger(ledger, run.runId, binding)
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
    verifyNativePrivateKeychain(repoRoot, process.env)
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
      'DBUS_SESSION_BUS_ADDRESS',
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
      recordVideo: {
        dir: testInfo.outputPath('video'),
        size: { width: 1280, height: 720 },
      },
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
    await expect(page.getByTestId('nav-settings-menu')).toBeVisible({
      timeout: 30_000,
    })
    verifyPhysicalRunner(run)
    verifyEncryptedKeyringFiles(process.env, process.getuid!())
    refusePlaintextSessionFiles([actualUserData, path.join(process.env.HOME!, '.evenfire')])
    try {
      await use(page)
    } finally {
      try {
        verifyPhysicalRunner(run)
        verifyEncryptedKeyringFiles(process.env, process.getuid!())
        refusePlaintextSessionFiles([actualUserData, path.join(process.env.HOME!, '.evenfire')])
      } finally {
        // End only the owned test session through UI; no shared session reset.
        if (!page.isClosed()) {
          const settings = page.getByTestId('nav-settings-menu')
          if ((await settings.getAttribute('aria-expanded')) !== 'true') await settings.click()
          await expect(settings).toHaveAttribute('aria-expanded', 'true')
          await page.getByTestId('logout-btn').click()
          await expect(page.locator('#email-input')).toBeVisible({
            timeout: 20_000,
          })
        }
      }
    }
  },
})
export { expect }
