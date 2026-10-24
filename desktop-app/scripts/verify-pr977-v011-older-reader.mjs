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
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  InconclusiveError,
  UnsafeOlderReaderBehaviorError,
  attachFinalCleanupObservations,
  classifyDiagnosticFailure,
  classifyUncaughtExperimentFailure,
  runDiagnosticPhase,
  runWhenOwnedProcessesStopped,
  waitForOwnedChildClose,
} from './pr977-v011-older-reader-diagnostics.mjs'

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
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve()
    server.close(error => (error ? reject(error) : resolve()))
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

function waitForChildSpawn(child, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = callback => value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('spawn', onSpawn)
      child.off('error', onError)
      callback(value)
    }
    const onSpawn = finish(resolve)
    const onError = finish(reject)
    const timer = setTimeout(() => {
      child.kill()
      finish(() => reject(new InconclusiveError('packaged-binary-process-start-timeout')))()
    }, timeoutMs)
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
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

async function launchPackagedBinary(
  executable,
  userDataDirectory,
  profile,
  scenario,
  state,
  phase
) {
  let child = null
  let browser = null
  try {
    const port = await phase(
      'debug-port-allocation',
      async () => {
        const selectedPort = await getFreePort()
        state.debugPortAllocated = true
        return selectedPort
      },
      scenario
    )
    await phase(
      'packaged-process-start',
      async () => {
        state.processSpawnAttempted = true
        try {
          child = spawn(
            executable,
            [
              `--user-data-dir=${userDataDirectory}`,
              '--evenfire-desktop-dev-package',
              '--remote-debugging-address=127.0.0.1',
              `--remote-debugging-port=${port}`,
              '--disable-gpu',
              '--no-first-run',
            ],
            {
              cwd: profile.taskRoot,
              env: appEnvironment(profile),
              stdio: 'ignore',
              windowsHide: true,
            }
          )
        } catch (error) {
          state.processStopped = true
          throw error
        }
        state.ownedChild = child
        try {
          await waitForChildSpawn(child)
        } catch (error) {
          if (!child.pid) {
            state.ownedChild = null
            state.processStopped = true
          }
          throw error
        }
        state.processSpawned = true
        state.processAlive = child.exitCode === null
      },
      scenario
    )

    let spawnError = null
    child.once('error', error => {
      spawnError = error.code || 'spawn-error'
    })
    const endpoint = await phase(
      'packaged-cdp-attachment',
      async () => {
        const debugEndpoint = await waitForDebugEndpoint(port, child, () => spawnError)
        browser = await chromium.connectOverCDP(debugEndpoint, {
          timeout: COMPATIBILITY_TIMEOUT_MS,
        })
        state.ownedBrowser = browser
        state.cdpAttached = true
        state.processAlive = child.exitCode === null
        return debugEndpoint
      },
      scenario
    )
    const page = await phase(
      'packaged-renderer-readiness',
      async () => {
        const readyPage = await waitForApplicationPage(browser)
        state.rendererReady = true
        return readyPage
      },
      scenario
    )
    return { child, browser, page, endpoint }
  } catch (error) {
    if (child) {
      try {
        await phase(
          'owned-process-tree-stop',
          () => stopPackagedBinary({ child, browser }, state),
          scenario
        )
      } catch {
        // The phase report retains cleanup failure without exposing process output.
      }
    }
    throw error
  }
}

async function stopPackagedBinary(instance, state) {
  if (!instance) return
  try {
    await instance.browser?.close()
  } catch {
    // The process tree below is the authoritative stop operation for this owned launch.
  }
  if (state) state.ownedBrowser = null
  const child = instance.child
  if (child && child.exitCode === null && child.pid) {
    if (state) state.processTreeStopRequested = true
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
  if (state) state.processStopped = !child || child.exitCode !== null
  if (state && (!child || child.exitCode !== null)) state.processAlive = false
  if (child && child.exitCode === null)
    throw new InconclusiveError('owned-packaged-process-did-not-exit')
  if (state && child && child.exitCode !== null) state.ownedChild = null
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

async function submitSyntheticLogin(page, loginRequests, state) {
  await waitForUiState(page, 'loginForm', 'older-binary-login-form-not-reached')
  await page.locator('#email-input').fill(EMAIL)
  await page.locator('#password-input').fill(PASSWORD)
  const before = loginRequests.length
  await page.locator('form.auth-form-stack button[type="submit"]').click()
  if (state) state.loginSubmitted = true
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
  const authorityFrameVerified = record.version === 2 && !rawRecord.includes(CANDIDATE_TOKEN)
  const projectionIntentMatched =
    record.projectionIntent?.operationId === marker.operationId &&
    record.projectionIntent?.stagedMarker?.revision === marker.revision &&
    marker.expectedAuthorityRevision === record.projectionIntent.baseAuthorityRevision
  const markerReceiptMatched =
    marker.version === 2 &&
    marker.intent === 'acceptance-pending' &&
    marker.purpose === 'candidate-acceptance'
  const candidateDenialVerified =
    Boolean(candidate) &&
    candidate.phase === 'verified' &&
    candidate.candidateHash === sessionPersistenceCandidateHash(CANDIDATE_TOKEN)
  const legacyJournalSnapshotMatched =
    Boolean(journal) &&
    record.projectionIntent.legacyJournalReceipt?.schemaVersion === 1 &&
    record.projectionIntent.legacyJournalReceipt?.digest === journalDigest &&
    record.projectionIntent.legacyJournalReceipt?.byteLength === journalBytes.length &&
    record.projectionIntent.legacyJournalReceipt?.revision === `v0-sha256:${journalDigest}`

  if (
    !authorityFrameVerified ||
    !projectionIntentMatched ||
    !markerReceiptMatched ||
    !candidateDenialVerified ||
    !legacyJournalSnapshotMatched
  ) {
    throw new InconclusiveError('current-v2-repository-did-not-produce-matching-pending-state')
  }
  return {
    authorityFrameVerified,
    projectionIntentMatched,
    candidateDenialVerified,
    markerReceiptMatched,
    legacyJournalSnapshotMatched,
  }
}

async function main() {
  const state = {
    principalProfileVerified: false,
    executablePresent: false,
    productVersionVerified: false,
    executableIntegrityReadable: false,
    credentialReadSucceeded: false,
    preexistingSelectorCount: 0,
    restEndpointListening: false,
    rpcEndpointListening: false,
    debugPortAllocated: false,
    processSpawnAttempted: false,
    processSpawned: false,
    processAlive: false,
    cdpAttached: false,
    rendererReady: false,
    isolatedProfileObserved: false,
    loginSubmitted: false,
    passwordLoginRequestCount: 0,
    authenticatedUi: false,
    syntheticCredentialPresent: false,
    credentialSelectorCount: 0,
    processTreeStopRequested: false,
    processStopped: false,
    ownedChild: null,
    ownedBrowser: null,
    getMeRequestCount: 0,
    syntheticTokenGetMeCount: 0,
    logoutMarkerPublished: false,
    logoutMarkerRevisionVerified: false,
    restoreDecisionReached: false,
    loginFormVisible: false,
    credentialChanged: false,
    logoutMarkerRemoved: false,
    authorityDirectoryRemoved: false,
    journalRemoved: false,
    writerStarted: false,
    writerClosed: false,
    writerTerminationRequested: false,
    writerStopped: true,
    ownedWriter: null,
    writerExitCode: null,
    writerExitCodeKnown: false,
    writerTerminatedBySignal: false,
    authorityFrameVerified: false,
    projectionIntentMatched: false,
    candidateDenialVerified: false,
    markerReceiptMatched: false,
    legacyJournalSnapshotMatched: false,
    baselineRestoreSucceeded: false,
    lpCaseDenied: false,
    v2CaseDenied: false,
    syntheticCredentialRemoved: false,
    remainingTargetSelectorCount: null,
    restEndpointClosed: false,
    rpcEndpointClosed: false,
    taskDirectoryRemoved: false,
  }
  const envKey = resolveEnvironmentKey(REST_URL, RPC_URL)
  const accounts = [`session-token::${envKey}`, 'session-token']
  const calls = []
  const loginRequests = []
  let responseMode = 'allow-synthetic-token'
  let taskRoot = null
  let userDataDirectory = null
  let apiServer = null
  let rpcServer = null
  let appInstance = null
  let syntheticCredentialMayBeOwned = false
  let fatalError = null
  let failedPhase = 'orchestration'
  let summary = null

  const phase = async (name, operation, scenario) => {
    try {
      return await runDiagnosticPhase(name, operation, {
        scenario,
        observations: () => state,
      })
    } catch (error) {
      if (!fatalError) {
        fatalError = error
        failedPhase = name
      }
      throw error
    }
  }

  try {
    const principal = await phase('runner-principal-profile', async () => {
      const verified = assertHostedWindowsRunner()
      state.principalProfileVerified = true
      return verified
    })

    const executable = process.env.EVENFIRE_V011_EXE
    const executableProductVersion = process.env.EVENFIRE_V011_PRODUCT_VERSION
    const packageHash = await phase('release-executable-verification', async () => {
      state.executablePresent = Boolean(executable && fs.existsSync(executable))
      state.productVersionVerified = Boolean(
        executableProductVersion && /^0\.11\.0(?:\.|$)/.test(executableProductVersion)
      )
      if (!state.executablePresent || !state.productVersionVerified) {
        throw new InconclusiveError('verified-v011-packaged-executable-not-available')
      }
      const digest = execFileSync('certutil.exe', ['-hashfile', executable, 'SHA256'], {
        encoding: 'utf8',
        windowsHide: true,
      })
        .match(/[0-9a-f]{64}/i)?.[0]
        ?.toLowerCase()
      if (!digest) throw new InconclusiveError('packaged-executable-integrity-not-readable')
      state.executableIntegrityReadable = true
      return digest
    })

    const preexisting = await phase('credential-selector-preflight', async () => {
      let observed
      try {
        observed = await credentialState(accounts)
      } catch {
        throw new InconclusiveError('isolated-windows-credential-manager-unavailable')
      }
      state.credentialReadSucceeded = true
      state.preexistingSelectorCount = observed.length
      if (observed.length !== 0) {
        throw new InconclusiveError('fresh-runner-evenfire-credential-selector-was-not-empty')
      }
      return observed
    })

    const profile = await phase('isolated-user-data-profile', async () => {
      const runnerTemp = path.resolve(process.env.RUNNER_TEMP)
      taskRoot = fs.mkdtempSync(path.join(runnerTemp, 'pr977-v011-older-reader-'))
      const appDataDirectory = path.join(taskRoot, 'appdata')
      userDataDirectory = path.join(appDataDirectory, 'Evenfire')
      const localAppDataDirectory = path.join(taskRoot, 'local-appdata')
      const tempDirectory = path.join(taskRoot, 'temp')
      fs.mkdirSync(userDataDirectory, { recursive: true })
      fs.mkdirSync(localAppDataDirectory, { recursive: true })
      fs.mkdirSync(tempDirectory, { recursive: true })
      if (
        !path
          .resolve(userDataDirectory)
          .toLowerCase()
          .startsWith(`${runnerTemp.toLowerCase()}${path.sep.toLowerCase()}`)
      ) {
        throw new InconclusiveError('synthetic-profile-escaped-runner-temp')
      }
      state.isolatedProfileObserved = true
      return {
        appDataDirectory,
        localAppDataDirectory,
        tempDirectory,
        taskRoot,
        userProfile: principal.userProfile,
      }
    })

    apiServer = http.createServer(async (request, response) => {
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
        syntheticCredentialMayBeOwned = true
        loginRequests.push({ at: Date.now() })
        state.passwordLoginRequestCount = loginRequests.length
        writeJson(response, 200, { token: CANDIDATE_TOKEN, me: USER })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/me') {
        const authorization = request.headers.authorization ?? ''
        const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
        const tokenMatches = token === CANDIDATE_TOKEN
        calls.push({ mode: responseMode, tokenMatches })
        state.getMeRequestCount = calls.length
        state.syntheticTokenGetMeCount = calls.filter(call => call.tokenMatches).length
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
    rpcServer = http.createServer((_request, response) => writeJson(response, 200, { ok: true }))

    await phase('synthetic-endpoint-startup', async () => {
      try {
        await listen(apiServer, 8091)
        state.restEndpointListening = true
        await listen(rpcServer, 8094)
        state.rpcEndpointListening = true
      } catch {
        throw new InconclusiveError('synthetic-local-endpoint-port-unavailable')
      }
    })

    const launch = scenario => {
      state.debugPortAllocated = false
      state.processSpawnAttempted = false
      state.processSpawned = false
      state.processAlive = false
      state.cdpAttached = false
      state.rendererReady = false
      state.processStopped = false
      return launchPackagedBinary(executable, userDataDirectory, profile, scenario, state, phase)
    }

    appInstance = await launch('initial-login')
    await phase(
      'isolated-user-data-profile',
      async () => {
        await waitForIsolatedElectronProfile(userDataDirectory)
        state.isolatedProfileObserved = true
      },
      'initial-login'
    )
    await phase(
      'synthetic-password-login',
      async () => {
        await submitSyntheticLogin(appInstance.page, loginRequests, state)
        state.authenticatedUi = (await readUiState(appInstance.page)).authenticatedSurface
        if (!state.authenticatedUi)
          throw new InconclusiveError('older-binary-login-did-not-authenticate')
      },
      'initial-login'
    )
    await phase(
      'synthetic-credential-readback',
      async () => {
        const found = await waitFor(async () => {
          const current = await credentialState(accounts)
          if (current.length === 1 && current[0].matchesSynthetic) return current
          return false
        }, 'v011-password-login-did-not-persist-to-isolated-keytar')
        state.syntheticCredentialPresent = true
        state.credentialSelectorCount = found.length
        return found
      },
      'initial-login'
    )
    await phase(
      'owned-process-tree-stop',
      () => stopPackagedBinary(appInstance, state),
      'initial-login'
    )
    appInstance = null

    responseMode = 'allow-synthetic-token'
    const baselineStart = calls.length
    appInstance = await launch('baseline')
    await phase(
      'isolated-user-data-profile',
      async () => {
        await waitForIsolatedElectronProfile(userDataDirectory)
        state.isolatedProfileObserved = true
      },
      'baseline'
    )
    const baseline = await phase(
      'baseline-getme-restore',
      async () => {
        await waitFor(
          () => calls.slice(baselineStart).some(call => call.tokenMatches),
          'v011-cold-restart-did-not-read-synthetic-keytar-credential'
        )
        const baselineCalls = calls.slice(baselineStart)
        state.getMeRequestCount = baselineCalls.length
        state.syntheticTokenGetMeCount = baselineCalls.filter(call => call.tokenMatches).length
        return baselineCalls
      },
      'baseline'
    )
    const baselineCredential = await phase(
      'baseline-authenticated-ui',
      async () => {
        await waitForUiState(
          appInstance.page,
          'authenticatedSurface',
          'v011-baseline-restart-not-authenticated'
        )
        state.authenticatedUi = true
        state.baselineRestoreSucceeded = state.syntheticTokenGetMeCount > 0
        const persisted = await credentialState(accounts)
        state.syntheticCredentialPresent = persisted.length === 1 && persisted[0].matchesSynthetic
        if (!state.baselineRestoreSucceeded || !state.syntheticCredentialPresent) {
          throw new InconclusiveError('v011-baseline-restart-not-authenticated')
        }
        return persisted
      },
      'baseline'
    )
    await phase('owned-process-tree-stop', () => stopPackagedBinary(appInstance, state), 'baseline')
    appInstance = null

    await phase(
      'publish-lp-marker',
      async () => {
        recordPendingExternalLogout(userDataDirectory, envKey)
        const marker = readPendingExternalLogoutMarker(userDataDirectory, envKey)
        state.logoutMarkerPublished = marker?.intent?.intent === 'logout-pending'
        state.logoutMarkerRevisionVerified = Boolean(marker?.revision)
        if (!state.logoutMarkerPublished || !state.logoutMarkerRevisionVerified) {
          throw new InconclusiveError('current-lp-marker-writer-did-not-publish-durable-revision')
        }
        return marker
      },
      'lp'
    )
    responseMode = 'deny-synthetic-token'
    state.restoreDecisionReached = false
    state.loginFormVisible = false
    state.getMeRequestCount = 0
    state.syntheticTokenGetMeCount = 0
    state.authenticatedUi = false
    state.credentialChanged = false
    const lpStart = calls.length
    appInstance = await launch('lp')
    const lpObservation = await phase(
      'lp-restore-observation',
      async () => {
        await waitFor(async () => {
          const ui = await readUiState(appInstance.page)
          return ui.loginForm || ui.authenticatedSurface || calls.length > lpStart
        }, 'v011-lp-startup-did-not-reach-a-restore-decision')
        await delay(COMPATIBILITY_TIMEOUT_MS)
        const launchedInstance = appInstance
        const ui = await readUiState(launchedInstance.page)
        state.loginFormVisible = ui.loginForm
        state.authenticatedUi = ui.authenticatedSurface
        await phase(
          'owned-process-tree-stop',
          () => stopPackagedBinary(launchedInstance, state),
          'lp'
        )
        appInstance = null
        const observedCalls = calls.slice(lpStart)
        const credential = await credentialState(accounts)
        state.getMeRequestCount = observedCalls.length
        state.syntheticTokenGetMeCount = observedCalls.filter(call => call.tokenMatches).length
        state.credentialChanged = credential.length !== 1 || !credential[0].matchesSynthetic
        state.restoreDecisionReached =
          observedCalls.length > 0 || ui.loginForm || ui.authenticatedSurface
        if (!ui.loginForm && !ui.authenticatedSurface) {
          if (!state.restoreDecisionReached) {
            throw new InconclusiveError(
              'v011-lp-startup-did-not-reach-a-stable-authentication-surface'
            )
          }
        }
        return {
          calls: observedCalls,
          credential,
          ui,
          restoreDecisionReached: state.restoreDecisionReached,
        }
      },
      'lp'
    )

    await phase(
      'reset-lp-before-v2',
      async () => {
        const currentLp = readPendingExternalLogoutMarker(userDataDirectory, envKey)
        if (
          currentLp &&
          !clearPendingExternalLogoutIfUnchanged(userDataDirectory, envKey, currentLp)
        ) {
          throw new InconclusiveError('task-owned-lp-marker-could-not-be-cleared-for-next-case')
        }
        state.logoutMarkerRemoved = !readPendingExternalLogoutMarker(userDataDirectory, envKey)
        const authorityDirectory = path.join(userDataDirectory, 'authority')
        const journalPath = path.join(
          userDataDirectory,
          `session-persistence-journal-${sha256(envKey)}`
        )
        fs.rmSync(authorityDirectory, { recursive: true, force: true })
        fs.rmSync(journalPath, { force: true })
        state.authorityDirectoryRemoved = !fs.existsSync(authorityDirectory)
        state.journalRemoved = !fs.existsSync(journalPath)
        if (
          !state.logoutMarkerRemoved ||
          !state.authorityDirectoryRemoved ||
          !state.journalRemoved
        ) {
          throw new InconclusiveError('task-owned-lp-marker-could-not-be-cleared-for-next-case')
        }
      },
      'v2'
    )

    responseMode = 'allow-synthetic-token'
    const existingCredential = await phase(
      'lp-credential-state-before-v2',
      async () => {
        let current
        try {
          current = await credentialState(accounts)
        } catch {
          throw new InconclusiveError('isolated-windows-credential-manager-unavailable')
        }
        state.credentialReadSucceeded = true
        state.syntheticCredentialPresent = current.length === 1 && current[0].matchesSynthetic
        state.credentialSelectorCount = current.length
        if (current.length !== 0 && !state.syntheticCredentialPresent) {
          throw new InconclusiveError('v011-lp-case-left-an-unexpected-credential-selector-state')
        }
        return current
      },
      'v2'
    )
    if (existingCredential.length === 0) {
      appInstance = await launch('v2')
      await phase(
        'synthetic-password-login',
        async () => {
          await submitSyntheticLogin(appInstance.page, loginRequests, state)
          state.authenticatedUi = (await readUiState(appInstance.page)).authenticatedSurface
          if (!state.authenticatedUi) {
            throw new InconclusiveError('older-binary-login-did-not-authenticate')
          }
        },
        'v2'
      )
      await phase(
        'reseed-synthetic-credential',
        async () => {
          await waitFor(async () => {
            const found = await credentialState(accounts)
            return found.length === 1 && found[0].matchesSynthetic
          }, 'v011-could-not-reseed-synthetic-credential-for-v2-case')
          state.syntheticCredentialPresent = true
        },
        'v2'
      )
      await phase('owned-process-tree-stop', () => stopPackagedBinary(appInstance, state), 'v2')
      appInstance = null
    }

    const authorityDirectory = path.join(userDataDirectory, 'authority')
    const crashWorker = path.join(
      DESKTOP_DIRECTORY,
      'src',
      '__tests__',
      'sessionAuthorityRecordCrashWorker.cjs'
    )
    const pendingState = await phase(
      'publish-v2-pending-state',
      async () => {
        fs.mkdirSync(authorityDirectory, { recursive: true })
        const writer = spawn(
          process.execPath,
          [crashWorker, authorityDirectory, envKey, 'produce', 'after-marker'],
          { cwd: DESKTOP_DIRECTORY, stdio: 'ignore', windowsHide: true }
        )
        state.ownedWriter = writer
        state.writerStopped = false
        writer.once('close', (code, signal) => {
          state.writerClosed = true
          state.writerStopped = true
          state.writerExitCode = code
          state.writerExitCodeKnown = code !== null
          state.writerTerminatedBySignal = signal !== null
          state.ownedWriter = null
        })
        await waitForChildSpawn(writer)
        state.writerStarted = true
        const writerExit = await waitForOwnedChildClose(writer, {
          timeoutMs: COMPATIBILITY_TIMEOUT_MS,
          onTerminationRequested: () => {
            state.writerTerminationRequested = true
          },
        })
        state.writerClosed = true
        state.writerStopped = true
        state.ownedWriter = null
        state.writerExitCode = writerExit.code
        state.writerExitCodeKnown = writerExit.code !== null
        state.writerTerminatedBySignal = writerExit.signal !== null
        if (writerExit.timedOut) {
          throw new InconclusiveError('current-v2-repository-writer-exceeded-timeout')
        }
        if (writerExit.signal !== null) {
          throw new InconclusiveError('child-process-terminated-by-signal')
        }
        if (writerExit.code === null) {
          throw new InconclusiveError('child-process-exit-state-unknown')
        }
        if (writerExit.code !== 73) {
          throw new InconclusiveError('current-v2-repository-writer-did-not-exit-expectedly')
        }
        return writerExit
      },
      'v2'
    )
    const v2Receipt = await phase(
      'read-v2-pending-receipt',
      async () => {
        const receipt = readV2AcceptancePendingState(userDataDirectory, envKey)
        Object.assign(state, receipt)
        const current = await credentialState(accounts)
        state.syntheticCredentialPresent = current.length === 1 && current[0].matchesSynthetic
        state.credentialSelectorCount = current.length
        if (!state.syntheticCredentialPresent) {
          throw new InconclusiveError('synthetic-denied-token-missing-before-v2-restore')
        }
        return receipt
      },
      'v2'
    )

    responseMode = 'deny-synthetic-token'
    state.restoreDecisionReached = false
    state.loginFormVisible = false
    state.getMeRequestCount = 0
    state.syntheticTokenGetMeCount = 0
    state.authenticatedUi = false
    state.credentialChanged = false
    const v2Start = calls.length
    appInstance = await launch('v2')
    const v2Observation = await phase(
      'v2-restore-observation',
      async () => {
        await waitFor(async () => {
          const ui = await readUiState(appInstance.page)
          return ui.loginForm || ui.authenticatedSurface || calls.length > v2Start
        }, 'v011-v2-startup-did-not-reach-a-restore-decision')
        await delay(COMPATIBILITY_TIMEOUT_MS)
        const launchedInstance = appInstance
        const ui = await readUiState(launchedInstance.page)
        state.loginFormVisible = ui.loginForm
        state.authenticatedUi = ui.authenticatedSurface
        await phase(
          'owned-process-tree-stop',
          () => stopPackagedBinary(launchedInstance, state),
          'v2'
        )
        appInstance = null
        const observedCalls = calls.slice(v2Start)
        const credential = await credentialState(accounts)
        state.getMeRequestCount = observedCalls.length
        state.syntheticTokenGetMeCount = observedCalls.filter(call => call.tokenMatches).length
        state.credentialChanged = credential.length !== 1 || !credential[0].matchesSynthetic
        state.restoreDecisionReached =
          observedCalls.length > 0 || ui.loginForm || ui.authenticatedSurface
        if (!ui.loginForm && !ui.authenticatedSurface) {
          if (!state.restoreDecisionReached) {
            throw new InconclusiveError(
              'v011-v2-startup-did-not-reach-a-stable-authentication-surface'
            )
          }
        }
        return {
          calls: observedCalls,
          credential,
          ui,
          restoreDecisionReached: state.restoreDecisionReached,
        }
      },
      'v2'
    )

    const lpDeniedTokenGetMe = lpObservation.calls.some(call => call.tokenMatches)
    const v2DeniedTokenGetMe = v2Observation.calls.some(call => call.tokenMatches)
    const lpAuthenticated = lpObservation.ui.authenticatedSurface
    const v2Authenticated = v2Observation.ui.authenticatedSurface
    const lpCredentialChanged =
      lpObservation.credential.length !== 1 || !lpObservation.credential[0].matchesSynthetic
    const v2CredentialChanged =
      v2Observation.credential.length !== 1 || !v2Observation.credential[0].matchesSynthetic
    const lpDenied =
      lpObservation.restoreDecisionReached &&
      lpObservation.ui.loginForm &&
      !lpDeniedTokenGetMe &&
      !lpAuthenticated &&
      !lpCredentialChanged
    const v2Denied =
      v2Observation.restoreDecisionReached &&
      v2Observation.ui.loginForm &&
      !v2DeniedTokenGetMe &&
      !v2Authenticated &&
      !v2CredentialChanged
    state.lpCaseDenied = lpDenied
    state.v2CaseDenied = v2Denied
    const unsafe =
      lpDeniedTokenGetMe ||
      lpAuthenticated ||
      lpCredentialChanged ||
      v2DeniedTokenGetMe ||
      v2Authenticated ||
      v2CredentialChanged
    await phase('evaluate-compatibility', async () => {
      if (!state.baselineRestoreSucceeded || !lpDenied || !v2Denied) {
        if (unsafe) throw new UnsafeOlderReaderBehaviorError()
        throw new InconclusiveError('older-reader-denial-assertion-not-reached')
      }
      return true
    })

    summary = {
      kind: 'compatibility-experiment-result',
      status: 'PASS_FOR_TESTED_STATES_ONLY',
      runner: {
        image: process.env.ImageOS ?? null,
        version: process.env.ImageVersion ?? null,
        workflowSha: process.env.GITHUB_SHA ?? null,
        workflowRunId: process.env.GITHUB_RUN_ID ?? null,
        hostedProfileVerified: state.principalProfileVerified,
      },
      executable: {
        productVersion: '0.11.0',
        assetSha256: PACKAGE_SHA256,
        executableSha256: packageHash,
        spawned: state.processSpawned,
        cdpAttached: state.cdpAttached,
        rendererReady: state.rendererReady,
      },
      isolation: {
        userDataProfileVerified: state.isolatedProfileObserved,
        credentialManagerReadSucceeded: state.credentialReadSucceeded,
        preexistingTargetCount: preexisting.length,
      },
      baseline: {
        passwordLoginSubmitted: state.loginSubmitted,
        syntheticCredentialReadBack: state.syntheticCredentialPresent,
        coldRestartUsedSyntheticCredential: baseline.some(call => call.tokenMatches),
        authenticatedUi: state.baselineRestoreSucceeded,
        getMeRequestCount: baseline.length,
      },
      logoutPending: {
        markerPublished: state.logoutMarkerPublished,
        markerRevisionVerified: state.logoutMarkerRevisionVerified,
        restoreDecisionReached: lpObservation.restoreDecisionReached,
        deniedTokenGetMe: lpDeniedTokenGetMe,
        getMeRequestCount: lpObservation.calls.length,
        authenticatedUi: lpAuthenticated,
        loginFormVisible: lpObservation.ui.loginForm,
        credentialChanged: lpCredentialChanged,
        denied: lpDenied,
      },
      acceptancePending: {
        writerExitCode: pendingState.code,
        writerExitCodeKnown: state.writerExitCodeKnown,
        writerTerminatedBySignal: state.writerTerminatedBySignal,
        authorityFrameVerified: v2Receipt.authorityFrameVerified,
        projectionIntentMatched: v2Receipt.projectionIntentMatched,
        candidateDenialVerified: v2Receipt.candidateDenialVerified,
        markerReceiptMatched: v2Receipt.markerReceiptMatched,
        legacyJournalSnapshotMatched: v2Receipt.legacyJournalSnapshotMatched,
        restoreDecisionReached: v2Observation.restoreDecisionReached,
        deniedTokenGetMe: v2DeniedTokenGetMe,
        getMeRequestCount: v2Observation.calls.length,
        authenticatedUi: v2Authenticated,
        loginFormVisible: v2Observation.ui.loginForm,
        credentialChanged: v2CredentialChanged,
        denied: v2Denied,
      },
      cleanup: {
        processStopped: state.processStopped,
        syntheticCredentialRemoved: state.syntheticCredentialRemoved,
        remainingTargetSelectorCount: state.remainingTargetSelectorCount,
        restEndpointClosed: state.restEndpointClosed,
        rpcEndpointClosed: state.rpcEndpointClosed,
        taskDirectoryRemoved: state.taskDirectoryRemoved,
      },
    }
  } catch (error) {
    if (!fatalError) fatalError = error
  } finally {
    try {
      await phase('cleanup-owned-resources', async () => {
        const cleanupErrors = []
        if (state.ownedWriter && !state.writerStopped) {
          const writer = state.ownedWriter
          try {
            const writerExit = await waitForOwnedChildClose(writer, {
              timeoutMs: 0,
              onTerminationRequested: () => {
                state.writerTerminationRequested = true
              },
            })
            state.writerClosed = true
            state.writerExitCode = writerExit.code
            state.writerExitCodeKnown = writerExit.code !== null
            state.writerTerminatedBySignal = writerExit.signal !== null
            state.writerStopped =
              writerExit.code !== null || writerExit.signal !== null || state.writerClosed
            if (state.writerStopped) state.ownedWriter = null
            else
              cleanupErrors.push(new InconclusiveError('current-v2-repository-writer-did-not-exit'))
          } catch (error) {
            state.writerStopped =
              writer.exitCode !== null || writer.signalCode !== null || state.writerClosed
            state.writerExitCode = writer.exitCode
            state.writerExitCodeKnown = writer.exitCode !== null
            state.writerTerminatedBySignal = writer.signalCode !== null
            if (state.writerStopped) state.ownedWriter = null
            else cleanupErrors.push(error)
          }
        }
        if (appInstance || state.ownedChild) {
          try {
            await stopPackagedBinary(
              appInstance ?? { child: state.ownedChild, browser: state.ownedBrowser },
              state
            )
          } catch (error) {
            cleanupErrors.push(error)
          }
          appInstance = null
        }
        if (apiServer) {
          try {
            await closeServer(apiServer)
            state.restEndpointClosed = !apiServer.listening
          } catch (error) {
            cleanupErrors.push(error)
          }
        } else state.restEndpointClosed = true
        if (rpcServer) {
          try {
            await closeServer(rpcServer)
            state.rpcEndpointClosed = !rpcServer.listening
          } catch (error) {
            cleanupErrors.push(error)
          }
        } else state.rpcEndpointClosed = true
        state.processStopped = state.processStopped || !state.processSpawnAttempted
        if (!syntheticCredentialMayBeOwned) {
          state.syntheticCredentialRemoved =
            state.preexistingSelectorCount === 0 && !state.syntheticCredentialPresent
          state.remainingTargetSelectorCount = state.preexistingSelectorCount
        } else if (!state.credentialReadSucceeded) {
          state.syntheticCredentialRemoved = false
          state.remainingTargetSelectorCount = null
          cleanupErrors.push(
            new InconclusiveError('isolated-windows-credential-manager-unavailable')
          )
        } else {
          try {
            const cleanupWasAllowed = await runWhenOwnedProcessesStopped(state, async () => {
              for (const account of accounts) {
                const remaining = await keytar.getPassword(SERVICE, account)
                if (remaining === CANDIDATE_TOKEN) await keytar.deletePassword(SERVICE, account)
              }
              const finalCredentials = await credentialState(accounts)
              state.remainingTargetSelectorCount = finalCredentials.length
              state.syntheticCredentialRemoved = !finalCredentials.some(
                credential => credential.matchesSynthetic
              )
              if (!state.syntheticCredentialRemoved || finalCredentials.length !== 0) {
                cleanupErrors.push(new InconclusiveError('cleanup-verification-failed'))
              }
            })
            if (!cleanupWasAllowed) {
              state.syntheticCredentialRemoved = false
              state.remainingTargetSelectorCount = null
              if (!state.processStopped) {
                cleanupErrors.push(new InconclusiveError('owned-packaged-process-did-not-exit'))
              }
              if (!state.writerStopped) {
                cleanupErrors.push(
                  new InconclusiveError('current-v2-repository-writer-did-not-exit')
                )
              }
            }
          } catch (error) {
            cleanupErrors.push(error)
          }
        }
        if (taskRoot) {
          try {
            const taskDirectoryCleanupAllowed = await runWhenOwnedProcessesStopped(
              state,
              async () => {
                fs.rmSync(taskRoot, { recursive: true, force: true })
                state.taskDirectoryRemoved = !fs.existsSync(taskRoot)
              }
            )
            if (!taskDirectoryCleanupAllowed) state.taskDirectoryRemoved = false
          } catch (error) {
            cleanupErrors.push(error)
          }
        } else if (!taskRoot) state.taskDirectoryRemoved = true
        else state.taskDirectoryRemoved = false
        if (!state.taskDirectoryRemoved) {
          cleanupErrors.push(new InconclusiveError('cleanup-verification-failed'))
        }
        if (!state.restEndpointClosed || !state.rpcEndpointClosed) {
          cleanupErrors.push(new InconclusiveError('local-test-server-did-not-close'))
        }
        if (cleanupErrors.length > 0) throw cleanupErrors[0]
      })
    } catch (error) {
      if (!fatalError) {
        fatalError = error
        failedPhase = 'cleanup-owned-resources'
      }
    }
  }

  summary = attachFinalCleanupObservations(summary, state)

  if (fatalError) {
    const failure = classifyDiagnosticFailure(fatalError)
    const output = classifyUncaughtExperimentFailure(fatalError, failedPhase)
    console.error(JSON.stringify(output))
    process.exitCode = failure.status === 'FAIL' ? 1 : 2
    return
  }
  console.log(JSON.stringify(summary))
}

const environmentSelfTest = process.argv.includes('--self-test-child-environment')
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const execution = environmentSelfTest
    ? Promise.resolve().then(runChildEnvironmentContractSelfTest)
    : main()

  execution.catch(error => {
    console.error(JSON.stringify(classifyUncaughtExperimentFailure(error)))
    process.exitCode = 2
  })
}
