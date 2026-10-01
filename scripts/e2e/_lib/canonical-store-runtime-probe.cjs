// Development-only, read-only evidence. The original SQLite file is opened
// readonly by the production inspector; all normalization happens in private
// scratch. Never emit business contents, credentials, or request bodies.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')

async function main() {
  const [mode, hostUid, pvcUid, directory, maintenanceId, podUid] = process.argv.slice(2)
  assert.ok(['catalog', 'fence', 'prepare', 'writer-stop', 'writer-resume'].includes(mode), 'probe mode')
  assert.match(hostUid || '', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  assert.match(pvcUid || '', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  // The caller resolves this exact path from the bound Deployment, and the
  // admitted contract has one state subPath. No discovery fallback is allowed.
  assert.equal(directory, '/var/lib/clerum/state')
  const Database = require('/app/mcp-host/node_modules/better-sqlite3')
  const fencePath = path.join(directory, '.canonical-store/writer-fence.db')
  assert.ok(fs.lstatSync(fencePath).isFile() && !fs.lstatSync(fencePath).isSymbolicLink())
  if (mode === 'writer-stop' || mode === 'writer-resume') {
    // Fault injection is confined to the synthetic Host's current container.
    // A reused PID/start frame must never be signalled.
    const currentFrame = pid => {
      const base = '/proc/' + pid
      assert.equal(fs.statSync(base).uid, process.getuid())
      const argv = fs.readFileSync(base + '/cmdline', 'utf8').split('\0')
      assert.equal(argv.length >= 2, true)
      assert.equal(fs.realpathSync(path.resolve(fs.realpathSync(base + '/cwd'), argv[1])), '/app/mcp-host/dist/main.js')
      const stat = fs.readFileSync(base + '/stat', 'utf8')
      return { pid, startTimeTicks: stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19] }
    }
    let frame
    if (mode === 'writer-stop') {
      const matches = []
      for (const entry of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
        const pid = Number(entry)
        if (pid === process.pid) continue
        const base = '/proc/' + pid
        try {
          if (fs.statSync(base).uid !== process.getuid()) continue
          const argv = fs.readFileSync(base + '/cmdline', 'utf8').split('\0')
          if (!argv[1] || fs.realpathSync(path.resolve(fs.realpathSync(base + '/cwd'), argv[1])) !== '/app/mcp-host/dist/main.js') continue
          matches.push(currentFrame(pid))
        } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      assert.equal(matches.length, 1, 'unique current writer process')
      frame = matches[0]
      const heldDescriptors = fs.readdirSync('/proc/' + frame.pid + '/fd').map(value => {
        try { return fs.readlinkSync('/proc/' + frame.pid + '/fd/' + value) }
        catch (error) { if (error.code === 'ENOENT') return ''; throw error }
      })
      assert.ok(heldDescriptors.includes(fencePath), 'writer must own the actual fence descriptor')
      process.kill(frame.pid, 'SIGSTOP')
    } else {
      assert.match(maintenanceId || '', /^[1-9][0-9]*$/)
      assert.match(podUid || '', /^[0-9]+$/)
      frame = currentFrame(Number(maintenanceId))
      assert.equal(frame.startTimeTicks, podUid)
      process.kill(frame.pid, 'SIGCONT')
    }
    process.stdout.write(JSON.stringify({ schemaVersion: 1, hostUid, pvcUid, ...frame, stopped: mode === 'writer-stop' }) + '\n')
    return
  }
  if (mode === 'fence') {
    const db = new Database(fencePath, { fileMustExist: true, timeout: 0 })
    try {
      assert.equal(db.pragma('journal_mode', { simple: true }), 'delete')
      try {
        db.exec('BEGIN EXCLUSIVE')
        db.exec('ROLLBACK')
        throw new Error('WriterFenceUnheld')
      } catch (error) {
        if (error.code !== 'SQLITE_BUSY') throw error
        process.stdout.write(JSON.stringify({ schemaVersion: 1, hostUid, pvcUid, fenceBusy: true }) + '\n')
      }
    } finally { db.close() }
    return
  }
  if (mode === 'prepare') {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    assert.match(maintenanceId || '', uuid)
    assert.match(podUid || '', uuid)
    const reportPath = path.join(directory, '.canonical-store/maintenance', maintenanceId, podUid + '.json')
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    assert.equal(report.hostUid, hostUid)
    assert.equal(report.pvcUid, pvcUid)
    assert.equal(report.maintenanceId, maintenanceId)
    assert.equal(report.podUid, podUid)
    assert.equal(report.closure, 'acknowledged-worker-exit')
    assert.equal(report.source.dbPath, directory + '/state.db')
    assert.ok(Number.isSafeInteger(report.process.pid) && report.process.pid > 0)
    assert.equal(report.process.uid, process.getuid())
    const processRoot = '/proc/' + report.process.pid
    assert.equal(fs.statSync(processRoot).uid, report.process.uid)
    assert.equal(fs.realpathSync(processRoot + '/exe'), report.process.executable)
    const stat = fs.readFileSync(processRoot + '/stat', 'utf8')
    assert.equal(stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19], report.process.startTimeTicks)
    const argv = fs.readFileSync(processRoot + '/cmdline', 'utf8').split('\0')
    assert.equal(fs.realpathSync(path.resolve(fs.realpathSync(processRoot + '/cwd'), argv[1])), report.process.script)
    for (const descriptor of fs.readdirSync(processRoot + '/fd')) {
      let target
      try { target = fs.readlinkSync(processRoot + '/fd/' + descriptor) }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      assert.ok(![directory + '/state.db', directory + '/state.db-wal', directory + '/state.db-shm', directory + '/state.db-journal'].includes(target), 'runtime still owns an SQLite descriptor')
    }
    const { validateLegacyStore } = require('/app/mcp-host/dist/db/canonicalStore/bootGuard.js')
    const floor = validateLegacyStore({ stateDir: directory, binding: { hostUid, pvcUid } })
    // Local closure evidence is only a diagnostic precondition. The controller
    // independently validates source identity/fds and native request authority.
    const { acquireWriterFence } = require('/app/mcp-host/dist/db/canonicalStore/writerFence.js')
    const { verifyPreparation } = require('/app/mcp-host/dist/db/canonicalStore/verification.js')
    const held = acquireWriterFence({ stateDir: directory, requireExisting: true, timeoutMs: 0 })
    try {
      const proof = await verifyPreparation('sqlite-pvc', {
        root: path.dirname(directory), binding: { hostUid, pvcUid },
        storageContract: 'canonical', maintenanceId, scratchRoot: '/tmp', fence: held,
      })
      held.assertHeld()
      process.stdout.write(JSON.stringify({ ...proof, schemaVersion: 1, podUid, diagnosticOnly: true, projection: 'state-subpath', sourceFloorMigrationId: floor.migrationId }) + '\n')
    } finally { held.close() }
    return
  }
  const { inspectCandidate, typedColumnProjection } = require('/app/mcp-host/dist/db/canonicalStore/inspectCandidate.js')
  const inspection = await inspectCandidate(directory, {
    root: directory, scratchRoot: '/tmp', scratchDir: '/tmp/.canonical-store-e2e',
    binding: { hostUid, pvcUid }, live: true, timeoutMs: 20000,
  })
  try {
    const db = new Database(inspection.normalizedPath, { readonly: true, fileMustExist: true })
    try {
      const ids = {}
      const rowHashes = {}
      for (const [table, key] of [['sessions', 'id'], ['messages', 'id'], ['pending_approvals', 'request_id']]) {
        // The Host is explicitly dedicated to this synthetic journey. Values
        // stay in process memory: only IDs and whole-row SHA256 leave the Pod.
        const columns = db.pragma(`table_xinfo(${table})`).filter(column => column.hidden === 0).map(column => column.name)
        // This evidence lane is dedicated to synthetic conversations. Refuse
        // a large/non-isolated catalog rather than allocating transcript rows
        // or dropping IDs silently; production inspection already streams all
        // business data before this bounded metadata projection.
        assert.ok(inspection.counts[table] <= 10000, 'synthetic journey evidence budget')
        ids[table] = db.prepare(`SELECT CAST(${key} AS TEXT) AS entity_id FROM ${table} ORDER BY ${key}`).all().map(row => row.entity_id)
        rowHashes[table] = []
        let index = 0
        const rows = db.prepare(`SELECT ${typedColumnProjection(columns)} FROM ${table} ORDER BY ${key}`).safeIntegers(true).iterate()
        for (const row of rows) {
          rowHashes[table].push({
            id: ids[table][index++],
            sha256: crypto.createHash('sha256').update(JSON.stringify(row, (_, value) =>
              typeof value === 'bigint' ? { integer: value.toString() } :
                typeof value === 'number' ? { real: Object.is(value, -0) ? '-0' : value.toString() } : value)).digest('hex'),
          })
        }
      }
      process.stdout.write(JSON.stringify({
        schemaVersion: 1, hostUid, pvcUid, projection: 'state-subpath', databasePath: directory + '/state.db',
        catalogHash: inspection.catalogHash, tableHashes: inspection.tableHashes,
        counts: inspection.counts, databaseSchemaVersion: inspection.schemaVersion,
        identity: inspection.identity || null, ids, rowHashes,
      }) + '\n')
    } finally { db.close() }
  } finally { inspection.dispose() }
}
main().catch(error => {
  // A reason is sufficient; avoid serializing engine errors or source paths.
  process.stderr.write(JSON.stringify({ outcome: 'blocked', reason: error.reason || 'RuntimeProbeFailed' }) + '\n')
  process.exitCode = 1
})
