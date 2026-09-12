import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createProxy } from '../e2e/_lib/hcc-watch-api-proxy.mjs'
import { createFixtureTls } from '../e2e/_lib/hcc-watch-tls.mjs'

test('rejects malformed publications once and accepts the next valid command', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const controlDir = mkdtempSync(join(tmpdir(), 'hcc-rejected-command-'))
  const tls = createFixtureTls('127.0.0.1')
  const proxy = createProxy({ ...tls, upstreamCa: tls.cert,
    allowedPaths: [], controlDir, periodMs: 60000, minAgeMs: 60000 })
  const rename = fs.renameSync
  let acknowledgements = 0
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === join(controlDir, 'ack.json')) acknowledgements += 1
    return rename(from, to)
  })
  const write = value => writeFileSync(join(controlDir, 'command.json'), value)
  const ack = () => JSON.parse(readFileSync(join(controlDir, 'ack.json'), 'utf8'))
  try {
    write(JSON.stringify({ id: 'invalid-action', action: 'unknown' }))
    t.mock.timers.tick(100)
    assert.deepEqual(ack(), { id: 'invalid-action', state: 'rejected' })
    t.mock.timers.tick(1000)
    assert.equal(acknowledgements, 1)
    write('{')
    t.mock.timers.tick(100)
    assert.deepEqual(ack(), { id: null, state: 'rejected' })
    t.mock.timers.tick(1000)
    assert.equal(acknowledgements, 2)
    write(JSON.stringify({ id: { untrusted: 'value' }, action: 'cut', kind: 'both' }))
    t.mock.timers.tick(100)
    assert.deepEqual(ack(), { id: null, state: 'rejected' })
    t.mock.timers.tick(1000)
    assert.equal(acknowledgements, 3)
    write(JSON.stringify({ id: 'valid-next', action: 'observe-bookmarks' }))
    t.mock.timers.tick(100)
    assert.deepEqual(ack(), { id: 'valid-next', state: 'observed' })
    assert.equal(acknowledgements, 4)
    write(JSON.stringify({ id: 'valid-next', action: 'unknown' }))
    t.mock.timers.tick(100)
    assert.equal(acknowledgements, 4, 'processed IDs remain idempotent')
  } finally {
    proxy.close()
    rmSync(controlDir, { recursive: true, force: true })
  }
})
