const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { registerQuitDrain } = require('../../dist/mainWindowCoordinator.js')

const profileRoot = process.argv.at(-1)
app.setName('Evenfire Quit Drain Fixture')
app.setPath('userData', profileRoot)
app.setPath('sessionData', profileRoot)
app.disableHardwareAcceleration()

let willQuitObserved = false
app.on('will-quit', () => {
  willQuitObserved = true
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

registerQuitDrain(app, async () => undefined)
setTimeout(() => app.exit(8), 10_000)

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    await window.loadURL('data:text/html,<title>Evenfire quit drain fixture</title>')
    setImmediate(() => process.kill(process.pid, 'SIGTERM'))
  })
  .catch(error => {
    console.error(error)
    app.exit(9)
  })
