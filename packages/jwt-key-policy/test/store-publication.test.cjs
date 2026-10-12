'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const policy = require('../index.cjs')
const storeApi = require('../dev-store.cjs')
const { digest, errno, expectReason, fixture, keyPair, publishPair, snapshot, storeWithPolicy, temporaries, withFsPatches } = require('./store-fixtures.cjs')
const pair = keyPair()
const other = keyPair()
const fingerprint = policy.publicKeyPemFingerprint(pair.publicKey)
const childFixture = path.join(__dirname, 'store-process-fixture.cjs')

function runChild(directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childFixture, 'sign', directory], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    const deadline = setTimeout(() => child.kill('SIGTERM'), 8000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.resume()
    child.once('error', failure => { clearTimeout(deadline); reject(failure) })
    child.once('close', (status, signal) => {
      clearTimeout(deadline)
      if (status !== 0) reject(new Error(`owned fixture process failed: status=${status}, signal=${signal}`))
      else {
        try { resolve(JSON.parse(stdout)) } catch { reject(new Error('owned fixture process emitted invalid metadata')) }
      }
    })
  })
}

test('two first processes and a restarted process converge on one complete identity', async t => {
  const { root } = fixture(t)
  const directory = path.join(root, 'first-start')
  const [first, second] = await Promise.all([runChild(directory), runChild(directory)])
  assert.equal(first.outcome, 'accepted')
  assert.deepEqual(second, first)
  const restart = await runChild(directory)
  assert.deepEqual(restart, first)
  assert.equal(storeApi.readDevVerifierMaterial('rpc', directory).fingerprint, first.fingerprint)
  assert.deepEqual(temporaries(directory), [])
})

for (const [name, finalFile, mode] of [['signing', 'rpc.pem', 0o600], ['public', 'rpc.public.pem', 0o644]]) {
  for (const collision of ['symlink', 'hardlink']) {
    test(`${name} temporary ${collision} collision preserves the fixture and every final file`, t => {
      const { root, store } = fixture(t)
      if (name === 'public') {
        publishPair(store, pair)
        fs.unlinkSync(path.join(store, 'rpc.public.pem'))
      }
      const victim = path.join(root, 'unrelated-owned-fixture')
      fs.writeFileSync(victim, 'synthetic preexisting bytes', { mode })
      const nonce = Buffer.alloc(6, 0x19)
      const candidate = `${path.join(store, finalFile)}.tmp-${process.pid.toString(36)}-${nonce.toString('hex')}`
      if (collision === 'symlink') fs.symlinkSync(victim, candidate)
      else fs.linkSync(victim, candidate)
      const before = snapshot(store)
      const victimBefore = digest(fs.readFileSync(victim))
      const random = crypto.randomBytes
      crypto.randomBytes = size => { assert.equal(size, nonce.length); return nonce }
      try { expectReason(() => storeApi.loadOrCreateDevSigningMaterial('rpc', store), 'temporary_collision') }
      finally { crypto.randomBytes = random }
      assert.equal(digest(fs.readFileSync(victim)), victimBefore)
      assert.deepEqual(snapshot(store), before)
      assert.equal(fs.existsSync(path.join(store, finalFile)), false)
      assert.equal(temporaries(store).length, 1)
    })
  }
}

test('other stale temporaries are preserved and are never adopted as identity', t => {
  const { store } = fixture(t)
  const stale = path.join(store, 'rpc.pem.tmp-old-operation')
  fs.writeFileSync(stale, 'synthetic unrelated temporary bytes', { mode: 0o600 })
  const before = digest(fs.readFileSync(stale))
  const accepted = storeApi.loadOrCreateDevSigningMaterial('rpc', store)
  assert.equal(storeApi.readDevVerifierMaterial('rpc', store).fingerprint, accepted.fingerprint)
  assert.equal(digest(fs.readFileSync(stale)), before)
  assert.deepEqual(temporaries(store), [path.basename(stale)])
})

for (const half of ['signing', 'public']) {
  for (const stage of ['open', 'fstat', 'write', 'link']) {
    test(`${half} publication ${stage} EIO preserves the prefix and cleans only its candidate`, t => {
      const { store } = fixture(t)
      if (half === 'public') {
        publishPair(store, pair)
        fs.unlinkSync(path.join(store, 'rpc.public.pem'))
      }
      const before = snapshot(store)
      const primary = errno('EIO')
      const held = new Map()
      let hit = false
      const isCandidate = file => typeof file === 'string' && file.includes('.tmp-')
      withFsPatches({
        openSync: original => (file, ...args) => {
          if (stage === 'open' && isCandidate(file)) { hit = true; throw primary }
          const fd = original(file, ...args)
          held.set(fd, file)
          return fd
        },
        closeSync: original => fd => { held.delete(fd); return original(fd) },
        fstatSync: original => fd => {
          if (stage === 'fstat' && isCandidate(held.get(fd))) { hit = true; throw primary }
          return original(fd)
        },
        writeSync: original => (fd, ...args) => {
          if (stage === 'write' && isCandidate(held.get(fd))) { hit = true; throw primary }
          return original(fd, ...args)
        },
        linkSync: original => (from, to) => {
          if (stage === 'link' && isCandidate(from)) { hit = true; throw primary }
          return original(from, to)
        },
      }, () => assert.throws(() => storeApi.loadOrCreateDevSigningMaterial('rpc', store), failure => failure === primary))
      assert.equal(hit, true)
      assert.equal(held.size, 0)
      assert.deepEqual(snapshot(store), before)
      assert.deepEqual(temporaries(store), [])
    })
  }
}

test('zero-byte writes fail rather than spinning and discard the owned candidate', t => {
  const { store } = fixture(t)
  withFsPatches({ writeSync: () => () => 0 }, () => expectReason(() => storeApi.loadOrCreateDevSigningMaterial('rpc', store), 'incomplete_write'))
  assert.deepEqual(fs.readdirSync(store), [])
})

test('short writes still publish complete material that passes the real reader', t => {
  const { store } = fixture(t)
  let writes = 0
  withFsPatches({ writeSync: original => (fd, buffer, offset, length, position) => {
    writes += 1
    return original(fd, buffer, offset, Math.min(23, length), position)
  } }, () => {
    const accepted = storeApi.loadOrCreateDevSigningMaterial('rpc', store)
    assert.equal(storeApi.readDevVerifierMaterial('rpc', store).fingerprint, accepted.fingerprint)
  })
  assert.equal(writes > 2, true)
  assert.deepEqual(temporaries(store), [])
})

test('cleanup failures never replace the primary publication failure', t => {
  const { store } = fixture(t)
  const primary = errno('EIO')
  const secondary = errno('EBUSY')
  let closed = false
  let unlinked = false
  withFsPatches({
    writeSync: () => () => { throw primary },
    closeSync: original => fd => { original(fd); closed = true; throw secondary },
    unlinkSync: original => file => { original(file); unlinked = true; throw secondary },
  }, () => assert.throws(() => storeApi.loadOrCreateDevSigningMaterial('rpc', store), failure => failure === primary))
  assert.equal(closed, true)
  assert.equal(unlinked, true)
  assert.deepEqual(fs.readdirSync(store), [])
})

test('a cleanup error after final publication fails without removing the final identity', t => {
  const { store } = fixture(t)
  const failure = errno('EIO')
  withFsPatches({ unlinkSync: original => file => { original(file); throw failure } }, () => assert.throws(() => storeApi.loadOrCreateDevSigningMaterial('rpc', store), error => error === failure))
  assert.deepEqual(fs.readdirSync(store), ['rpc.pem'])
  const before = snapshot(store)['rpc.pem']
  const accepted = storeApi.loadOrCreateDevSigningMaterial('rpc', store)
  assert.deepEqual(snapshot(store)['rpc.pem'], before)
  assert.equal(storeApi.readDevVerifierMaterial('rpc', store).fingerprint, accepted.fingerprint)
})

test('a private publication winner owns the identity, not the losing generated candidate', t => {
  const { root, store } = fixture(t)
  const source = path.join(root, 'winner')
  fs.mkdirSync(source, { mode: 0o700 })
  publishPair(source, other)
  let raced = false
  withFsPatches({ linkSync: original => (from, to) => {
    if (to === path.join(store, 'rpc.pem') && !raced) {
      raced = true
      original(path.join(source, 'rpc.pem'), to)
    }
    return original(from, to)
  } }, () => {
    const accepted = storeApi.loadOrCreateDevSigningMaterial('rpc', store)
    assert.equal(accepted.fingerprint, policy.publicKeyPemFingerprint(other.publicKey))
    assert.equal(storeApi.readDevVerifierMaterial('rpc', store).fingerprint, accepted.fingerprint)
  })
  assert.equal(raced, true)
  assert.deepEqual(temporaries(store), [])
})

for (const shape of ['corrupt', 'unsafe', 'symlink', 'directory']) {
  test(`a ${shape} signing winner fails without replacing it or publishing a public half`, t => {
    const { root, store } = fixture(t)
    const source = path.join(root, 'winner')
    fs.mkdirSync(source, { mode: 0o700 })
    publishPair(source, other)
    const selected = path.join(source, 'rpc.pem')
    if (shape === 'corrupt') fs.writeFileSync(selected, 'synthetic invalid signing fixture')
    if (shape === 'unsafe') fs.chmodSync(selected, 0o644)
    const before = snapshot(source)
    const final = path.join(store, 'rpc.pem')
    let raced = false
    withFsPatches({ linkSync: original => (from, to) => {
      if (to === final && !raced) {
        raced = true
        if (shape === 'symlink') fs.symlinkSync(selected, final)
        else if (shape === 'directory') fs.mkdirSync(final, { mode: 0o700 })
        else original(selected, final)
      }
      return original(from, to)
    } }, () => expectReason(() => storeApi.loadOrCreateDevSigningMaterial('rpc', store), {
      corrupt: 'invalid_pem', unsafe: 'insecure_file', symlink: 'symbolic_link', directory: 'not_regular_file',
    }[shape]))
    assert.equal(raced, true)
    assert.equal(fs.existsSync(final), true)
    assert.equal(fs.existsSync(path.join(store, 'rpc.public.pem')), false)
    assert.deepEqual(snapshot(source), before)
    assert.deepEqual(temporaries(store), [])
  })
}

for (const half of ['signing', 'public']) {
  test(`a generated-denied ${half} winner is rejected by the real policy`, t => {
    const { root, store } = fixture(t)
    const source = path.join(root, 'winner')
    fs.mkdirSync(source, { mode: 0o700 })
    publishPair(source, other)
    if (half === 'public') {
      publishPair(store, pair)
      fs.unlinkSync(path.join(store, 'rpc.public.pem'))
    }
    const denied = policy.publicKeyPemFingerprint(other.publicKey)
    const restricted = storeWithPolicy(real => ({ ...real,
      parseSigningMaterial: (raw, label) => real.parseSigningMaterial(raw, label, { fingerprints: [denied] }),
      parseVerifierMaterial: (raw, label, options) => real.parseVerifierMaterial(raw, label, { ...options, fingerprints: [denied] }),
    }))
    const leaf = half === 'signing' ? 'rpc.pem' : 'rpc.public.pem'
    const final = path.join(store, leaf)
    const selected = path.join(source, leaf)
    const before = digest(fs.readFileSync(selected))
    let raced = false
    withFsPatches({ linkSync: original => (from, to) => {
      if (to === final && !raced) { raced = true; original(selected, to) }
      return original(from, to)
    } }, () => expectReason(() => restricted.loadOrCreateDevSigningMaterial('rpc', store), 'banned_identity'))
    assert.equal(raced, true)
    assert.equal(digest(fs.readFileSync(final)), before)
    assert.deepEqual(temporaries(store), [])
  })
}

for (const winner of ['matching', 'mismatched', 'corrupt', 'unsafe']) {
  test(`the ${winner} public publication winner is validated and preserved`, t => {
    const { root, store } = fixture(t)
    publishPair(store, pair)
    fs.unlinkSync(path.join(store, 'rpc.public.pem'))
    const selected = path.join(root, 'winner-public')
    fs.writeFileSync(selected, winner === 'mismatched' ? other.publicKey : pair.publicKey, { mode: 0o644 })
    if (winner === 'corrupt') fs.writeFileSync(selected, 'synthetic invalid winner bytes')
    if (winner === 'unsafe') fs.chmodSync(selected, 0o666)
    const before = digest(fs.readFileSync(selected))
    let raced = false
    withFsPatches({ linkSync: original => (from, to) => {
      if (to === path.join(store, 'rpc.public.pem') && !raced) { raced = true; original(selected, to) }
      return original(from, to)
    } }, () => {
      const run = () => storeApi.loadOrCreateDevSigningMaterial('rpc', store)
      if (winner === 'matching') assert.equal(run().fingerprint, fingerprint)
      else expectReason(run, { mismatched: 'public_identity_mismatch', corrupt: 'invalid_pem', unsafe: 'insecure_file' }[winner])
    })
    assert.equal(raced, true)
    assert.equal(digest(fs.readFileSync(path.join(store, 'rpc.public.pem'))), before)
    assert.deepEqual(temporaries(store), [])
  })
}

for (const reason of ['file_owner_mismatch', 'not_regular_file', 'insecure_file']) {
  test(`public winner descriptor metadata ${reason} cannot be bypassed by its valid path`, t => {
    const { root, store } = fixture(t)
    publishPair(store, pair)
    const final = path.join(store, 'rpc.public.pem')
    fs.unlinkSync(final)
    const selected = path.join(root, 'winner-public')
    fs.writeFileSync(selected, pair.publicKey, { mode: 0o644 })
    const opened = new Map()
    let raced = false
    let checked = false
    withFsPatches({
      linkSync: original => (from, to) => { if (to === final && !raced) { raced = true; original(selected, to) } return original(from, to) },
      openSync: original => (file, ...args) => { const fd = original(file, ...args); opened.set(fd, file); return fd },
      closeSync: original => fd => { opened.delete(fd); return original(fd) },
      fstatSync: original => fd => {
        const stats = original(fd)
        if (raced && opened.get(fd) === final) {
          checked = true
          const changed = Object.create(stats)
          if (reason === 'file_owner_mismatch') changed.uid = process.geteuid() + 1
          if (reason === 'not_regular_file') changed.isFile = () => false
          if (reason === 'insecure_file') changed.mode = stats.mode | 0o022
          return changed
        }
        return stats
      },
    }, () => expectReason(() => storeApi.loadOrCreateDevSigningMaterial('rpc', store), reason))
    assert.equal(raced, true)
    assert.equal(checked, true)
    assert.equal(opened.size, 0)
    assert.equal(policy.publicKeyPemFingerprint(fs.readFileSync(final, 'utf8')), fingerprint)
    assert.deepEqual(temporaries(store), [])
  })
}

test('a public winner is validated through its descriptor even when its path is replaced', t => {
  const { root, store } = fixture(t)
  publishPair(store, pair)
  const final = path.join(store, 'rpc.public.pem')
  fs.unlinkSync(final)
  const bad = path.join(root, 'different-public')
  const good = path.join(root, 'matching-public')
  fs.writeFileSync(bad, other.publicKey, { mode: 0o644 })
  fs.writeFileSync(good, pair.publicKey, { mode: 0o644 })
  let raced = false
  let replaced = false
  withFsPatches({
    linkSync: original => (from, to) => { if (to === final && !raced) { raced = true; original(bad, to) } return original(from, to) },
    openSync: original => (file, ...args) => {
      const fd = original(file, ...args)
      if (file === final && raced && !replaced) { replaced = true; fs.renameSync(good, final) }
      return fd
    },
  }, () => expectReason(() => storeApi.loadOrCreateDevSigningMaterial('rpc', store), 'public_identity_mismatch'))
  assert.equal(replaced, true)
  assert.deepEqual(temporaries(store), [])
})
