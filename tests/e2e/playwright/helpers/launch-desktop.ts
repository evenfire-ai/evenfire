import { type ElectronApplication, _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

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

function writeIsolatedRuntimeConfig(
  configPath: string,
  externalApiUrl: string,
  rpcProxyUrl: string
): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        appName: 'Evenfire Codex subscription',
        externalRestApiBaseUrl: externalApiUrl,
        rpcProxyBaseUrl: rpcProxyUrl,
      },
      null,
      2
    )}\n`,
    { encoding: 'utf8', mode: 0o600 }
  )
}

export async function launchDesktopApp(): Promise<ElectronApplication> {
  const { externalApiUrl, rpcProxyUrl } = profileOwnedEndpoints()
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-subscription-electron-'))
  const runtimeConfigPath = path.join(userDataDir, 'e2e-runtime-config.json')
  writeIsolatedRuntimeConfig(runtimeConfigPath, externalApiUrl, rpcProxyUrl)

  let app: ElectronApplication
  try {
    app = await electron.launch({
      executablePath: desktopElectronExecutable(),
      args: [`--user-data-dir=${userDataDir}`, MAIN_JS],
      cwd: DESKTOP_APP_DIR,
      env: {
        ...process.env,
        EXTERNAL_REST_API_BASE_URL: externalApiUrl,
        RPC_PROXY_BASE_URL: rpcProxyUrl,
        CLERUM_DESKTOP_CONFIG_PATH: runtimeConfigPath,
        EVENFIRE_RENDERER_URL: '',
        ELECTRON_RENDERER_URL: '',
        NODE_ENV: 'test',
      },
    })
  } catch (error) {
    fs.rmSync(userDataDir, { recursive: true, force: true })
    throw error
  }

  const actualUserDataDir = await app.evaluate(({ app: electronApp }) =>
    electronApp.getPath('userData')
  )
  if (fs.realpathSync(actualUserDataDir) !== fs.realpathSync(userDataDir)) {
    await app.close()
    throw new Error(
      `Electron did not honor the isolated user-data-dir: expected ${userDataDir}, got ${actualUserDataDir}`
    )
  }

  app.on('close', () => fs.rmSync(userDataDir, { recursive: true, force: true }))
  return app
}
