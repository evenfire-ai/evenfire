const { app, BrowserWindow, safeStorage } = require('electron')
const assert = require('node:assert/strict')
const path = require('node:path')

const profileRoot = path.resolve(process.argv.at(-1))
const expectedPaths = {
  appData: path.join(profileRoot, 'app-data'),
  userData: path.join(profileRoot, 'user-data'),
  sessionData: path.join(profileRoot, 'session-data'),
}

function assertOwnedPaths() {
  for (const [name, expectedPath] of Object.entries(expectedPaths)) {
    assert.equal(path.resolve(app.getPath(name)), expectedPath, `${name} path must be isolated`)
  }
  assert.equal(
    path.resolve(process.env.CLERUM_DESKTOP_CONFIG_PATH || ''),
    path.join(profileRoot, 'runtime-config.json')
  )
}

assertOwnedPaths()

// Exercise public memory-only acceptance without querying the host account's Keychain.
safeStorage.isEncryptionAvailable = () => false

const { AppService } = require('../../dist/appService.js')
const { TokenStore } = require('../../dist/tokenStore.js')
const { getActiveEnvKey, saveDesktopRuntimeConfig } = require('../../dist/config.js')
const { SessionAuthorityRecordRepository } = require('../../dist/sessionAuthorityRecord.js')
assertOwnedPaths()
const { registerQuitDrain } = require('../../dist/mainWindowCoordinator.js')

app.disableHardwareAcceleration()

function deferred() {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
}

const tokenStore = new TokenStore({ isolatedUserDataPath: expectedPaths.userData })
const appService = new AppService({ tokenStore })
const syntheticUser = {
  id: 'synthetic-user',
  email: 'synthetic-user@example.test',
  name: 'Synthetic User',
  picture: null,
  teamId: 'synthetic-team',
  teamName: 'Synthetic Team',
  role: 'member',
}
const syntheticTokens = [
  `header.${Buffer.from(JSON.stringify({ sub: syntheticUser.id, exp: 1_900_000_000 })).toString(
    'base64url'
  )}.synthetic-a`,
  `header.${Buffer.from(JSON.stringify({ sub: syntheticUser.id, exp: 1_900_000_001 })).toString(
    'base64url'
  )}.synthetic-b`,
]
let syntheticLoginIndex = 0
appService.authClient.passwordLogin = async () => {
  return { token: syntheticTokens[syntheticLoginIndex++], me: syntheticUser }
}
appService.authClient.getMe = async token => {
  if (!syntheticTokens.includes(token)) throw new Error('unknown synthetic quit-drain token')
  return syntheticUser
}

const firstAuthFence = deferred()
const firstAuthStarted = deferred()
const retryAuthFence = deferred()
const retryAuthStarted = deferred()
const independentTokenWriteFence = deferred()
const independentTokenWriteStarted = deferred()
const tokenStoreDrainStarted = deferred()
const retryTokenStoreDrainStarted = deferred()
const retryStorageFence = deferred()
const retryStorageStarted = deferred()
let holdNextAuthSuspension = false
let firstLogoutSettled = false
let firstLogoutError = null
let firstLogoutOutcome = null
let firstLogout = null
let retryLogout = null
let retryLogoutSettled = false
let retryLogoutOutcome = null
let retryLogoutError = null
let authorityRepository = null
let retryStorageHeld = false
let retryStorageSettled = false
let independentTokenWriteSettled = false
let firstDrainSawIndependentWrite = false
let firstDrainHeldForIndependentWrite = false
let heldAuthBoundaries = 0
let tokenStoreDrainCalls = 0
let retryTokenWrite = null

// Hold only GFS and the credential adapter. Keep AppService.logout, TokenStore's
// public admission/tracking/drain, and the quit coordinator real.
appService.suspendDesktopGfsUploadsForAuthBoundary = async () => {
  if (holdNextAuthSuspension) {
    holdNextAuthSuspension = false
    heldAuthBoundaries += 1
    if (heldAuthBoundaries === 1) {
      firstAuthStarted.resolve()
      await firstAuthFence.promise
    } else {
      retryAuthStarted.resolve()
      await retryAuthFence.promise
    }
  }
}
appService.tokenStore.setSessionTokenOnce = async token => {
  if (token === 'synthetic-independent-token') {
    independentTokenWriteStarted.resolve()
    await independentTokenWriteFence.promise
    independentTokenWriteSettled = true
    return
  }
  if (token === 'synthetic-retry-token') {
    retryStorageStarted.resolve()
    await retryStorageFence.promise
    retryStorageSettled = true
  }
}
let independentTokenWrite

let firstDrainPrecededLogoutRevocation = false
let retryDrainStartedBeforeStorageSettled = false
const tokenStoreDrain = appService.tokenStore.prepareForQuit.bind(appService.tokenStore)
appService.tokenStore.prepareForQuit = async () => {
  tokenStoreDrainCalls += 1
  tokenStoreDrainStarted.resolve()
  if (firstLogout && !firstLogoutSettled) {
    const logoutFrame = authorityRepository?.observe()
    firstDrainPrecededLogoutRevocation =
      appService.sessionToken !== null ||
      logoutFrame?.status !== 'observed' ||
      logoutFrame.record.frame.mode !== 'logged-out'
  }
  if (!independentTokenWriteSettled) firstDrainSawIndependentWrite = true
  if (retryStorageHeld && !retryStorageSettled) {
    retryDrainStartedBeforeStorageSettled = true
    retryTokenStoreDrainStarted.resolve()
  }
  await tokenStoreDrain()
}

let willQuitObserved = false
let prepareCount = 0
let preparationCallbackCompletions = 0
let cancellationCount = 0
let preparationHeldPastDeadline = false
let logoutStateFencedBeforeRelease = false
let firstScenarioVerified = false
let retryScenarioVerified = false
let retryPreparationHeld = false
let fixtureFailure = null
let fixtureSucceeded = false
let resolveCancellation
const cancellationFinished = new Promise(resolve => {
  resolveCancellation = resolve
})
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function failFixture(error, context) {
  if (fixtureFailure) return
  fixtureFailure = error instanceof Error ? error : new Error(String(error))
  console.error(`QUIT_DRAIN_FIXTURE_FAILED:${context}`, fixtureFailure)
  app.exit(9)
}

function failPreparation(phase, error) {
  if (!fixtureFailure) {
    fixtureFailure = error instanceof Error ? error : new Error(String(error))
  }
  console.error(`QUIT_DRAIN_PREPARATION_REJECTED:${phase}`, fixtureFailure)
  app.exit(9)
}

app.on('will-quit', () => {
  willQuitObserved = true
  if (fixtureFailure) {
    app.exit(9)
    return
  }
  if (
    prepareCount !== 2 ||
    tokenStoreDrainCalls !== 2 ||
    preparationCallbackCompletions !== 2 ||
    cancellationCount !== 1 ||
    !firstScenarioVerified ||
    !firstDrainSawIndependentWrite ||
    !firstDrainHeldForIndependentWrite ||
    !independentTokenWriteSettled ||
    !retryScenarioVerified
  ) {
    console.error('admitted logout or canceled-attempt storage drain was not verified', {
      prepareCount,
      cancellationCount,
      preparationHeldPastDeadline,
      logoutStateFencedBeforeRelease,
      firstDrainPrecededLogoutRevocation,
      firstDrainSawIndependentWrite,
      firstDrainHeldForIndependentWrite,
      firstScenarioVerified,
      retryPreparationHeld,
      retryDrainStartedBeforeStorageSettled,
      retryScenarioVerified,
      firstLogoutRejected: Boolean(firstLogoutError),
      retryLogoutRejected: Boolean(retryLogoutError),
    })
    failFixture(
      new Error('admitted logout or canceled-attempt storage drain was not verified'),
      'final-state'
    )
    return
  }
  fixtureSucceeded = true
  console.log('WILL_QUIT')
})
app.on('quit', (_event, code) => {
  if (code === 0 && willQuitObserved && fixtureSucceeded && !fixtureFailure) {
    console.log('QUIT_DRAIN_NATIVE_FIXTURE_PASS')
  }
})
app.on('window-all-closed', () => {
  if (!willQuitObserved) {
    console.error('window closed without completing the native quit')
    failFixture(new Error('window closed before will-quit'), 'window-close')
  }
})

registerQuitDrain(
  app,
  async () => {
    prepareCount += 1
    const preparationPhase = prepareCount === 1 ? 'first' : 'retry'
    try {
      if (fixtureFailure) throw fixtureFailure
      const preparation = appService.prepareForQuit()
      let preparationSettled = false
      void preparation.then(
        () => {
          preparationSettled = true
        },
        () => {
          preparationSettled = true
        }
      )

      if (prepareCount === 1) {
        await sleep(20_100)
        preparationHeldPastDeadline =
          !preparationSettled && firstLogoutSettled && !independentTokenWriteSettled
        const liveAuthority = authorityRepository?.observe()
        logoutStateFencedBeforeRelease =
          firstLogoutOutcome?.kind === 'committed' &&
          appService.sessionToken === null &&
          appService.me === null &&
          liveAuthority?.status === 'observed' &&
          liveAuthority.record.frame.mode === 'logged-out'

        // A producer deadline would settle preparation during this window.
        // The current contract stays pending until the held producer is released.
        if (!preparationSettled) {
          firstAuthFence.resolve()
          if (process.env.EVENFIRE_TEST_QUIT_DRAIN_REJECT_PREPARATION === 'first') {
            throw new Error('injected first preparation rejection')
          }
          assert.ok(firstLogout, 'first logout producer must exist before preparation drains')
          await firstLogout
          await tokenStoreDrainStarted.promise
          await sleep(25)
          firstDrainHeldForIndependentWrite = !preparationSettled && !independentTokenWriteSettled
          independentTokenWriteFence.resolve()
          await Promise.all([preparation, independentTokenWrite])
        } else {
          await preparation
        }
        preparationCallbackCompletions += 1
        return
      }

      await sleep(25)
      retryAuthFence.resolve()
      assert.ok(retryLogout, 'retry logout producer must exist before preparation drains')
      await retryLogout
      await retryTokenStoreDrainStarted.promise
      retryPreparationHeld =
        !preparationSettled &&
        retryLogoutSettled &&
        retryLogoutOutcome?.kind === 'committed' &&
        !retryStorageSettled &&
        retryDrainStartedBeforeStorageSettled &&
        appService.sessionToken === null
      retryStorageFence.resolve()
      await Promise.all([preparation, retryTokenWrite])
      if (process.env.EVENFIRE_TEST_QUIT_DRAIN_REJECT_PREPARATION === 'retry') {
        throw new Error('injected retry preparation rejection')
      }
      retryScenarioVerified =
        retryPreparationHeld &&
        !retryLogoutError &&
        retryStorageSettled &&
        retryDrainStartedBeforeStorageSettled
      if (!retryScenarioVerified) {
        throw new Error(
          `canceled-attempt storage drain was not verified: ${JSON.stringify({
            retryPreparationHeld,
            retryLogoutKind: retryLogoutOutcome?.kind ?? null,
            retryLogoutRejected: Boolean(retryLogoutError),
            retryStorageSettled,
            retryDrainStartedBeforeStorageSettled,
          })}`
        )
      }
      preparationCallbackCompletions += 1
    } catch (error) {
      failPreparation(preparationPhase, error)
      throw error
    }
  },
  () => {
    cancellationCount += 1
    appService.cancelQuitPreparation()
    resolveCancellation()
  }
)
setTimeout(() => app.exit(8), 35_000)

app
  .whenReady()
  .then(async () => {
    console.log('QUIT_DRAIN_SETUP:runtime-config-started')
    await saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: 'http://127.0.0.1:43127',
      rpcProxyBaseUrl: 'http://127.0.0.1:43128',
      appName: 'Evenfire Quit Drain Fixture',
    })
    console.log('QUIT_DRAIN_SETUP:runtime-config-saved')
    console.log('QUIT_DRAIN_SETUP:configured', appService.getRuntimeConfigState().configured)
    console.log('QUIT_DRAIN_SETUP:password-login-started')
    const login = await appService.passwordLogin(
      syntheticUser.email,
      'synthetic-quit-drain-password'
    )
    console.log('QUIT_DRAIN_SETUP:password-login-settled')
    assert.equal(login.authenticated, true, 'the public password producer must accept session A')
    assert.equal(appService.sessionToken, syntheticTokens[0])
    const storageScope = await tokenStore.createSessionAuthorityStorageScope()
    authorityRepository = new SessionAuthorityRecordRepository(
      storageScope,
      getActiveEnvKey(),
      tokenStore
    )
    const accepted = authorityRepository.observe()
    assert.equal(accepted.status, 'observed', 'the public producer must write authority')
    assert.equal(accepted.record.frame.mode, 'memory-only')
    assert.equal(accepted.record.frame.source, null, 'M acceptance cannot persist a bearer')
    assert.equal(accepted.record.cleanupDebts.length, 0)
    console.log('QUIT_DRAIN_SETUP:accepted-memory-session-verified')

    const window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    await window.loadURL('data:text/html,<title>Evenfire quit drain fixture</title>')
    await window.webContents.executeJavaScript(
      'window.onbeforeunload = event => { event.returnValue = false; return false }; void 0'
    )
    holdNextAuthSuspension = true
    firstLogout = appService.logout().then(
      outcome => {
        firstLogoutOutcome = outcome
        firstLogoutSettled = true
      },
      error => {
        firstLogoutError = error
        firstLogoutSettled = true
      }
    )
    await Promise.race([
      firstAuthStarted.promise,
      firstLogout.then(() => {
        throw new Error(
          `logout settled before the held auth boundary ` +
            `(outcome=${firstLogoutOutcome?.kind === 'not-committed' ? firstLogoutOutcome.reason : (firstLogoutOutcome?.kind ?? 'unknown')}, ` +
            `rejected=${Boolean(firstLogoutError)})`
        )
      }),
    ])
    console.log('QUIT_DRAIN_SETUP:first-logout-held')
    independentTokenWrite = appService.tokenStore.setSessionToken(
      'synthetic-independent-token',
      'fixture-000000000000'
    )
    await independentTokenWriteStarted.promise
    console.log('QUIT_DRAIN_SETUP:independent-write-held')
    window.webContents.once('will-prevent-unload', () => {
      firstAuthFence.resolve()
      setImmediate(async () => {
        try {
          await firstLogout
          await cancellationFinished
          const loggedOutAuthority = authorityRepository?.observe()
          firstScenarioVerified =
            preparationHeldPastDeadline &&
            logoutStateFencedBeforeRelease &&
            !firstLogoutError &&
            appService.sessionToken === null &&
            appService.me === null &&
            !firstDrainPrecededLogoutRevocation &&
            loggedOutAuthority?.status === 'observed' &&
            loggedOutAuthority.record.frame.mode === 'logged-out' &&
            loggedOutAuthority.record.cleanupDebts.length === 0
          assert.equal(window.isDestroyed(), false)

          retryStorageHeld = true
          const secondLogin = await appService.passwordLogin(
            syntheticUser.email,
            'synthetic-quit-drain-password'
          )
          assert.equal(secondLogin.authenticated, true, 'a fresh session must precede retry logout')
          holdNextAuthSuspension = true
          retryLogout = appService.logout().then(
            outcome => {
              retryLogoutOutcome = outcome
              retryLogoutSettled = true
            },
            error => {
              retryLogoutError = error
              retryLogoutSettled = true
            }
          )
          await retryAuthStarted.promise
          retryTokenWrite = appService.tokenStore.setSessionToken(
            'synthetic-retry-token',
            'fixture-000000000000'
          )
          await retryStorageStarted.promise
          await window.webContents.executeJavaScript('window.onbeforeunload = null; void 0')
          app.quit()
          await Promise.all([retryLogout, retryTokenWrite])
        } catch (error) {
          failFixture(error, 'canceled-quit-recovery')
        }
      })
    })
    setImmediate(() => app.quit())
  })
  .catch(error => {
    failFixture(error, 'when-ready')
  })
