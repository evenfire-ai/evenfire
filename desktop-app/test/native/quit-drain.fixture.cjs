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
const appService = new AppService()
// Exercise AppService's real producer gate without touching a credential store.
appService.logoutOnce = async () => undefined
app.on('will-quit', () => {
  willQuitObserved = true
  if (prepareCount !== 2 || cancellationCount !== 1) {
    console.error('quit was not re-prepared after the canceled attempt')
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
    await appService.prepareForQuit()
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
    window.webContents.once('will-prevent-unload', () => {
      setImmediate(async () => {
        try {
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
