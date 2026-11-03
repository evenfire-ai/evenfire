const assert = require('node:assert/strict')
const path = require('node:path')
const { app } = require('electron')

const profileRoot = path.resolve(process.argv.at(-1))
const expectedPaths = {
  appData: path.join(profileRoot, 'app-data'),
  userData: path.join(profileRoot, 'user-data'),
  sessionData: path.join(profileRoot, 'session-data'),
}
const configPath = path.join(profileRoot, 'runtime-config.json')

app.setName('Evenfire Quit Drain Fixture')
for (const [name, directory] of Object.entries(expectedPaths)) {
  app.setPath(name, directory)
}
process.env.CLERUM_DESKTOP_CONFIG_PATH = configPath

function assertOwnedPaths() {
  for (const [name, expectedPath] of Object.entries(expectedPaths)) {
    assert.equal(path.resolve(app.getPath(name)), expectedPath, `${name} path must be isolated`)
  }
  assert.equal(path.resolve(process.env.CLERUM_DESKTOP_CONFIG_PATH), configPath)
}

assertOwnedPaths()
require('./quit-drain.fixture.cjs')
assertOwnedPaths()
