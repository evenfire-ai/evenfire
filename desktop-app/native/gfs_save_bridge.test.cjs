const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { after, test } = require('node:test')

const bridge = require('./build/Release/evenfire_gfs_save_bridge.node')
const roots = []

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-gfs-native-'))
  roots.push(root)
  return root
}

function stage(destination, body) {
  const session = bridge.openDestination(destination)
  const stagePath = bridge.stagePath(session)
  const bytes = Buffer.from(body)
  assert.equal(fs.statSync(path.dirname(stagePath)).mode & 0o777, 0o700)
  assert.equal(fs.statSync(stagePath).mode & 0o777, 0o600)
  assert.equal(bridge.writeChunk(session, bytes), bytes.length)
  bridge.settleWriter(session, bytes.length)
  assert.throws(() => bridge.writeChunk(session, Buffer.from('late')))
  return { session, stagePath, bytes }
}

test(
  'publishes through the accepted directory object after its selected path is replaced',
  {
    skip: process.platform === 'win32',
  },
  () => {
    const root = tempRoot()
    const selected = path.join(root, 'selected')
    const accepted = path.join(root, 'accepted-object')
    fs.mkdirSync(selected)
    const staged = stage(path.join(selected, 'saved.bin'), 'accepted handle')
    const aliasRelative = path.relative(selected, staged.stagePath)

    fs.renameSync(selected, accepted)
    fs.mkdirSync(selected)
    bridge.publishNoReplace(staged.session)
    assert.equal(bridge.isPublished(staged.session), true)

    const acceptedAlias = path.join(accepted, aliasRelative)
    const aliasStat = fs.statSync(acceptedAlias)
    assert.equal(bridge.inspectFinal(staged.session), `${aliasStat.dev}:${aliasStat.ino}`)
    assert.equal(fs.readFileSync(path.join(accepted, 'saved.bin'), 'utf8'), 'accepted handle')
    assert.equal(fs.existsSync(path.join(selected, 'saved.bin')), false)
    assert.equal(bridge.applyFinalMode(staged.session, 0o640), 0o640)
    assert.equal(fs.statSync(path.join(accepted, 'saved.bin')).mode & 0o777, 0o640)
    bridge.cleanupStage(staged.session)
    assert.equal(fs.existsSync(acceptedAlias), false)
    assert.equal(fs.readFileSync(path.join(accepted, 'saved.bin'), 'utf8'), 'accepted handle')
    bridge.closeSession(staged.session)
  }
)

test(
  'accepts the valid directory currently resolved before handle acquisition',
  {
    skip: process.platform === 'win32',
  },
  () => {
    const root = tempRoot()
    const selected = path.join(root, 'selected')
    const prior = path.join(root, 'prior-object')
    fs.mkdirSync(selected)
    fs.renameSync(selected, prior)
    fs.mkdirSync(selected)

    const staged = stage(path.join(selected, 'saved.bin'), 'option two')
    bridge.publishNoReplace(staged.session)
    assert.equal(bridge.isPublished(staged.session), true)
    assert.equal(fs.readFileSync(path.join(selected, 'saved.bin'), 'utf8'), 'option two')
    assert.equal(fs.existsSync(path.join(prior, 'saved.bin')), false)
    bridge.cleanupStage(staged.session)
    bridge.closeSession(staged.session)
  }
)

test(
  'uses no-replace publication and preserves existing destination bytes',
  {
    skip: process.platform === 'win32',
  },
  () => {
    const root = tempRoot()
    const destination = path.join(root, 'saved.bin')
    fs.writeFileSync(destination, 'sentinel')
    const staged = stage(destination, 'new bytes')

    assert.throws(() => bridge.publishNoReplace(staged.session))
    assert.equal(bridge.isPublished(staged.session), false)
    assert.equal(fs.readFileSync(destination, 'utf8'), 'sentinel')
    bridge.cleanupStage(staged.session)
    bridge.closeSession(staged.session)
  }
)

test(
  'Windows publishes by retained Hdir after post-acceptance path replacement',
  {
    skip: process.platform !== 'win32',
  },
  () => {
    const root = tempRoot()
    const selected = path.join(root, 'selected')
    const accepted = path.join(root, 'accepted-object')
    fs.mkdirSync(selected)
    const session = bridge.openDestination(path.join(selected, 'saved.bin'))
    const stagePath = bridge.stagePath(session)
    const observation = bridge.stageObservation(session)
    assert.equal(observation.daclProtected, true)
    assert.equal(observation.length, 0)
    assert.match(observation.identity, /^[0-9A-F]{16}:[0-9A-F]{32}$/i)
    const body = Buffer.from('accepted Hdir')
    assert.equal(bridge.writeChunk(session, body), body.length)
    bridge.settleWriter(session, body.length)
    assert.throws(() => fs.readFileSync(stagePath))

    fs.renameSync(selected, accepted)
    fs.mkdirSync(selected)
    assert.equal(bridge.publishNoReplace(session), true)
    assert.equal(bridge.isPublished(session), true)
    assert.equal(bridge.inspectFinal(session), observation.identity)
    bridge.applyFinalAccess(session)
    assert.equal(bridge.inspectFinalAccess(session), 'intended')
    assert.equal(fs.existsSync(path.join(selected, 'saved.bin')), false)
    bridge.closeSession(session)
    assert.equal(fs.readFileSync(path.join(accepted, 'saved.bin'), 'utf8'), 'accepted Hdir')
    assert.equal(fs.existsSync(stagePath), false)
  }
)

test(
  'Windows accepts a validated pre-handle replacement and publishes without clobbering',
  {
    skip: process.platform !== 'win32',
  },
  () => {
    const root = tempRoot()
    const selected = path.join(root, 'selected')
    const prior = path.join(root, 'prior-object')
    fs.mkdirSync(selected)
    fs.renameSync(selected, prior)
    fs.mkdirSync(selected)
    const session = bridge.openDestination(path.join(selected, 'saved.bin'))
    const stagePath = bridge.stagePath(session)
    const body = Buffer.from('option two')
    bridge.writeChunk(session, body)
    bridge.settleWriter(session, body.length)
    assert.equal(bridge.publishNoReplace(session), true)
    assert.equal(bridge.isPublished(session), true)
    bridge.applyFinalAccess(session)
    assert.equal(bridge.inspectFinalAccess(session), 'intended')
    bridge.closeSession(session)
    assert.equal(fs.readFileSync(path.join(selected, 'saved.bin'), 'utf8'), 'option two')
    assert.equal(fs.existsSync(path.join(prior, 'saved.bin')), false)
    assert.equal(fs.existsSync(stagePath), false)
  }
)

test(
  'Windows no-replace collision preserves destination bytes',
  {
    skip: process.platform !== 'win32',
  },
  () => {
    const root = tempRoot()
    const destination = path.join(root, 'saved.bin')
    fs.writeFileSync(destination, 'sentinel')
    const session = bridge.openDestination(destination)
    const body = Buffer.from('new bytes')
    bridge.writeChunk(session, body)
    bridge.settleWriter(session, body.length)
    assert.throws(() => bridge.publishNoReplace(session))
    assert.equal(bridge.isPublished(session), false)
    assert.equal(fs.readFileSync(destination, 'utf8'), 'sentinel')
    bridge.closeSession(session)
  }
)
