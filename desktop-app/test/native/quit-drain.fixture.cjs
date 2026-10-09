const { app, BrowserWindow } = require('electron')
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
const { AppService } = require('../../dist/appService.js')
const { TokenStore } = require('../../dist/tokenStore.js')
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
appService.sessionToken = 'synthetic-session-token'
appService.me = { id: 'synthetic-user', teamId: 'synthetic-team' }

const firstAuthFence = deferred()
const firstAuthStarted = deferred()
const independentTokenWriteFence = deferred()
const independentTokenWriteStarted = deferred()
const tokenStoreDrainStarted = deferred()
const retryStorageFence = deferred()
const retryStorageStarted = deferred()
let authSuspensions = 0
let firstLogoutSettled = false
let firstLogoutError = null
let firstLogout = null
let retryLogout = null
let retryLogoutSettled = false
let retryLogoutError = null
let savedCredential = true
let retryStorageHeld = false
let retryStorageSettled = false
let independentTokenWriteSettled = false
let firstDrainSawIndependentWrite = false
let firstDrainHeldForIndependentWrite = false
let storageClearCalls = 0

// Hold only GFS and the credential adapter. Keep AppService.logout, TokenStore's
// public admission/tracking/drain, and the quit coordinator real.
appService.suspendDesktopGfsUploadsForAuthBoundary = async () => {
  authSuspensions += 1
  if (authSuspensions === 1) {
    firstAuthStarted.resolve()
    await firstAuthFence.promise
  }
}
appService.tokenStore.clearSessionTokenOnce = async () => {
  storageClearCalls += 1
  if (retryStorageHeld) {
    retryStorageStarted.resolve()
    await retryStorageFence.promise
    retryStorageSettled = true
  }
  savedCredential = false
}
appService.tokenStore.setSessionTokenOnce = async token => {
  if (token !== 'synthetic-independent-token') return
  independentTokenWriteStarted.resolve()
  await independentTokenWriteFence.promise
  independentTokenWriteSettled = true
}
const independentTokenWrite = appService.tokenStore.setSessionToken(
  'synthetic-independent-token',
  'fixture-000000000000'
)

let firstDrainStartedBeforeLogoutSettled = false
let retryDrainStartedBeforeStorageSettled = false
const tokenStoreDrain = appService.tokenStore.prepareForQuit.bind(appService.tokenStore)
appService.tokenStore.prepareForQuit = async () => {
  tokenStoreDrainStarted.resolve()
  if (authSuspensions > 0 && !firstLogoutSettled) {
    firstDrainStartedBeforeLogoutSettled = true
  }
  if (!independentTokenWriteSettled) firstDrainSawIndependentWrite = true
  if (retryStorageHeld && !retryStorageSettled) {
    retryDrainStartedBeforeStorageSettled = true
  }
  await tokenStoreDrain()
}

let willQuitObserved = false
let prepareCount = 0
let preparationCallbackCompletions = 0
let cancellationCount = 0
let preparationHeldPastDeadline = false
let authStateIntactBeforeRelease = false
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
      authStateIntactBeforeRelease,
      firstDrainStartedBeforeLogoutSettled,
      firstDrainSawIndependentWrite,
      firstDrainHeldForIndependentWrite,
      firstScenarioVerified,
      retryPreparationHeld,
      retryDrainStartedBeforeStorageSettled,
      retryScenarioVerified,
      firstLogoutRejected: Boolean(firstLogoutError),
      retryLogoutRejected: Boolean(retryLogoutError),
      savedCredential,
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
        preparationHeldPastDeadline = !preparationSettled && !firstLogoutSettled
        authStateIntactBeforeRelease =
          appService.sessionToken === 'synthetic-session-token' &&
          appService.me?.id === 'synthetic-user' &&
          savedCredential

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
      retryPreparationHeld =
        !preparationSettled &&
        !retryLogoutSettled &&
        !retryStorageSettled &&
        !retryDrainStartedBeforeStorageSettled
      retryStorageFence.resolve()
      assert.ok(retryLogout, 'retry logout producer must exist before preparation drains')
      await Promise.all([preparation, retryLogout])
      if (process.env.EVENFIRE_TEST_QUIT_DRAIN_REJECT_PREPARATION === 'retry') {
        throw new Error('injected retry preparation rejection')
      }
      retryScenarioVerified =
        retryPreparationHeld &&
        !retryLogoutError &&
        retryStorageSettled &&
        !retryDrainStartedBeforeStorageSettled
      if (!retryScenarioVerified) throw new Error('canceled-attempt storage drain was not verified')
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
    const window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    await window.loadURL('data:text/html,<title>Evenfire quit drain fixture</title>')
    await window.webContents.executeJavaScript(
      'window.onbeforeunload = event => { event.returnValue = false; return false }; void 0'
    )
    await independentTokenWriteStarted.promise
    firstLogout = appService.logout().then(
      () => {
        firstLogoutSettled = true
      },
      error => {
        firstLogoutError = error
        firstLogoutSettled = true
      }
    )
    await firstAuthStarted.promise
    window.webContents.once('will-prevent-unload', () => {
      firstAuthFence.resolve()
      setImmediate(async () => {
        try {
          await firstLogout
          await cancellationFinished
          firstScenarioVerified =
            preparationHeldPastDeadline &&
            authStateIntactBeforeRelease &&
            !firstLogoutError &&
            appService.sessionToken === null &&
            appService.me === null &&
            !savedCredential &&
            !firstDrainStartedBeforeLogoutSettled &&
            storageClearCalls === 1
          assert.equal(window.isDestroyed(), false)

          retryStorageHeld = true
          retryLogout = appService.logout().then(
            () => {
              retryLogoutSettled = true
            },
            error => {
              retryLogoutError = error
              retryLogoutSettled = true
            }
          )
          await retryStorageStarted.promise
          await window.webContents.executeJavaScript('window.onbeforeunload = null; void 0')
          app.quit()
          await retryLogout
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
