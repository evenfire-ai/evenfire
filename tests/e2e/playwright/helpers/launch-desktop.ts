import { type ElectronApplication, _electron as electron, test } from '@playwright/test'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

// E2E_GUARDIAN_IPC_FLOW: the Desktop app and its session live in the main
// process; this helper starts and inspects it through Playwright's Electron
// API, so there is no renderer HTTP request to await.
const DESKTOP_APP_DIR = path.resolve(__dirname, '../../../../desktop-app')
const MAIN_JS = path.join(DESKTOP_APP_DIR, 'dist/main.js')
const LOOPBACK_V4 = ['127', '0', '0', '1'].join('.')
const PROFILE_EXTERNAL_API_OFFSET = 91
const PROFILE_RPC_PROXY_OFFSET = 94

function desktopElectronExecutable(): string {
  const requireFromDesktop = createRequire(path.join(DESKTOP_APP_DIR, 'package.json'))
  return requireFromDesktop('electron') as string
}

function originWithPort(baseUrl: string, port: number): string {
  const url = new URL(baseUrl)
  url.port = String(port)
  return url.origin
}

function profileOwnedEndpoints(): { externalApiUrl: string; rpcProxyUrl: string } {
  const explicitExternal =
    process.env.EXTERNAL_REST_API_BASE_URL || process.env.EXTERNAL_REST_API_URL
  const explicitRpc = process.env.RPC_PROXY_BASE_URL || process.env.RPC_PROXY_URL
  if (explicitExternal) {
    const externalPort = Number(new URL(explicitExternal).port)
    const rpcProxyUrl =
      explicitRpc ||
      (Number.isFinite(externalPort) && externalPort > 0
        ? originWithPort(
            explicitExternal,
            externalPort + (PROFILE_RPC_PROXY_OFFSET - PROFILE_EXTERNAL_API_OFFSET)
          )
        : `http://${LOOPBACK_V4}:8094`)
    return { externalApiUrl: explicitExternal, rpcProxyUrl }
  }

  const controlUiUrl = process.env.CONTROL_UI_URL
  if (controlUiUrl) {
    const controlUi = new URL(controlUiUrl)
    const portBase = Number(controlUi.port)
    if (Number.isFinite(portBase) && portBase > 0) {
      return {
        externalApiUrl: originWithPort(controlUiUrl, portBase + PROFILE_EXTERNAL_API_OFFSET),
        rpcProxyUrl:
          explicitRpc || originWithPort(controlUiUrl, portBase + PROFILE_RPC_PROXY_OFFSET),
      }
    }
  }

  throw new Error(
    'Desktop Codex guardians need EXTERNAL_REST_API_URL or CONTROL_UI_URL from the branch-owned profile'
  )
}

// Desktop dev-isolation contract (`desktop-app/src/devIsolation.ts`). An isolated
// run never uses keytar, so no session reaches the shared `Evenfire` login
// Keychain account. Each launch gets its own run directory, and the app derives
// its name from that directory's slug, so the `<appName> Safe Storage` key that
// `safeStorage` creates is new for every launch and no existing item is read.
const DEV_ISOLATION_ENV = {
  enable: 'EVENFIRE_DEV_ISOLATION',
  runDir: 'EVENFIRE_DEV_ISOLATION_RUN_DIR',
  restUrl: 'EVENFIRE_DEV_ISOLATION_REST_URL',
  rpcUrl: 'EVENFIRE_DEV_ISOLATION_RPC_URL',
  target: 'EVENFIRE_DEV_ISOLATION_TARGET',
  appPath: 'EVENFIRE_DEV_ISOLATION_APP_PATH',
} as const

export async function launchDesktopApp(): Promise<ElectronApplication> {
  const { externalApiUrl, rpcProxyUrl } = profileOwnedEndpoints()
  const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-approved-tools-')))
  const userDataDir = path.join(runDir, 'user-data')
  const configPath = path.join(runDir, 'runtime-config.json')
  fs.mkdirSync(userDataDir, { mode: 0o700 })
  const compiledAppPath = fs.realpathSync(path.dirname(MAIN_JS))
  const executablePath = desktopElectronExecutable()

  let app: ElectronApplication
  try {
    app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDir}`, MAIN_JS],
      cwd: DESKTOP_APP_DIR,
      // Playwright records the Desktop window itself. The directory is the
      // test's own output path (under the config's `outputDir`, the lane's
      // artifacts directory), never `runDir`: that directory is deleted when the
      // app closes (below), which would take the video with it. Every caller is
      // a test body, so `test.info()` exists here.
      recordVideo: { dir: test.info().outputPath('desktop-video') },
      env: {
        ...process.env,
        [DEV_ISOLATION_ENV.enable]: '1',
        [DEV_ISOLATION_ENV.runDir]: runDir,
        [DEV_ISOLATION_ENV.restUrl]: externalApiUrl,
        [DEV_ISOLATION_ENV.rpcUrl]: rpcProxyUrl,
        [DEV_ISOLATION_ENV.target]: path.basename(runDir),
        [DEV_ISOLATION_ENV.appPath]: compiledAppPath,
        EXTERNAL_REST_API_BASE_URL: externalApiUrl,
        RPC_PROXY_BASE_URL: rpcProxyUrl,
        CLERUM_DESKTOP_CONFIG_PATH: configPath,
        EVENFIRE_RENDERER_URL: '',
        ELECTRON_RENDERER_URL: '',
        NODE_ENV: 'test',
      },
    })
  } catch (error) {
    fs.rmSync(runDir, { recursive: true, force: true })
    throw error
  }
  app.on('close', () => fs.rmSync(runDir, { recursive: true, force: true }))

  // Public process identities only. The app refuses a mismatched isolated
  // launch on its own; these checks prove isolation is on at all, that this
  // checkout's build and Electron run, and that the profile is the new one.
  const runtime = await app.evaluate(({ app: electronApp }) => ({
    name: electronApp.getName(),
    userData: electronApp.getPath('userData'),
    appPath: electronApp.getAppPath(),
    executablePath: process.execPath,
    isPackaged: electronApp.isPackaged,
  }))
  const mismatches = [
    runtime.name.startsWith('Evenfire ') ? null : `app name ${runtime.name}`,
    fs.realpathSync(runtime.userData) === fs.realpathSync(userDataDir) ? null : 'userData',
    fs.realpathSync(runtime.appPath) === compiledAppPath ? null : 'app path',
    fs.realpathSync(runtime.executablePath) === fs.realpathSync(executablePath)
      ? null
      : 'Electron executable',
    runtime.isPackaged ? 'packaged app' : null,
  ].filter(Boolean)
  if (mismatches.length > 0) {
    await app.close()
    throw new Error(`Desktop did not start dev-isolated: ${mismatches.join(', ')}`)
  }
  return app
}
