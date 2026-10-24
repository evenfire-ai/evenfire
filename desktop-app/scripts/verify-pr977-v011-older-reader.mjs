import { chromium } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const keytar = require('keytar')
const {
  clearPendingExternalLogoutIfUnchanged,
  readPendingExternalLogoutMarker,
  recordPendingExternalLogout,
} = require('../dist/pendingExternalLogout.js')
const {
  sessionPersistenceCandidateHash,
  readSessionPersistenceJournal,
} = require('../dist/sessionPersistenceJournal.js')

const SERVICE = 'Evenfire'
const REST_URL = 'http://127.0.0.1:8091'
const RPC_URL = 'http://127.0.0.1:8094'
const EMAIL = 'compat-v011@example.test'
const PASSWORD = 'Synthetic-only-compatibility-password'
const CANDIDATE_TOKEN = 'source-b-candidate-bytes'
const USER = {
  id: 'crash-worker-account-b',
  email: EMAIL,
  name: 'Synthetic v0.11 compatibility user',
  picture: null,
  teamId: 'synthetic-team',
  teamName: 'Synthetic team',
  role: 'member',
}
const PACKAGE_SHA256 = '9101d2a7c2fc49c6f64c15fc889523a8d830dd8779278dc69256317c6bbc9f41'
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '..')
const COMPATIBILITY_TIMEOUT_MS = 45_000

class InconclusiveError extends Error {
  constructor(category) {
    super(category)
    this.name = 'InconclusiveError'
    this.category = category
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function resolveEnvironmentKey(restUrl, rpcUrl) {
  const restOrigin = new URL(restUrl).origin
  const rpcOrigin = new URL(rpcUrl).origin
  const identity = `${restOrigin}|rpc=${rpcOrigin}`
  const slug = `${restOrigin}_${rpcOrigin}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  return `${slug || 'env'}-${sha256(identity).slice(0, 12)}`
}

function assertHostedWindowsRunner() {
  if (
    process.platform !== 'win32' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_OS !== 'Windows' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
  ) {
    throw new InconclusiveError('requires-fresh-github-hosted-windows-runner')
  }
  if (!process.env.RUNNER_TEMP || !process.env.USERPROFILE) {
    throw new InconclusiveError('runner-profile-identity-unavailable')
  }
  const sidOutput = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const sid = sidOutput.match(/S-1-(?:\d+-)+\d+/)?.[0]
  if (
    !sid ||
    path.resolve(os.homedir()).toLowerCase() !== path.resolve(process.env.USERPROFILE).toLowerCase()
  ) {
    throw new InconclusiveError('windows-principal-profile-could-not-be-verified')
  }
  return { sid, userProfile: path.resolve(process.env.USERPROFILE) }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

function closeServer(server) {
  return new Promise(resolve => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
  })
}

function writeJson(response, status, body) {
  response.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(body))
}

async function readJsonRequest(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 8 * 1024) throw new Error('synthetic-request-body-too-large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function getFreePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new InconclusiveError('debug-port-unavailable')
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  return address.port
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function waitFor(predicate, category, timeoutMs = COMPATIBILITY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(200)
  }
  throw new InconclusiveError(category)
}

async function credentialState(accounts) {
  const present = []
  for (const account of accounts) {
    const value = await keytar.getPassword(SERVICE, account)
    if (value !== null) present.push({ account, matchesSynthetic: value === CANDIDATE_TOKEN })
  }
  return present
}

function appEnvironment({
  appDataDirectory,
  localAppDataDirectory,
  tempDirectory,
  userProfile,
  systemRoot = process.env.SystemRoot ?? process.env.WINDIR,
}) {
  if (!systemRoot) throw new InconclusiveError('windows-system-root-unavailable')
  const environment = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: path.join(systemRoot, 'System32'),
    COMSPEC: path.join(systemRoot, 'System32', 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    TEMP: tempDirectory,
    TMP: tempDirectory,
    USERPROFILE: userProfile,
    APPDATA: appDataDirectory,
    LOCALAPPDATA: localAppDataDirectory,
    EXTERNAL_REST_API_BASE_URL: REST_URL,
    RPC_PROXY_BASE_URL: RPC_URL,
    DESKTOP_APP_NAME: 'Evenfire',
  }
  assertSanitizedChildEnvironment(environment)
  return environment
}

function assertSanitizedChildEnvironment(environment) {
  const forbidden = Object.keys(environment).some(
    name =>
      /^(ACTIONS_|GITHUB_|RUNNER_)/.test(name) ||
      ['CI', 'ELECTRON_RUN_AS_NODE', 'EVENFIRE_RENDERER_URL', 'NODE_OPTIONS'].includes(name)
  )
  if (forbidden) throw new InconclusiveError('packaged-child-environment-not-sanitized')
}

function runChildEnvironmentContractSelfTest() {
  const sentinels = ['ACTIONS_RUNTIME_TOKEN', 'GITHUB_TOKEN', 'RUNNER_TRACKING_ID', 'NODE_OPTIONS']
  const previous = new Map(sentinels.map(name => [name, process.env[name]]))
  try {
    for (const name of sentinels) process.env[name] = 'synthetic-runner-secret-sentinel'
    const environment = appEnvironment({
      appDataDirectory: 'C:\\runner-temp\\task\\appdata',
      localAppDataDirectory: 'C:\\runner-temp\\task\\local-appdata',
      tempDirectory: 'C:\\runner-temp\\task\\temp',
      userProfile: 'C:\\Users\\runner',
      systemRoot: 'C:\\Windows',
    })
    const allowedKeys = new Set([
      'SystemRoot',
      'WINDIR',
      'PATH',
      'COMSPEC',
      'PATHEXT',
      'TEMP',
      'TMP',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'EXTERNAL_REST_API_BASE_URL',
      'RPC_PROXY_BASE_URL',
      'DESKTOP_APP_NAME',
    ])
    if (
      Object.keys(environment).length !== allowedKeys.size ||
      Object.keys(environment).some(name => !allowedKeys.has(name))
    ) {
      throw new Error('child-environment-allowlist-regression')
    }
    if (sentinels.some(name => Object.hasOwn(environment, name))) {
      throw new Error('child-environment-runner-metadata-leak')
    }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  console.log('PASS: packaged child environment uses the restricted Windows-runtime allowlist')
}

async function waitForDebugEndpoint(port, child, getSpawnError) {
  const endpoint = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    if (getSpawnError()) throw new InconclusiveError('packaged-binary-process-launch-failed')
    if (child.exitCode !== null)
      throw new InconclusiveError('packaged-binary-exited-before-renderer')
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      })
      return response.ok
    } catch {
      return false
    }
  }, 'packaged-renderer-debug-endpoint-not-available')
  return endpoint
}

async function waitForApplicationPage(browser) {
  let selectedPage = null
  await waitFor(async () => {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        try {
          if ((await page.locator('#root').count()) > 0) {
            selectedPage = page
            return true
          }
        } catch {
          // A target can close while Chromium is constructing the renderer page.
        }
      }
    }
    return false
  }, 'packaged-renderer-root-not-ready')
  if (!selectedPage) throw new InconclusiveError('packaged-renderer-page-missing')
  await selectedPage
    .locator('#root')
    .waitFor({ state: 'attached', timeout: COMPATIBILITY_TIMEOUT_MS })
  return selectedPage
}

async function readUiState(page) {
  return page.evaluate(() => {
    const email = document.querySelector('#email-input')
    const password = document.querySelector('#password-input')
    const body = document.body?.innerText ?? ''
    return {
      loginForm: Boolean(email && password),
      authenticatedSurface:
        !email &&
        !password &&
        (Array.from(document.querySelectorAll('button')).some(
          button => button.innerText.trim() === 'New chat'
        ) ||
          body.includes('Nothing open')),
    }
  })
}

async function waitForUiState(page, state, category, timeoutMs = COMPATIBILITY_TIMEOUT_MS) {
  await waitFor(
    async () => {
      const actual = await readUiState(page)
      return actual[state]
    },
    category,
    timeoutMs
  )
}

async function launchPackagedBinary(executable, userDataDirectory, profile) {
  const port = await getFreePort()
  const child = spawn(
    executable,
    [
      `--user-data-dir=${userDataDirectory}`,
      '--evenfire-desktop-dev-package',
      `--remote-debugging-address=127.0.0.1`,
      `--remote-debugging-port=${port}`,
      '--disable-gpu',
      '--no-first-run',
    ],
    { cwd: profile.taskRoot, env: appEnvironment(profile), stdio: 'ignore', windowsHide: true }
  )
  let spawnError = null
  child.once('error', error => {
    spawnError = error.code || 'spawn-error'
  })
  let browser
  try {
    const endpoint = await waitForDebugEndpoint(port, child, () => spawnError)
    browser = await chromium.connectOverCDP(endpoint, { timeout: COMPATIBILITY_TIMEOUT_MS })
    const page = await waitForApplicationPage(browser)
    return { child, browser, page }
  } catch (error) {
    await stopPackagedBinary({ child, browser })
    if (error instanceof InconclusiveError) throw error
    throw new InconclusiveError('packaged-electron-cdp-connection-failed')
  }
}

async function stopPackagedBinary(instance) {
  if (!instance) return
  try {
    await instance.browser?.close()
  } catch {
    // The process tree below is the authoritative stop operation for this owned launch.
  }
  const child = instance.child
  if (child && child.exitCode === null && child.pid) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 15_000,
      })
    } catch {
      if (child.exitCode === null)
        throw new InconclusiveError('owned-packaged-process-tree-did-not-stop')
    }
    if (child.exitCode === null) {
      await Promise.race([once(child, 'close'), delay(10_000)]).catch(() => undefined)
      if (child.exitCode === null)
        throw new InconclusiveError('owned-packaged-process-did-not-exit')
    }
  }
}

async function waitForIsolatedElectronProfile(userDataDirectory) {
  await waitFor(() => {
    try {
      const localState = path.join(userDataDirectory, 'Local State')
      return fs.statSync(localState).isFile()
    } catch {
      return false
    }
  }, 'packaged-binary-did-not-use-the-isolated-user-data-profile')
}

async function submitSyntheticLogin(page, loginRequests) {
  await waitForUiState(page, 'loginForm', 'older-binary-login-form-not-reached')
  await page.locator('#email-input').fill(EMAIL)
  await page.locator('#password-input').fill(PASSWORD)
  const before = loginRequests.length
  await page.locator('form.auth-form-stack button[type="submit"]').click()
  await waitFor(
    () => loginRequests.length > before,
    'synthetic-password-login-endpoint-not-reached'
  )
  await waitForUiState(page, 'authenticatedSurface', 'older-binary-login-did-not-authenticate')
}

function readV2AcceptancePendingState(profileDirectory, envKey) {
  const authorityDirectory = path.join(profileDirectory, 'authority')
  const authorityPath = path.join(authorityDirectory, `session-authority-${sha256(envKey)}`)
  const markerPath = path.join(profileDirectory, `pending-external-logout-${sha256(envKey)}`)
  const journalPath = path.join(profileDirectory, `session-persistence-journal-${sha256(envKey)}`)
  const rawRecord = fs.readFileSync(authorityPath, 'utf8')
  const record = JSON.parse(rawRecord)
  const rawMarker = fs.readFileSync(markerPath, 'utf8')
  const marker = JSON.parse(rawMarker)
  const journal = readSessionPersistenceJournal(profileDirectory, envKey)
  const journalBytes = fs.readFileSync(journalPath)
  const journalDigest = sha256(journalBytes)
  const candidate = record.candidates?.find(
    item => item.transactionId === record.projectionIntent?.candidateTransactionId
  )
  if (
    record.version !== 2 ||
    rawRecord.includes(CANDIDATE_TOKEN) ||
    record.projectionIntent?.operationId !== marker.operationId ||
    record.projectionIntent?.stagedMarker?.revision !== marker.revision ||
    marker.version !== 2 ||
    marker.intent !== 'acceptance-pending' ||
    marker.purpose !== 'candidate-acceptance' ||
    marker.expectedAuthorityRevision !== record.projectionIntent.baseAuthorityRevision ||
    !candidate ||
    candidate.phase !== 'verified' ||
    candidate.candidateHash !== sessionPersistenceCandidateHash(CANDIDATE_TOKEN) ||
    !journal ||
    record.projectionIntent.legacyJournalReceipt?.schemaVersion !== 1 ||
    record.projectionIntent.legacyJournalReceipt?.digest !== journalDigest ||
    record.projectionIntent.legacyJournalReceipt?.byteLength !== journalBytes.length ||
    record.projectionIntent.legacyJournalReceipt?.revision !== `v0-sha256:${journalDigest}`
  ) {
    throw new InconclusiveError('current-v2-repository-did-not-produce-matching-pending-state')
  }
  return {
    markerRevision: marker.revision,
    candidateHash: candidate.candidateHash,
    candidatePhase: candidate.phase,
    journalDigest,
    projectionIntentOperationId: marker.operationId,
  }
}

async function main() {
  const principal = assertHostedWindowsRunner()
  const executable = process.env.EVENFIRE_V011_EXE
  const executableProductVersion = process.env.EVENFIRE_V011_PRODUCT_VERSION
  if (
    !executable ||
    !fs.existsSync(executable) ||
    !executableProductVersion?.startsWith('0.11.0')
  ) {
    throw new InconclusiveError('verified-v011-packaged-executable-not-available')
  }
  const packageHash = execFileSync('certutil.exe', ['-hashfile', executable, 'SHA256'], {
    encoding: 'utf8',
    windowsHide: true,
  })
    .match(/[0-9a-f]{64}/i)?.[0]
    ?.toLowerCase()
  if (!packageHash) throw new InconclusiveError('packaged-executable-integrity-not-readable')

  const envKey = resolveEnvironmentKey(REST_URL, RPC_URL)
  const scopedAccount = `session-token::${envKey}`
  const accounts = [scopedAccount, 'session-token']
  let preexisting
  try {
    preexisting = await credentialState(accounts)
  } catch {
    throw new InconclusiveError('isolated-windows-credential-manager-unavailable')
  }
  if (preexisting.length !== 0) {
    throw new InconclusiveError('fresh-runner-evenfire-credential-selector-was-not-empty')
  }

  const runnerTemp = path.resolve(process.env.RUNNER_TEMP)
  const taskRoot = fs.mkdtempSync(path.join(runnerTemp, 'pr977-v011-older-reader-'))
  const appDataDirectory = path.join(taskRoot, 'appdata')
  const userDataDirectory = path.join(appDataDirectory, 'Evenfire')
  const localAppDataDirectory = path.join(taskRoot, 'local-appdata')
  const tempDirectory = path.join(taskRoot, 'temp')
  fs.mkdirSync(userDataDirectory, { recursive: true })
  fs.mkdirSync(localAppDataDirectory, { recursive: true })
  fs.mkdirSync(tempDirectory, { recursive: true })
  const childProfile = {
    appDataDirectory,
    localAppDataDirectory,
    tempDirectory,
    taskRoot,
    userProfile: principal.userProfile,
  }
  if (
    !path
      .resolve(userDataDirectory)
      .toLowerCase()
      .startsWith(`${runnerTemp.toLowerCase()}${path.sep.toLowerCase()}`)
  ) {
    throw new InconclusiveError('synthetic-profile-escaped-runner-temp')
  }

  const calls = []
  const loginRequests = []
  let responseMode = 'allow-synthetic-token'
  const apiServer = http.createServer(async (request, response) => {
    const remoteAddress = request.socket.remoteAddress ?? ''
    if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::ffff:127.0.0.1') {
      writeJson(response, 403, { error: 'loopback-only' })
      return
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      })
      response.end()
      return
    }
    const pathname = new URL(request.url ?? '/', REST_URL).pathname
    if (request.method === 'POST' && pathname === '/api/v1/auth/password-login') {
      let body
      try {
        body = await readJsonRequest(request)
      } catch {
        writeJson(response, 400, { error: 'synthetic-login-request-invalid' })
        return
      }
      if (body.email !== EMAIL || body.password !== PASSWORD) {
        writeJson(response, 401, { error: 'synthetic-login-rejected' })
        return
      }
      loginRequests.push({ at: Date.now() })
      writeJson(response, 200, { token: CANDIDATE_TOKEN, me: USER })
      return
    }
    if (request.method === 'GET' && pathname === '/api/v1/me') {
      const authorization = request.headers.authorization ?? ''
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      const tokenMatches = token === CANDIDATE_TOKEN
      calls.push({ mode: responseMode, tokenMatches, tokenDigest: token ? sha256(token) : null })
      if (responseMode === 'allow-synthetic-token' && tokenMatches) {
        writeJson(response, 200, USER)
      } else {
        writeJson(response, 401, { error: 'synthetic-session-denied' })
      }
      return
    }
    if (request.method === 'GET' && pathname === '/api/v1/desktop/release') {
      writeJson(response, 200, {
        releaseId: 'synthetic-v011-compatibility-test',
        desktopVersion: '0.11.0',
        minimumDesktopVersion: '0.1.252',
        releaseTag: 'v0.11.0',
        releaseUrl: 'http://127.0.0.1:8091/synthetic-release',
      })
      return
    }
    if (request.method === 'GET' && pathname.endsWith('/health')) {
      writeJson(response, 200, { status: 'ok' })
      return
    }
    if (request.method === 'GET' && pathname === '/api/v1/me/teams') {
      writeJson(response, 200, { currentTeamId: USER.teamId, items: [] })
      return
    }
    if (request.method === 'GET' && pathname === '/api/v1/desktop/environment') {
      writeJson(response, 404, { error: 'not-configured' })
      return
    }
    writeJson(response, 404, { error: 'synthetic-endpoint-not-found' })
  })
  const rpcServer = http.createServer((_request, response) =>
    writeJson(response, 200, { ok: true })
  )
  let appInstance = null
  let result = null

  try {
    try {
      await listen(apiServer, 8091)
      await listen(rpcServer, 8094)
    } catch {
      throw new InconclusiveError('synthetic-local-endpoint-port-unavailable')
    }

    appInstance = await launchPackagedBinary(executable, userDataDirectory, childProfile)
    await waitForIsolatedElectronProfile(userDataDirectory)
    await submitSyntheticLogin(appInstance.page, loginRequests)
    const initialCredential = await waitFor(async () => {
      const found = await credentialState(accounts)
      if (found.length === 1 && found[0].matchesSynthetic) return found
      return false
    }, 'v011-password-login-did-not-persist-to-isolated-keytar')
    await stopPackagedBinary(appInstance)
    appInstance = null

    responseMode = 'allow-synthetic-token'
    const baselineStart = calls.length
    appInstance = await launchPackagedBinary(executable, userDataDirectory, childProfile)
    await waitForIsolatedElectronProfile(userDataDirectory)
    await waitFor(
      () => calls.slice(baselineStart).some(call => call.tokenMatches),
      'v011-cold-restart-did-not-read-synthetic-keytar-credential'
    )
    await waitForUiState(
      appInstance.page,
      'authenticatedSurface',
      'v011-baseline-restart-not-authenticated'
    )
    const baselineCredential = await credentialState(accounts)
    await stopPackagedBinary(appInstance)
    appInstance = null

    recordPendingExternalLogout(userDataDirectory, envKey)
    const logoutMarker = readPendingExternalLogoutMarker(userDataDirectory, envKey)
    if (logoutMarker?.intent?.intent !== 'logout-pending' || !logoutMarker.revision) {
      throw new InconclusiveError('current-lp-marker-writer-did-not-publish-durable-revision')
    }
    responseMode = 'deny-synthetic-token'
    const lpStart = calls.length
    appInstance = await launchPackagedBinary(executable, userDataDirectory, childProfile)
    await waitFor(async () => {
      const ui = await readUiState(appInstance.page)
      return ui.loginForm || ui.authenticatedSurface || calls.length > lpStart
    }, 'v011-lp-startup-did-not-reach-a-restore-decision')
    await delay(10_000)
    const lpCalls = calls.slice(lpStart)
    const lpCredentialAfter = await credentialState(accounts)
    const lpUi = await readUiState(appInstance.page)
    if (!lpUi.loginForm && !lpUi.authenticatedSurface) {
      throw new InconclusiveError('v011-lp-startup-did-not-reach-a-stable-authentication-surface')
    }
    await stopPackagedBinary(appInstance)
    appInstance = null

    const currentLp = readPendingExternalLogoutMarker(userDataDirectory, envKey)
    if (currentLp && !clearPendingExternalLogoutIfUnchanged(userDataDirectory, envKey, currentLp)) {
      throw new InconclusiveError('task-owned-lp-marker-could-not-be-cleared-for-next-case')
    }
    const authorityDirectory = path.join(userDataDirectory, 'authority')
    const journalPath = path.join(
      userDataDirectory,
      `session-persistence-journal-${sha256(envKey)}`
    )
    fs.rmSync(authorityDirectory, { recursive: true, force: true })
    fs.rmSync(journalPath, { force: true })

    responseMode = 'allow-synthetic-token'
    const existingCredential = await credentialState(accounts)
    if (existingCredential.length === 0) {
      appInstance = await launchPackagedBinary(executable, userDataDirectory, childProfile)
      await submitSyntheticLogin(appInstance.page, loginRequests)
      await waitFor(async () => {
        const found = await credentialState(accounts)
        return found.length === 1 && found[0].matchesSynthetic
      }, 'v011-could-not-reseed-synthetic-credential-for-v2-case')
      await stopPackagedBinary(appInstance)
      appInstance = null
    } else if (existingCredential.length !== 1 || !existingCredential[0].matchesSynthetic) {
      throw new InconclusiveError('v011-lp-case-left-an-unexpected-credential-selector-state')
    }

    fs.mkdirSync(authorityDirectory, { recursive: true })
    const crashWorker = path.join(
      DESKTOP_DIRECTORY,
      'src',
      '__tests__',
      'sessionAuthorityRecordCrashWorker.cjs'
    )
    const writer = spawn(
      process.execPath,
      [crashWorker, authorityDirectory, envKey, 'produce', 'after-marker'],
      { cwd: DESKTOP_DIRECTORY, stdio: 'ignore', windowsHide: true }
    )
    const [writerExitCode] = await once(writer, 'close')
    if (writerExitCode !== 73) {
      throw new InconclusiveError(`current-v2-repository-writer-exited-${writerExitCode}`)
    }
    const pendingState = readV2AcceptancePendingState(userDataDirectory, envKey)
    const v2Before = await credentialState(accounts)
    if (v2Before.length !== 1 || !v2Before[0].matchesSynthetic) {
      throw new InconclusiveError('synthetic-denied-token-missing-before-v2-restore')
    }

    responseMode = 'deny-synthetic-token'
    const v2Start = calls.length
    appInstance = await launchPackagedBinary(executable, userDataDirectory, childProfile)
    await waitFor(async () => {
      const ui = await readUiState(appInstance.page)
      return ui.loginForm || ui.authenticatedSurface || calls.length > v2Start
    }, 'v011-v2-startup-did-not-reach-a-restore-decision')
    await delay(10_000)
    const v2Calls = calls.slice(v2Start)
    const v2CredentialAfter = await credentialState(accounts)
    const v2Ui = await readUiState(appInstance.page)
    if (!v2Ui.loginForm && !v2Ui.authenticatedSurface) {
      throw new InconclusiveError('v011-v2-startup-did-not-reach-a-stable-authentication-surface')
    }
    await stopPackagedBinary(appInstance)
    appInstance = null

    const lpDeniedTokenGetMe = lpCalls.some(call => call.tokenMatches)
    const v2DeniedTokenGetMe = v2Calls.some(call => call.tokenMatches)
    const lpAuthenticated = lpUi.authenticatedSurface
    const v2Authenticated = v2Ui.authenticatedSurface
    const v2CredentialChanged =
      v2CredentialAfter.length !== 1 || !v2CredentialAfter[0].matchesSynthetic
    const unsafe =
      lpDeniedTokenGetMe ||
      lpAuthenticated ||
      v2DeniedTokenGetMe ||
      v2Authenticated ||
      v2CredentialChanged

    result = {
      status: unsafe ? 'UNSAFE_OLDER_READER_BEHAVIOR' : 'PASS_FOR_TESTED_STATES_ONLY',
      runner: {
        image: process.env.ImageOS ?? null,
        version: process.env.ImageVersion ?? null,
        environment: process.env.RUNNER_ENVIRONMENT,
        workflowSha: process.env.GITHUB_SHA ?? null,
        workflowRunId: process.env.GITHUB_RUN_ID ?? null,
        principalSid: principal.sid,
        userProfile: principal.userProfile,
      },
      package: {
        version: '0.11.0',
        assetSha256: PACKAGE_SHA256,
        executableSha256: packageHash,
        executableProductVersion,
      },
      isolation: {
        userDataDirectory,
        appDataDirectory,
        localAppDataDirectory: path.join(taskRoot, 'local-appdata'),
        service: SERVICE,
        selectedKeytarAccount: initialCredential[0].account,
        environmentKey: envKey,
        preexistingTargetCount: preexisting.length,
      },
      lp: {
        currentWriterIntent: logoutMarker.intent.intent,
        currentWriterRevision: logoutMarker.revision,
        deniedTokenGetMe: lpDeniedTokenGetMe,
        getMeCalls: lpCalls.length,
        authenticatedUi: lpAuthenticated,
        keytarSourcePresentAfter: lpCredentialAfter.length === 1,
        keytarSourceChangedByOldReader:
          lpCredentialAfter.length !== 1 || !lpCredentialAfter[0].matchesSynthetic,
      },
      acceptancePending: {
        currentRepositoryIntent: 'acceptance-pending',
        operationId: pendingState.projectionIntentOperationId,
        markerRevision: pendingState.markerRevision,
        candidateHash: pendingState.candidateHash,
        candidatePhase: pendingState.candidatePhase,
        legacyJournalDigest: pendingState.journalDigest,
        deniedTokenGetMe: v2DeniedTokenGetMe,
        getMeCalls: v2Calls.length,
        authenticatedUi: v2Authenticated,
        keytarSourcePresentAfter: v2CredentialAfter.length === 1,
        keytarSourceChangedByOldReader: v2CredentialChanged,
      },
      baseline: {
        passwordLoginPersistedSyntheticCredential: true,
        coldRestartGetMeUsedSyntheticCredential: calls.some(
          call => call.mode === 'allow-synthetic-token' && call.tokenMatches
        ),
        credentialStateAfterRestore: baselineCredential.length === 1,
      },
      network: {
        configuredRestEndpoint: REST_URL,
        configuredRpcEndpoint: RPC_URL,
        observedPasswordLoginRequests: loginRequests.length,
        observedGetMeRequests: calls.length,
      },
    }
    console.log(JSON.stringify(result))
    if (unsafe) process.exitCode = 1
  } finally {
    await stopPackagedBinary(appInstance).catch(() => undefined)
    await closeServer(apiServer)
    await closeServer(rpcServer)
    for (const account of accounts) {
      try {
        const remaining = await keytar.getPassword(SERVICE, account)
        if (remaining === CANDIDATE_TOKEN) await keytar.deletePassword(SERVICE, account)
      } catch {
        // The hosted VM is disposable; never delete an unexpected credential value.
      }
    }
    fs.rmSync(taskRoot, { recursive: true, force: true })
  }
}

const environmentSelfTest = process.argv.includes('--self-test-child-environment')
const execution = environmentSelfTest
  ? Promise.resolve().then(runChildEnvironmentContractSelfTest)
  : main()

execution.catch(error => {
  const category =
    error instanceof InconclusiveError
      ? error.category
      : error instanceof Error
        ? 'runtime-experiment-failed'
        : 'runtime-experiment-failed-unknown'
  console.error(`INCONCLUSIVE: ${category}`)
  process.exitCode = 2
})
