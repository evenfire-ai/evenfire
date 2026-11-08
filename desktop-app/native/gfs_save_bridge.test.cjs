const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { after, test } = require('node:test')

const bridgePath = require.resolve('./build/Release/evenfire_gfs_save_bridge.node')
const bridge = require(bridgePath)
const bridgeSha256 = crypto.createHash('sha256').update(fs.readFileSync(bridgePath)).digest('hex')
process.stdout.write(
  `GFS_NATIVE_MODULE=${bridgePath} SHA256=${bridgeSha256} ` +
    `NODE=${process.version} NAPI=${process.versions.napi}\n`
)
const roots = []
const sessions = new Set()

after(() => {
  for (const session of sessions) bridge.closeSession(session)
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function openDestination(destination) {
  const session = bridge.openDestination(destination)
  sessions.add(session)
  return session
}

function tempRoot() {
  const configuredRoot = process.env.EVENFIRE_GFS_SAVE_TEST_ROOT
  const parent = configuredRoot ?? os.tmpdir()
  if (!path.isAbsolute(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error('GFS native test root must be an existing absolute directory')
  }
  const root = fs.mkdtempSync(path.join(parent, 'evenfire-gfs-native-'))
  roots.push(root)
  return root
}

function stage(destination, body) {
  const session = openDestination(destination)
  const stagePath = bridge.stagePath(session)
  const bytes = Buffer.from(body)
  assert.equal(fs.statSync(path.dirname(stagePath)).mode & 0o777, 0o700)
  assert.equal(fs.statSync(stagePath).mode & 0o777, 0o600)
  assert.equal(bridge.writeChunk(session, bytes), bytes.length)
  bridge.settleWriter(session, bytes.length)
  assert.throws(() => bridge.writeChunk(session, Buffer.from('late')))
  return { session, stagePath, bytes }
}

function qTokenReadExit(filePath, grantRead = false) {
  const powershell =
    process.env.EVENFIRE_GFS_POWERSHELL_PATH ??
    path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
  const probe = path.join(__dirname, 'test-q-token-access.ps1')
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    probe,
    '-Path',
    filePath,
  ]
  if (grantRead) args.push('-GrantRead')
  const result = require('node:child_process').spawnSync(powershell, args, {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const match = result.stdout.match(/Q_EXIT=(\d+)/)
  assert.ok(match, `secondary-principal probe omitted its exit code: ${result.stdout}`)
  return Number(match[1])
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
    assert.equal(
      fs.existsSync(path.join(accepted, 'saved.bin')),
      true,
      'the final entry must remain under the accepted directory object'
    )
    assert.equal(fs.existsSync(path.join(selected, 'saved.bin')), false)

    const acceptedAlias = path.join(accepted, aliasRelative)
    const aliasStat = fs.statSync(acceptedAlias)
    assert.equal(bridge.inspectFinal(staged.session), `${aliasStat.dev}:${aliasStat.ino}`)
    assert.equal(fs.readFileSync(path.join(accepted, 'saved.bin'), 'utf8'), 'accepted handle')
    assert.equal(fs.existsSync(path.join(selected, 'saved.bin')), false)
    let appliedMode
    let finalModeError
    try {
      appliedMode = bridge.applyFinalMode(staged.session, 0o640)
    } catch (error) {
      finalModeError = error
    }
    assert.equal(
      fs.statSync(path.join(accepted, 'saved.bin')).mode & 0o777,
      0o640,
      finalModeError?.message ?? 'retained-handle final mode was not applied'
    )
    assert.equal(appliedMode, 0o640)
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

    assert.throws(
      () => bridge.publishNoReplace(staged.session),
      /publish GFS file without replacement: .*file exists/i
    )
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
    const session = openDestination(path.join(selected, 'saved.bin'))
    const stagePath = bridge.stagePath(session)
    const observation = bridge.stageObservation(session)
    process.stdout.write(`GFS_WINDOWS_RENAME_PRECONDITION=${JSON.stringify(observation)}\n`)
    assert.equal(observation.daclProtected, true)
    assert.equal(observation.bytesWritten, 0)
    assert.equal(observation.bytesWrittenExact, '0')
    assert.equal(observation.physicalLength, 0)
    assert.match(observation.identity, /^[0-9A-F]{16}:[0-9A-F]{32}$/i)
    const body = Buffer.from('accepted Hdir')
    assert.equal(bridge.writeChunk(session, body), body.length)
    const afterWrite = bridge.stageObservation(session)
    assert.equal(afterWrite.bytesWritten, body.length)
    assert.equal(afterWrite.bytesWrittenExact, String(body.length))
    assert.equal(afterWrite.physicalLength, body.length)
    bridge.settleWriter(session, body.length)
    const afterSettlement = bridge.stageObservation(session)
    assert.equal(afterSettlement.bytesWritten, body.length)
    assert.equal(afterSettlement.bytesWrittenExact, String(body.length))
    assert.equal(afterSettlement.physicalLength, body.length)
    assert.throws(() => fs.readFileSync(stagePath))
    assert.equal(qTokenReadExit(stagePath), 5, 'Q-token denial must hold for the private stage')

    fs.renameSync(selected, accepted)
    fs.mkdirSync(selected)
    assert.equal(bridge.publishNoReplace(session), true)
    assert.equal(bridge.isPublished(session), true)
    assert.equal(bridge.inspectFinal(session), observation.identity)
    assert.equal(observation.directoryIsDiskHandle, true)
    assert.equal(observation.targetNameBytes, Buffer.byteLength('saved.bin', 'utf16le'))
    assert.ok(observation.directoryIdentity)
    assert.ok(observation.renameFileNameOffset > 0)
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
    const session = openDestination(path.join(selected, 'saved.bin'))
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
  'Windows private DACL denies a distinct Q token after retained handles close',
  {
    skip: process.platform !== 'win32',
  },
  () => {
    const root = tempRoot()
    const controlPath = path.join(root, 'q-readable-control.bin')
    fs.writeFileSync(controlPath, 'Q token control')
    assert.equal(qTokenReadExit(controlPath, true), 0, 'Q-token positive control must read')

    const finalPath = path.join(root, 'private-after-close.bin')
    const session = bridge.openDestination(finalPath)
    const observation = bridge.stageObservation(session)
    const bytes = Buffer.from('private after close')
    assert.equal(bridge.writeChunk(session, bytes), bytes.length)
    bridge.settleWriter(session, bytes.length)
    assert.equal(bridge.publishNoReplace(session), true)
    assert.equal(bridge.inspectFinal(session), observation.identity)
    bridge.closeSession(session)

    assert.equal(fs.readFileSync(finalPath, 'utf8'), 'private after close')
    assert.equal(qTokenReadExit(finalPath), 5, 'Q-token denial must be DACL access denied')
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
    const session = openDestination(destination)
    const body = Buffer.from('new bytes')
    bridge.writeChunk(session, body)
    bridge.settleWriter(session, body.length)
    assert.throws(() => bridge.publishNoReplace(session), /Win32 error (80|183)\b/)
    assert.equal(bridge.isPublished(session), false)
    assert.equal(fs.readFileSync(destination, 'utf8'), 'sentinel')
    bridge.closeSession(session)
  }
)
