const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { AppService } = require('../../dist/appService.js')
const { registerQuitDrain } = require('../../dist/mainWindowCoordinator.js')

const profileRoot = process.argv.at(-1)
app.setName('Evenfire Quit Drain Fixture')
app.setPath('userData', profileRoot)
app.setPath('sessionData', profileRoot)
app.disableHardwareAcceleration()

let willQuitObserved = false
let prepareCount = 0
let cancellationCount = 0
let producerSettled = false
let producerDrainVerified = false
let releasePendingProducer
let producerStartedResolve
const producerStarted = new Promise(resolve => {
  producerStartedResolve = resolve
})
const producerGate = new Promise(resolve => {
  releasePendingProducer = resolve
})
const appService = new AppService()
let logoutCalls = 0
appService.logoutOnce = async () => {
  logoutCalls += 1
  if (logoutCalls === 1) {
    producerStartedResolve()
    await producerGate
    producerSettled = true
  }
}
const tokenStoreDrain = appService.tokenStore.prepareForQuit.bind(appService.tokenStore)
let tokenStoreDrainStartedBeforeProducerSettled = false
appService.tokenStore.prepareForQuit = async () => {
  if (!producerSettled) tokenStoreDrainStartedBeforeProducerSettled = true
  await tokenStoreDrain()
}
app.on('will-quit', () => {
  willQuitObserved = true
  if (prepareCount !== 2 || cancellationCount !== 1 || !producerDrainVerified) {
    console.error('quit producer drain or canceled-attempt retry was not verified')
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
    if (prepareCount === 1) {
      let preparationSettled = false
      void preparation.then(() => {
        preparationSettled = true
      })
      await new Promise(resolve => setTimeout(resolve, 25))
      const heldProducerAcrossPreparation = !preparationSettled && !producerSettled
      releasePendingProducer()
      await preparation
      producerDrainVerified =
        heldProducerAcrossPreparation &&
        producerSettled &&
        !tokenStoreDrainStartedBeforeProducerSettled
      return
    }
    await preparation
  },
  () => {
    cancellationCount += 1
    appService.cancelQuitPreparation()
  }
)
setTimeout(() => app.exit(8), 10_000)

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
    const pendingLogout = appService.logout()
    await producerStarted
    window.webContents.once('will-prevent-unload', () => {
      setImmediate(async () => {
        try {
          await pendingLogout
          assert.equal(window.isDestroyed(), false)
          await assert.doesNotReject(appService.logout())
          await window.webContents.executeJavaScript('window.onbeforeunload = null; void 0')
          app.quit()
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
