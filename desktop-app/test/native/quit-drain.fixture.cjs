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

const appService = new AppService()
appService.sessionToken = 'synthetic-session-token'
appService.me = { id: 'synthetic-user', teamId: 'synthetic-team' }

const firstAuthFence = deferred()
const firstAuthStarted = deferred()
const retryStorageFence = deferred()
const retryStorageStarted = deferred()
let authSuspensions = 0
let firstLogoutSettled = false
let firstLogoutError = null
let retryLogout = null
let retryLogoutSettled = false
let retryLogoutError = null
let savedCredential = true
let retryStorageHeld = false
let retryStorageSettled = false
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

let firstDrainStartedBeforeLogoutSettled = false
let retryDrainStartedBeforeStorageSettled = false
const tokenStoreDrain = appService.tokenStore.prepareForQuit.bind(appService.tokenStore)
appService.tokenStore.prepareForQuit = async () => {
  if (authSuspensions > 0 && !firstLogoutSettled) {
    firstDrainStartedBeforeLogoutSettled = true
  }
  if (retryStorageHeld && !retryStorageSettled) {
    retryDrainStartedBeforeStorageSettled = true
  }
  await tokenStoreDrain()
}

let willQuitObserved = false
let prepareCount = 0
let cancellationCount = 0
let preparationHeldPastDeadline = false
let authStateIntactBeforeRelease = false
let firstScenarioVerified = false
let retryScenarioVerified = false
let retryPreparationHeld = false
let resolveCancellation
const cancellationFinished = new Promise(resolve => {
  resolveCancellation = resolve
})
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

app.on('will-quit', () => {
  willQuitObserved = true
  if (
    prepareCount !== 2 ||
    cancellationCount !== 1 ||
    !firstScenarioVerified ||
    !retryScenarioVerified
  ) {
    console.error('admitted logout or canceled-attempt storage drain was not verified', {
      prepareCount,
      cancellationCount,
      preparationHeldPastDeadline,
      authStateIntactBeforeRelease,
      firstDrainStartedBeforeLogoutSettled,
      firstScenarioVerified,
      retryPreparationHeld,
      retryDrainStartedBeforeStorageSettled,
      retryScenarioVerified,
      firstLogoutRejected: Boolean(firstLogoutError),
      retryLogoutRejected: Boolean(retryLogoutError),
      savedCredential,
    })
    app.exit(7)
    return
  }
  console.log('WILL_QUIT')
})
app.on('quit', (_event, code) => {
  if (code === 0 && willQuitObserved) {
    console.log('QUIT_DRAIN_NATIVE_FIXTURE_PASS')
  }
})
app.on('window-all-closed', () => {
  if (!willQuitObserved) {
    console.error('window closed without completing the native quit')
    app.exit(7)
  }
})

registerQuitDrain(
  app,
  async () => {
    prepareCount += 1
    const preparation = appService.prepareForQuit()
    let preparationSettled = false
    void preparation.then(() => {
      preparationSettled = true
    })

    if (prepareCount === 1) {
      await sleep(5_100)
      preparationHeldPastDeadline = !preparationSettled && !firstLogoutSettled
      authStateIntactBeforeRelease =
        appService.sessionToken === 'synthetic-session-token' &&
        appService.me?.id === 'synthetic-user' &&
        savedCredential

      // The old deadline resumes quit first, so the real beforeunload veto
      // below releases this fence. The corrected path stays pending and the
      // fixture releases it after proving the five-second wait.
      if (!preparationSettled) {
        firstAuthFence.resolve()
        await Promise.all([preparation, firstLogout])
      } else {
        await preparation
      }
      return
    }

    await sleep(25)
    retryPreparationHeld =
      !preparationSettled &&
      !retryLogoutSettled &&
      !retryStorageSettled &&
      !retryDrainStartedBeforeStorageSettled
    retryStorageFence.resolve()
    await Promise.all([preparation, retryLogout])
    retryScenarioVerified =
      retryPreparationHeld &&
      !retryLogoutError &&
      retryStorageSettled &&
      !retryDrainStartedBeforeStorageSettled
  },
  () => {
    cancellationCount += 1
    appService.cancelQuitPreparation()
    resolveCancellation()
  }
)
setTimeout(() => app.exit(8), 12_000)

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
    const firstLogout = appService.logout().then(
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
          console.error('canceled quit recovery failed', error)
          app.exit(9)
        }
      })
    })
    setImmediate(() => app.quit())
  })
  .catch(error => {
    console.error(error)
    app.exit(9)
  })
