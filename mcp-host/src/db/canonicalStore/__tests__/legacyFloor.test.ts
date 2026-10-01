import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type Binding,
  type FsPort,
  type LegacyAdoptionRequest,
  type LegacyOperatorAuthorization,
  type LegacyRecoveryRequest,
  acquireWriterFence,
  adoptCanonicalStore,
  assertLegacyLayoutAllowed,
  beginLegacyRecovery,
  bootCheck,
  exportCanonicalStore,
  inspectLegacyRecovery,
  layoutPrecheck,
  legacyBootCheck,
  nodeFs,
  runMigration,
  validateLegacyStore,
  verifyCurrent,
  verifyPreparation,
} from '..'
import {
  type CanonicalOperatorRequest,
  type ResolvedCanonicalOperatorRequest,
  computeCanonicalOperatorRequestHash,
} from '../../../runtime/canonicalOperatorAuthorization'
import { runMigrations } from '../../migrate'
import { runCli } from '../cli'
import { catalogFingerprint } from '../inspectCandidate'
import * as inspector from '../inspectCandidate'
import {
  FINAL_MARKER,
  LEGACY_MARKER,
  LEGACY_STATE_RECORD,
  readJournal,
  readLegacyMarker,
} from '../journal'
import { fingerprints, objectHash, operationDirectory } from '../paths'

const binding: Binding = { hostUid: 'floor-host-825', pvcUid: 'floor-pvc-825' }
const roots: string[] = []
function fixture(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-floor-825-')))
  roots.push(root)
  return root
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function database(root: string, location = ''): Database.Database {
  const directory = path.join(root, location)
  fs.mkdirSync(directory, { recursive: true })
  const db = new Database(path.join(directory, 'state.db'))
  runMigrations(db)
  db.exec(`INSERT INTO sessions (id,session_key,source,user_id,team_id,started_at) VALUES ('s1','key1','desktop','u1','t1',1);
    INSERT INTO messages (session_id,ordinal,role,content,timestamp) VALUES ('s1',1,'user','accepted',1)`)
  recompute(db)
  return db
}
function recompute(db: Database.Database): void {
  db.exec(`UPDATE sessions SET message_count=(SELECT COUNT(*) FROM messages WHERE session_id=sessions.id AND (role='user' OR (role='assistant' AND tool_calls IS NULL))),
    turn_count=(SELECT COUNT(DISTINCT turn_number) FROM messages WHERE session_id=sessions.id AND turn_number IS NOT NULL),
    last_activity_at=MAX(COALESCE(last_activity_at,started_at),started_at,COALESCE((SELECT MAX(timestamp) FROM messages WHERE session_id=sessions.id),started_at))`)
}
function currentDb(root: string): Database.Database {
  return new Database(path.join(root, 'state', 'state.db'), { fileMustExist: true })
}
function currentCatalog(root: string): string {
  const db = currentDb(root)
  try {
    return catalogFingerprint(db).catalogHash
  } finally {
    db.close()
  }
}
function archived(root: string, migrationId: string) {
  return JSON.parse(
    fs.readFileSync(path.join(operationDirectory(root, migrationId), 'journal.json'), 'utf8')
  )
}
function proof(
  root: string,
  requestId: string,
  storageContract: 'canonical' | 'legacy-floor',
  request: unknown
) {
  return {
    ...binding,
    requestId,
    requestHash: computeCanonicalOperatorRequestHash(request as CanonicalOperatorRequest),
    storageContract,
    rootMountPath: root,
    rootReadOnly: false,
    hostResourceVersion: 'host-rv-1',
    pvcName: 'floor-test-pvc',
    pvcResourceVersion: 'pvc-rv-1',
    podName: 'floor-test-pod',
    podUid: randomUUID(),
    podResourceVersion: 'pod-rv-1',
    jobName: 'floor-test-job',
    jobUid: randomUUID(),
    jobResourceVersion: 'job-rv-1',
    image: 'fixture-image',
    templateRevision: objectHash('fixture-template'),
  }
}
/** Named trusted glue boundary; the authorization lane separately tests real fresh Kubernetes identity/capability resolution. */
async function mutationBoundary(
  root: string,
  storageContract: 'canonical' | 'legacy-floor' = 'legacy-floor',
  newHost = false
) {
  const maintenanceId = randomUUID()
  const requestId = randomUUID()
  const sourceClass = newHost ? 'new-host' : 'sqlite-pvc'
  const measured = await verifyPreparation(sourceClass, {
    root,
    binding,
    storageContract,
    maintenanceId,
    scratchRoot: fixture(),
  })
  const request = {
    schemaVersion: 1 as const,
    ...binding,
    requestId,
    maintenanceId,
    storageContract,
    operation: 'prepare' as const,
    principal: { kind: 'control-admin' as const, subject: 'operator' },
    targetImage: 'fixture-image',
    templateRevision: objectHash('fixture-template'),
    sourceClass,
    manifestHash: measured.manifestHash,
  }
  const p = proof(root, requestId, storageContract, request)
  const action = storageContract === 'legacy-floor' ? 'layout-precheck' : 'migrate'
  const kind = `${storageContract === 'legacy-floor' ? 'legacy-floor' : 'canonical'}-${newHost ? 'new-host-initialization' : 'migration'}`
  const resolved = {
    ...binding,
    binding,
    storageContract,
    maintenanceId,
    principal: 'operator',
    operation: 'prepare',
    action,
    request,
    proof: p,
    authorization: {
      ...binding,
      storageContract,
      kind,
      requestId,
      requestHash: computeCanonicalOperatorRequestHash(request as CanonicalOperatorRequest),
      maintenanceId,
      principal: 'operator',
      jobUid: p.jobUid,
      podUid: p.podUid,
      image: request.targetImage,
      templateRevision: request.templateRevision,
      verifiedManifestHash: measured.manifestHash,
      operation: 'prepare',
      action,
      ...(newHost ? { provisioning: { ...binding, createdAt: '2026-10-01T08:00:00.000Z' } } : {}),
    },
  } as ResolvedCanonicalOperatorRequest
  return {
    root,
    request,
    resolved,
    measured,
    args: [
      action,
      '--storage-contract',
      storageContract,
      '--root',
      root,
      '--host-uid',
      binding.hostUid,
      '--pvc-uid',
      binding.pvcUid,
      '--request-id',
      requestId,
      '--scratch-root',
      fixture(),
    ],
  }
}
function floorAuthorization(request: LegacyAdoptionRequest): LegacyOperatorAuthorization {
  return {
    ...binding,
    authorized: true,
    kind: 'legacy-floor-adoption',
    storageContract: 'legacy-floor',
    principal: 'operator',
    requestId: request.requestId,
    maintenanceId: request.maintenanceId,
  }
}
function adoptionBoundary(root: string, request: LegacyAdoptionRequest | LegacyRecoveryRequest) {
  const operatorRequest = {
    ...request,
    operation: 'adopt' as const,
    principal: { kind: 'control-admin' as const, subject: 'operator' },
  }
  return {
    ...binding,
    binding,
    storageContract: 'legacy-floor',
    maintenanceId: request.maintenanceId,
    principal: 'operator',
    operation: 'adopt',
    action: 'adopt',
    request,
    operatorRequest,
    authorization: {
      ...floorAuthorization(request),
      requestHash: computeCanonicalOperatorRequestHash(operatorRequest),
    },
    proof: proof(root, request.requestId, 'legacy-floor', operatorRequest),
  } as ResolvedCanonicalOperatorRequest
}

describe('legacy compatibility floor', () => {
  it.each(['', 'workspace', 'state'])(
    'moves %s data into the shared layout without installing identity',
    async location => {
      const root = fixture()
      database(root, location).close()
      fs.writeFileSync(path.join(root, 'notes.md'), 'workspace retained')
      const original = new Database(path.join(root, location, 'state.db'), { readonly: true })
      const before = catalogFingerprint(original).catalogHash
      original.close()
      const first = await layoutPrecheck(root, { binding })
      expect(first).toMatchObject({
        outcome: 'ok',
        storageContract: 'legacy-floor',
        layoutVersion: 1,
        databasePath: 'state/state.db',
        writerFenceRoot: 'state',
      })
      expect(first.storeId).toBeUndefined()
      expect(currentCatalog(root)).toBe(before)
      const db = currentDb(root)
      expect(db.prepare('SELECT COUNT(*) AS count FROM canonical_store_identity').get()).toEqual({
        count: 0,
      })
      db.close()
      expect(fs.existsSync(path.join(root, FINAL_MARKER))).toBe(false)
      expect(fs.readFileSync(path.join(root, 'workspace', 'notes.md'), 'utf8')).toBe(
        'workspace retained'
      )
      expect(JSON.parse(fs.readFileSync(path.join(root, LEGACY_MARKER), 'utf8'))).toEqual(
        JSON.parse(
          fs.readFileSync(path.join(root, 'state', '.canonical-store', LEGACY_STATE_RECORD), 'utf8')
        )
      )
      expect(archived(root, first.migrationId!).writer).toBe('layout-precheck')
      expect(legacyBootCheck(root, binding)).toMatchObject({
        reason: 'AlreadyLegacy',
        migrationId: first.migrationId,
      })
    }
  )
  it('keeps a winning state DB physically intact, including an empty identity table', async () => {
    const root = fixture()
    database(root, 'state').close()
    const before = objectHash(fingerprints(root, path.join(root, 'state')))
    const result = await layoutPrecheck(root, { binding })
    expect(objectHash(fingerprints(root, path.join(root, 'state')))).toBe(before)
    expect(archived(root, result.migrationId!).variant).toBe('keep-existing-state')
  })
  it('boots stable floor metadata after accepted writes without hashing conversation history', async () => {
    const root = fixture()
    database(root).close()
    const first = await layoutPrecheck(root, { binding })
    const db = currentDb(root)
    db.exec(
      "INSERT INTO messages (session_id,ordinal,role,content,timestamp) VALUES ('s1',2,'assistant','later',2)"
    )
    recompute(db)
    db.close()
    const hashSpy = vi.spyOn(inspector, 'catalogFingerprint')
    expect(legacyBootCheck(root, binding)).toMatchObject({
      migrationId: first.migrationId,
      reason: 'AlreadyLegacy',
    })
    expect(validateLegacyStore({ stateDir: path.join(root, 'state'), binding })).toEqual(
      readLegacyMarker(root, binding)
    )
    expect(hashSpy).not.toHaveBeenCalled()
    expect(() => assertLegacyLayoutAllowed(root, binding)).toThrow('LegacyStoreLayoutRollback')
    expect((await layoutPrecheck(root, { binding })).reason).toBe('AlreadyLegacy')
    expect(
      fs
        .readdirSync(path.join(root, 'state', '.canonical-store'))
        .filter(name => /^[0-9a-f-]{36}$/i.test(name))
    ).toHaveLength(1)
  })
  it.each([
    'missing-db',
    'missing-fence',
    'missing-state-record',
    'wrong-binding',
    'active-journal',
    'mismatched-root',
    'incomplete-archive',
    'missing-workspace',
  ])('fails closed on %s without repairing metadata or DB', async fault => {
    const root = fixture()
    database(root).close()
    const floor = await layoutPrecheck(root, { binding })
    const stateDir = path.join(root, 'state')
    if (fault === 'missing-workspace') fs.rmdirSync(path.join(root, 'workspace'))
    if (fault === 'missing-db') fs.unlinkSync(path.join(stateDir, 'state.db'))
    if (fault === 'missing-fence')
      fs.unlinkSync(path.join(stateDir, '.canonical-store', 'writer-fence.db'))
    if (fault === 'missing-state-record')
      fs.unlinkSync(path.join(stateDir, '.canonical-store', LEGACY_STATE_RECORD))
    if (fault === 'active-journal')
      fs.writeFileSync(path.join(stateDir, '.canonical-store', 'journal.json'), '{}')
    if (fault === 'mismatched-root')
      fs.writeFileSync(
        path.join(root, LEGACY_MARKER),
        JSON.stringify({ ...readLegacyMarker(root, binding), migrationId: randomUUID() })
      )
    if (fault === 'incomplete-archive') {
      const file = path.join(operationDirectory(root, floor.migrationId!), 'journal.json')
      const journal = JSON.parse(fs.readFileSync(file, 'utf8'))
      journal.phase = 'relocating'
      fs.writeFileSync(file, JSON.stringify(journal))
    }
    const before = fs.readdirSync(path.join(stateDir, '.canonical-store')).sort()
    expect(() =>
      legacyBootCheck(
        root,
        fault === 'wrong-binding' ? { ...binding, pvcUid: 'other-pvc' } : binding
      )
    ).toThrow()
    expect(fs.readdirSync(path.join(stateDir, '.canonical-store')).sort()).toEqual(before)
    if (fault === 'missing-db') expect(fs.existsSync(path.join(stateDir, 'state.db'))).toBe(false)
    if (fault === 'missing-workspace')
      expect(fs.existsSync(path.join(root, 'workspace'))).toBe(false)
    if (fault === 'missing-fence')
      expect(fs.existsSync(path.join(stateDir, '.canonical-store', 'writer-fence.db'))).toBe(false)
  })
  it('cannot create an empty floor from absence or a local provenance assertion', async () => {
    const root = fixture()
    const untouched = fixture()
    await expect(
      runCli([
        'layout-precheck',
        '--root',
        untouched,
        '--host-uid',
        binding.hostUid,
        '--pvc-uid',
        binding.pvcUid,
        '--operator-authorized',
      ])
    ).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
    expect(fs.readdirSync(untouched)).toEqual([])
    await expect(layoutPrecheck(root, { binding })).rejects.toMatchObject({
      reason: 'SourceExportRequired',
    })
    await expect(
      layoutPrecheck(root, {
        binding,
        provenance: { ...binding, kind: 'new-host', maintenanceId: 'claimed' },
      })
    ).rejects.toMatchObject({ reason: 'SourceExportRequired' })
    expect(fs.existsSync(path.join(root, 'state', 'state.db'))).toBe(false)
    await expect(
      runCli([
        'layout-precheck',
        '--root',
        root,
        '--host-uid',
        binding.hostUid,
        '--pvc-uid',
        binding.pvcUid,
        '--provenance',
        'new-host',
        '--operator-authorized',
      ])
    ).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
  })
  it('creates an empty floor only through the distinct authenticated newly-provisioned-PVC capability', async () => {
    const f = await mutationBoundary(fixture(), 'legacy-floor', true)
    const result = await runCli(f.args, { resolveOperatorRequest: async () => f.resolved })
    expect(fs.statSync(path.join(f.root, 'workspace')).isDirectory()).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.result).toMatchObject({
      reason: 'Created',
      storageContract: 'legacy-floor',
      catalogHash: currentCatalog(f.root),
    })
    expect((result.result as Record<string, unknown>).storeId).toBeUndefined()
    expect(
      validateLegacyStore({ stateDir: path.join(f.root, 'state'), binding }).databasePath
    ).toBe('state/state.db')
  })
  it.each(['orphan-operation', 'state-marker'])(
    'never treats retained %s metadata as a newly empty PVC',
    async fault => {
      const root = fixture()
      const records = path.join(root, 'state', '.canonical-store')
      fs.mkdirSync(records, { recursive: true })
      if (fault === 'orphan-operation') fs.mkdirSync(path.join(records, randomUUID()))
      else
        fs.writeFileSync(
          path.join(records, LEGACY_STATE_RECORD),
          JSON.stringify({
            markerVersion: 1,
            layoutVersion: 1,
            storageContract: 'legacy-floor',
            ...binding,
            migrationId: randomUUID(),
            databasePath: 'state/state.db',
            writerFenceRoot: 'state',
          })
        )
      await expect(
        verifyPreparation('new-host', {
          root,
          binding,
          storageContract: 'legacy-floor',
          maintenanceId: randomUUID(),
          scratchRoot: fixture(),
        })
      ).rejects.toMatchObject({ reason: 'SourceExportRequired' })
      expect(fs.existsSync(path.join(root, 'state', 'state.db'))).toBe(false)
    }
  )
  it('rejects a reserved workspace file before retiring the existing SQLite source', async () => {
    const root = fixture()
    database(root).close()
    fs.writeFileSync(path.join(root, 'workspace'), 'retained regular file')
    const before = fs.readFileSync(path.join(root, 'state.db'))
    await expect(layoutPrecheck(root, { binding })).rejects.toMatchObject({
      reason: 'LayoutUnsafe',
    })
    expect(fs.readFileSync(path.join(root, 'state.db'))).toEqual(before)
    expect(fs.readFileSync(path.join(root, 'workspace'), 'utf8')).toBe('retained regular file')
    expect(readJournal(root, binding)).toBeUndefined()
  })
  it('synchronizes both correlated marker names before persisting completed', async () => {
    const root = fixture()
    database(root).close()
    const events: Array<{ kind: 'rename' | 'sync'; file: string }> = []
    const descriptors = new Map<number, string>()
    let observed = false
    const port: FsPort = {
      ...nodeFs,
      openSync(file, flags, mode) {
        const fd = nodeFs.openSync(file, flags, mode)
        descriptors.set(fd, String(file))
        return fd
      },
      closeSync(fd) {
        nodeFs.closeSync(fd)
        descriptors.delete(fd)
      },
      fsyncSync(fd) {
        nodeFs.fsyncSync(fd)
        events.push({ kind: 'sync', file: descriptors.get(fd)! })
      },
      renameSync(from, to) {
        nodeFs.renameSync(from, to)
        events.push({ kind: 'rename', file: String(to) })
        if (
          String(to).endsWith('/.canonical-store/journal.json') &&
          JSON.parse(fs.readFileSync(to, 'utf8')).phase === 'completed'
        ) {
          observed = true
          for (const file of [
            path.join(root, LEGACY_MARKER),
            path.join(root, 'state', '.canonical-store', LEGACY_STATE_RECORD),
          ]) {
            const rename = events
              .map(event => event.kind === 'rename' && event.file === file)
              .lastIndexOf(true)
            const sync = events
              .map(event => event.kind === 'sync' && event.file === path.dirname(file))
              .lastIndexOf(true)
            expect(rename).toBeGreaterThan(-1)
            expect(sync).toBeGreaterThan(rename)
          }
        }
      },
    }
    await layoutPrecheck(root, { binding, fs: port })
    expect(observed).toBe(true)
  })
  it.each(['canonical', 'legacy-floor'] as const)(
    'normal %s boot rejects root/workspace lineage or unconsumed imports while current proof remains available for maintenance',
    async storageContract => {
      const root = fixture()
      database(root).close()
      if (storageContract === 'legacy-floor') await layoutPrecheck(root, { binding })
      else await runMigration(root, { binding })
      const normalBoot = storageContract === 'legacy-floor' ? legacyBootCheck : bootCheck
      const before = currentCatalog(root)
      fs.copyFileSync(path.join(root, 'state', 'state.db'), path.join(root, 'state.db'))
      expect(() => normalBoot(root, binding)).toThrow('ForeignCandidateAfterCanonical')
      fs.unlinkSync(path.join(root, 'state.db'))
      fs.copyFileSync(
        path.join(root, 'state', 'state.db'),
        path.join(root, 'workspace', 'state.db')
      )
      expect(() => normalBoot(root, binding)).toThrow('ForeignCandidateAfterCanonical')
      fs.unlinkSync(path.join(root, 'workspace', 'state.db'))
      const source = fixture()
      fs.copyFileSync(path.join(root, 'state', 'state.db'), path.join(source, 'state.db'))
      await exportCanonicalStore({
        root,
        sourcePath: path.join(source, 'state.db'),
        binding,
        exportId: randomUUID(),
        maintenanceId: 'maintenance-foreign-test',
      })
      expect(() => normalBoot(root, binding)).toThrow('ForeignCandidateAfterCanonical')
      const measured = await verifyCurrent({
        root,
        binding,
        storageContract,
        maintenanceId: 'maintenance-foreign-test',
        scratchRoot: fixture(),
      })
      expect(measured.currentCatalogHash).toBe(before)
      expect(currentCatalog(root)).toBe(before)
    }
  )
  it('canonical activation adds identity to current floor data without repeating workspace relocation', async () => {
    const root = fixture()
    database(root).close()
    fs.mkdirSync(path.join(root, 'project'))
    fs.writeFileSync(path.join(root, 'project', 'readme.md'), 'once')
    const floor = await layoutPrecheck(root, { binding })
    const db = currentDb(root)
    db.exec(
      "INSERT INTO messages (session_id,ordinal,role,content,timestamp) VALUES ('s1',2,'assistant','accepted after floor',2)"
    )
    recompute(db)
    db.close()
    const before = currentCatalog(root)
    const result = await runMigration(root, { binding })
    expect(result.storeId).toBeTruthy()
    expect(currentCatalog(root)).toBe(before)
    expect(fs.readFileSync(path.join(root, 'workspace', 'project', 'readme.md'), 'utf8')).toBe(
      'once'
    )
    expect(readLegacyMarker(root, binding)?.migrationId).toBe(floor.migrationId)
    const final = JSON.parse(fs.readFileSync(path.join(root, FINAL_MARKER), 'utf8'))
    expect(archived(root, final.migrationId).workspace).toEqual([])
    expect(archived(root, floor.migrationId!).writer).toBe('layout-precheck')
    expect(() => legacyBootCheck(root, binding)).toThrow('CanonicalStoreLayoutRollback')
    await expect(layoutPrecheck(root, { binding })).rejects.toThrow('CanonicalStoreLayoutRollback')
  })
})

describe('authenticated floor CLI continuation', () => {
  it.each([
    'started',
    'snapshotted',
    'staged',
    'retiring',
    'promotion',
    'workspace',
    'root-marker',
    'state-marker',
    'archived',
  ])('resumes the same operation after %s, rejecting an unbound request', async point => {
    const root = fixture()
    database(root).close()
    fs.writeFileSync(path.join(root, 'notes.md'), 'retained')
    const f = await mutationBoundary(root)
    let cuts = 0
    const port: FsPort = {
      ...nodeFs,
      renameSync(from, to) {
        nodeFs.renameSync(from, to)
        const target = String(to)
        const journalCut =
          target.endsWith('/.canonical-store/journal.json') &&
          ['started', 'snapshotted', 'staged'].includes(point) &&
          JSON.parse(fs.readFileSync(to, 'utf8')).phase === point
        const hit =
          journalCut ||
          (point === 'retiring' && target.includes('/retired/C_root/state.db')) ||
          (point === 'promotion' && target === path.join(root, 'state', 'state.db')) ||
          (point === 'workspace' && target === path.join(root, 'workspace', 'notes.md')) ||
          (point === 'root-marker' && target === path.join(root, LEGACY_MARKER)) ||
          (point === 'state-marker' &&
            target.endsWith(`/.canonical-store/${LEGACY_STATE_RECORD}`)) ||
          (point === 'archived' && String(from).endsWith('/.canonical-store/journal.json'))
        if (!cuts && hit) {
          cuts++
          throw new Error('floor crash cut')
        }
      },
    }
    await expect(
      runCli(f.args, { resolveOperatorRequest: async () => f.resolved, fs: port })
    ).rejects.toThrow('floor crash cut')
    expect(cuts).toBe(1)
    const wrong = structuredClone(f.resolved)
    wrong.request.requestId = randomUUID()
    wrong.authorization.requestId = wrong.request.requestId
    wrong.proof.requestId = wrong.request.requestId
    if (wrong.operation !== 'prepare' || wrong.action !== 'layout-precheck')
      throw new Error('fixture floor capability')
    wrong.proof.requestHash = computeCanonicalOperatorRequestHash(wrong.request)
    wrong.authorization.requestHash = wrong.proof.requestHash
    const badArgs = [...f.args]
    badArgs[badArgs.indexOf('--request-id') + 1] = wrong.request.requestId
    await expect(
      runCli(badArgs, { resolveOperatorRequest: async () => wrong })
    ).rejects.toMatchObject({ reason: 'AdoptBindingMismatch' })
    const fresh = {
      ...f.resolved,
      proof: { ...f.resolved.proof, podUid: randomUUID(), podResourceVersion: 'pod-rv-2' },
    } as ResolvedCanonicalOperatorRequest
    const result = await runCli(f.args, { resolveOperatorRequest: async () => fresh })
    expect(result.exitCode).toBe(0)
    expect(result.result).toMatchObject({
      storageContract: 'legacy-floor',
      catalogHash: currentCatalog(root),
    })
    const marker = readLegacyMarker(root, binding)!
    expect(archived(root, marker.migrationId).phase).toBe('completed')
    expect(readJournal(root, binding)).toBeUndefined()
    expect(legacyBootCheck(root, binding).migrationId).toBe(marker.migrationId)
    expect(fs.readFileSync(path.join(root, 'workspace', 'notes.md'), 'utf8')).toBe('retained')
  })
  it('keeps bound creation provenance exact when resuming a new floor', async () => {
    const f = await mutationBoundary(fixture(), 'legacy-floor', true)
    let cuts = 0
    const port: FsPort = {
      ...nodeFs,
      renameSync(from, to) {
        nodeFs.renameSync(from, to)
        if (
          !cuts &&
          String(to).endsWith('/.canonical-store/journal.json') &&
          JSON.parse(fs.readFileSync(to, 'utf8')).phase === 'started'
        ) {
          cuts++
          throw new Error('creation crash')
        }
      },
    }
    await expect(
      runCli(f.args, { resolveOperatorRequest: async () => f.resolved, fs: port })
    ).rejects.toThrow('creation crash')
    const wrong = structuredClone(f.resolved)
    if (
      wrong.operation !== 'prepare' ||
      wrong.action !== 'layout-precheck' ||
      wrong.authorization.kind !== 'legacy-floor-new-host-initialization'
    )
      throw new Error('fixture capability')
    wrong.authorization.provisioning.createdAt = '2026-10-01T09:00:00.000Z'
    await expect(
      runCli(f.args, { resolveOperatorRequest: async () => wrong })
    ).rejects.toMatchObject({ reason: 'AdoptBindingMismatch' })
    expect(
      (await runCli(f.args, { resolveOperatorRequest: async () => f.resolved })).exitCode
    ).toBe(0)
  })
  it('cannot reinterpret canonical capability as a floor mutation or reverse', async () => {
    const root = fixture()
    database(root).close()
    const canonical = await mutationBoundary(root, 'canonical')
    const floorArgs = [...canonical.args]
    floorArgs[0] = 'layout-precheck'
    floorArgs[2] = 'legacy-floor'
    await expect(
      runCli(floorArgs, { resolveOperatorRequest: async () => canonical.resolved })
    ).rejects.toMatchObject({ reason: 'AdoptBindingMismatch' })
    expect(fs.existsSync(path.join(root, LEGACY_MARKER))).toBe(false)
    expect(fs.existsSync(path.join(root, FINAL_MARKER))).toBe(false)
  })
})

describe('floor adoption and accepted-write recovery', () => {
  it('keeps the divergent floor writer, consumes an exact authenticated adoption once and retains every source', async () => {
    const root = fixture()
    database(root).close()
    const other = database(root, 'state')
    other.exec("UPDATE sessions SET title='other history'")
    other.close()
    const f = await mutationBoundary(root)
    expect(f.measured).toMatchObject({
      reason: 'InventoryVerified',
      candidateDisposition: 'divergent',
    })
    expect(f.measured.sourceHash).toBeUndefined()
    expect(f.measured.catalogHash).toBeUndefined()
    await expect(
      runCli(f.args, { resolveOperatorRequest: async () => f.resolved })
    ).rejects.toMatchObject({ reason: 'DivergentCandidates' })
    const journal = readJournal(root, binding)!
    expect(journal.writer).toBe('layout-precheck')
    expect(journal.phase).toBe('snapshotted')
    const request: LegacyAdoptionRequest = {
      ...binding,
      schemaVersion: 1,
      storageContract: 'legacy-floor',
      requestId: randomUUID(),
      maintenanceId: f.request.maintenanceId,
      migrationId: journal.migrationId,
      manifestHash: journal.manifestHash!,
      candidateHash: journal.candidates.find(candidate => candidate.id === 'C_root')!.sourceHash,
    }
    const resolved = adoptionBoundary(root, request)
    const args = [
      'adopt',
      '--storage-contract',
      'legacy-floor',
      '--root',
      root,
      '--host-uid',
      binding.hostUid,
      '--pvc-uid',
      binding.pvcUid,
      '--request-id',
      request.requestId,
      '--scratch-root',
      fixture(),
    ]
    await expect(
      adoptCanonicalStore(
        root,
        request,
        { ...floorAuthorization(request), kind: 'canonical-adoption' } as never,
        { binding }
      )
    ).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
    const adopted = await runCli(args, { resolveOperatorRequest: async () => resolved })
    expect(adopted.exitCode).toBe(0)
    expect(adopted.result).toMatchObject({
      reason: 'Adopted',
      storageContract: 'legacy-floor',
      migrationId: journal.migrationId,
    })
    expect((adopted.result as Record<string, unknown>).storeId).toBeUndefined()
    expect(archived(root, journal.migrationId).writer).toBe('layout-precheck')
    expect(
      fs.existsSync(
        path.join(operationDirectory(root, journal.migrationId), 'retired', 'C_root', 'state.db')
      )
    ).toBe(true)
    expect(
      fs.existsSync(
        path.join(operationDirectory(root, journal.migrationId), 'retired', 'C_state', 'state.db')
      )
    ).toBe(true)
    const replay = await runCli(args, { resolveOperatorRequest: async () => resolved })
    expect(replay.result).toEqual(adopted.result)
    const changed = {
      ...request,
      candidateHash: journal.candidates.find(candidate => candidate.id === 'C_state')!.sourceHash,
    }
    await expect(
      adoptCanonicalStore(root, changed, floorAuthorization(changed), { binding })
    ).rejects.toMatchObject({ reason: 'AdoptReplay' })
  })
  it('allows canonical authenticated preparation to retain divergent pins for the same journaled adoption flow', async () => {
    const root = fixture()
    database(root).close()
    const other = database(root, 'state')
    other.exec("UPDATE sessions SET title='divergent'")
    other.close()
    const f = await mutationBoundary(root, 'canonical')
    expect(f.measured).toMatchObject({
      reason: 'InventoryVerified',
      candidateDisposition: 'divergent',
    })
    await expect(
      runCli(f.args, { resolveOperatorRequest: async () => f.resolved })
    ).rejects.toMatchObject({ reason: 'DivergentCandidates' })
    const journal = readJournal(root, binding)!
    const request = {
      ...binding,
      schemaVersion: 1 as const,
      storageContract: 'canonical' as const,
      requestId: randomUUID(),
      maintenanceId: f.request.maintenanceId,
      migrationId: journal.migrationId,
      manifestHash: journal.manifestHash!,
      candidateHash: journal.candidates.find(candidate => candidate.id === 'C_root')!.sourceHash,
    }
    const operatorRequest = {
      ...request,
      operation: 'adopt' as const,
      principal: { kind: 'control-admin' as const, subject: 'operator' },
    }
    const requestHash = computeCanonicalOperatorRequestHash(operatorRequest)
    const resolved = {
      ...binding,
      binding,
      storageContract: 'canonical',
      maintenanceId: request.maintenanceId,
      principal: 'operator',
      operation: 'adopt',
      action: 'adopt',
      request,
      operatorRequest,
      authorization: {
        ...binding,
        authorized: true,
        kind: 'canonical-adoption',
        storageContract: 'canonical',
        requestId: request.requestId,
        requestHash,
        maintenanceId: request.maintenanceId,
        principal: 'operator',
      },
      proof: proof(root, request.requestId, 'canonical', operatorRequest),
    } as ResolvedCanonicalOperatorRequest
    const args = [
      'adopt',
      '--storage-contract',
      'canonical',
      '--root',
      root,
      '--host-uid',
      binding.hostUid,
      '--pvc-uid',
      binding.pvcUid,
      '--request-id',
      request.requestId,
      '--scratch-root',
      fixture(),
    ]
    const result = await runCli(args, { resolveOperatorRequest: async () => resolved })
    expect(result.result).toMatchObject({
      reason: 'Adopted',
      storageContract: 'canonical',
      catalogHash: currentCatalog(root),
      requestHash,
    })
    expect((result.result as Record<string, unknown>).storeId).toBeTruthy()
    expect(archived(root, journal.migrationId).writer).toBe('canonical-store')
    expect(
      fs.existsSync(
        path.join(operationDirectory(root, journal.migrationId), 'retired', 'C_state', 'state.db')
      )
    ).toBe(true)
    expect(
      fs.existsSync(
        path.join(operationDirectory(root, journal.migrationId), 'retired', 'C_root', 'state.db')
      )
    ).toBe(true)
  })
  it.each(['canonical', 'legacy-floor'] as const)(
    'rejects changes between authenticated %s inventory and mutator before retiring a source',
    async storageContract => {
      const root = fixture()
      database(root).close()
      const f = await mutationBoundary(root, storageContract)
      const changed = new Database(path.join(root, 'state.db'))
      changed.exec("UPDATE messages SET content='changed after proof'")
      changed.close()
      await expect(
        runCli(f.args, { resolveOperatorRequest: async () => f.resolved })
      ).rejects.toMatchObject({ reason: 'AdoptBindingMismatch' })
      expect(readJournal(root, binding)).toBeUndefined()
      expect(fs.existsSync(path.join(root, 'state.db'))).toBe(true)
    }
  )
  async function recoveryFixture(dropAccepted = false) {
    const root = fixture()
    database(root).close()
    const initial = await layoutPrecheck(root, { binding })
    const source = fixture()
    fs.copyFileSync(path.join(root, 'state', 'state.db'), path.join(source, 'state.db'))
    const recovered = new Database(path.join(source, 'state.db'))
    if (dropAccepted) recovered.exec('DELETE FROM messages WHERE ordinal=1')
    else
      recovered.exec(
        "INSERT INTO messages (session_id,ordinal,role,content,timestamp) VALUES ('s1',2,'assistant','recovered historical row',2)"
      )
    recompute(recovered)
    recovered.close()
    const exportId = randomUUID()
    const maintenanceId = randomUUID()
    await exportCanonicalStore({
      root,
      sourcePath: path.join(source, 'state.db'),
      binding,
      exportId,
      maintenanceId,
    })
    return { root, initial, exportId, maintenanceId }
  }
  it('blocks historical recovery that would lose an accepted floor row', async () => {
    const f = await recoveryFixture(true)
    const before = currentCatalog(f.root)
    await expect(
      inspectLegacyRecovery(f.root, `C_import:${f.exportId}`, { binding })
    ).rejects.toMatchObject({ reason: 'CandidateIncomplete' })
    expect(currentCatalog(f.root)).toBe(before)
    expect(readJournal(f.root, binding)).toBeUndefined()
  })
  it.each(['root-marker-retirement', 'state-marker-retirement', 'state-marker-write', 'archived'])(
    'replays accepted-write-preserving floor recovery after %s without creating a store ID',
    async point => {
      const f = await recoveryFixture()
      const pins = await inspectLegacyRecovery(f.root, `C_import:${f.exportId}`, { binding })
      expect(pins.expectedMigrationId).toBe(f.initial.migrationId)
      expect('expectedStoreId' in pins).toBe(false)
      const request: LegacyRecoveryRequest = {
        ...pins,
        ...binding,
        schemaVersion: 1,
        storageContract: 'legacy-floor',
        requestId: randomUUID(),
        maintenanceId: f.maintenanceId,
      }
      let cuts = 0
      const port: FsPort = {
        ...nodeFs,
        renameSync(from, to) {
          nodeFs.renameSync(from, to)
          const target = String(to)
          const hit =
            (point === 'root-marker-retirement' && target.endsWith('/previous-marker.json')) ||
            (point === 'state-marker-retirement' &&
              target.endsWith('/previous-state-marker.json')) ||
            (point === 'state-marker-write' &&
              target.endsWith(`/.canonical-store/${LEGACY_STATE_RECORD}`)) ||
            (point === 'archived' && String(from).endsWith('/.canonical-store/journal.json'))
          if (!cuts && hit) {
            cuts++
            throw new Error('recovery crash')
          }
        },
      }
      await expect(
        beginLegacyRecovery(f.root, request, floorAuthorization(request), { binding, fs: port })
      ).rejects.toThrow('recovery crash')
      expect(cuts).toBe(1)
      const result = await beginLegacyRecovery(f.root, request, floorAuthorization(request), {
        binding,
      })
      expect(result).toMatchObject({
        reason: 'Adopted',
        storageContract: 'legacy-floor',
        migrationId: request.migrationId,
      })
      const db = currentDb(f.root)
      expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 2 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM canonical_store_identity').get()).toEqual({
        count: 0,
      })
      db.close()
      expect(legacyBootCheck(f.root, binding).migrationId).toBe(request.migrationId)
      expect(
        await beginLegacyRecovery(f.root, request, floorAuthorization(request), { binding })
      ).toEqual(result)
      const retained = operationDirectory(f.root, request.migrationId)
      expect(
        JSON.parse(fs.readFileSync(path.join(retained, 'previous-marker.json'), 'utf8')).migrationId
      ).toBe(f.initial.migrationId)
      expect(
        JSON.parse(fs.readFileSync(path.join(retained, 'previous-state-marker.json'), 'utf8'))
          .migrationId
      ).toBe(f.initial.migrationId)
    }
  )
  it('pins a fresh current floor hash for release and rejects a stale historical hash', async () => {
    const root = fixture()
    database(root).close()
    const floor = await layoutPrecheck(root, { binding })
    const maintenanceId = randomUUID()
    const initial = currentCatalog(root)
    const fence = acquireWriterFence({ stateDir: path.join(root, 'state'), requireExisting: true })
    try {
      fence.assertHeld()
      const db = currentDb(root)
      try {
        fence.assertHeld()
        db.exec(
          "INSERT INTO messages (session_id,ordinal,role,content,timestamp) VALUES ('s1',2,'assistant','accepted after preparation',2)"
        )
        recompute(db)
      } finally {
        db.close()
      }
    } finally {
      fence.close()
    }
    const request = {
      schemaVersion: 1 as const,
      ...binding,
      storageContract: 'legacy-floor' as const,
      requestId: randomUUID(),
      operation: 'release' as const,
      maintenanceId,
      principal: { kind: 'control-admin' as const, subject: 'operator' },
      expectedMigrationId: floor.migrationId!,
      expectedCurrentCatalogHash: initial,
    }
    const p = proof(root, request.requestId, 'legacy-floor', request)
    const resolved = {
      ...binding,
      binding,
      storageContract: 'legacy-floor',
      maintenanceId,
      principal: 'operator',
      operation: 'release',
      action: 'verify-current',
      request,
      proof: p,
      authorization: {
        ...binding,
        storageContract: 'legacy-floor',
        kind: 'legacy-floor-verification',
        requestId: request.requestId,
        requestHash: computeCanonicalOperatorRequestHash(request as CanonicalOperatorRequest),
        maintenanceId,
        principal: 'operator',
        jobUid: p.jobUid,
        podUid: p.podUid,
        image: p.image,
        templateRevision: p.templateRevision,
        operation: 'release',
        action: 'verify-current',
      },
    } as ResolvedCanonicalOperatorRequest
    const args = [
      'verify-current',
      '--storage-contract',
      'legacy-floor',
      '--root',
      root,
      '--host-uid',
      binding.hostUid,
      '--pvc-uid',
      binding.pvcUid,
      '--request-id',
      request.requestId,
      '--scratch-root',
      fixture(),
    ]
    await expect(
      runCli(args, { resolveOperatorRequest: async () => resolved })
    ).rejects.toMatchObject({ reason: 'AdoptBindingMismatch' })
    if (resolved.operation !== 'release') throw new Error('fixture release')
    resolved.request.expectedCurrentCatalogHash = currentCatalog(root)
    resolved.proof.requestHash = computeCanonicalOperatorRequestHash(resolved.request)
    resolved.authorization.requestHash = resolved.proof.requestHash
    const good = await runCli(args, { resolveOperatorRequest: async () => resolved })
    expect(good.result).toMatchObject({
      storageContract: 'legacy-floor',
      migrationId: floor.migrationId,
      currentCatalogHash: currentCatalog(root),
      catalogHash: currentCatalog(root),
    })
    expect((good.result as Record<string, unknown>).storeId).toBeUndefined()
  })
  it('physical finalization requires its exact mutation catalog hash', async () => {
    const root = fixture()
    database(root).close()
    const floor = await layoutPrecheck(root, { binding })
    const maintenanceId = randomUUID()
    const requestId = randomUUID()
    const request = {
      schemaVersion: 1 as const,
      ...binding,
      storageContract: 'legacy-floor' as const,
      requestId,
      operation: 'prepare' as const,
      maintenanceId,
      principal: { kind: 'control-admin' as const, subject: 'operator' },
      targetImage: 'fixture-image',
      templateRevision: objectHash('fixture-template'),
      sourceClass: 'sqlite-pvc' as const,
    }
    const p = proof(root, requestId, 'legacy-floor', request)
    const resolved = {
      ...binding,
      binding,
      storageContract: 'legacy-floor',
      maintenanceId,
      principal: 'operator',
      operation: 'prepare',
      action: 'verify-current',
      request,
      proof: p,
      expectedMigrationId: floor.migrationId,
      expectedCurrentCatalogHash: '0'.repeat(64),
      authorization: {
        ...binding,
        storageContract: 'legacy-floor',
        kind: 'legacy-floor-finalization-verification',
        requestId,
        requestHash: computeCanonicalOperatorRequestHash(request as CanonicalOperatorRequest),
        maintenanceId,
        principal: 'operator',
        jobUid: p.jobUid,
        podUid: p.podUid,
        image: p.image,
        templateRevision: p.templateRevision,
        operation: 'prepare',
        action: 'verify-current',
        expectedMigrationId: floor.migrationId,
        expectedCurrentCatalogHash: '0'.repeat(64),
        mutatorJobUid: randomUUID(),
      },
    } as ResolvedCanonicalOperatorRequest
    const args = [
      'verify-current',
      '--storage-contract',
      'legacy-floor',
      '--operation',
      'prepare',
      '--root',
      root,
      '--host-uid',
      binding.hostUid,
      '--pvc-uid',
      binding.pvcUid,
      '--request-id',
      requestId,
      '--scratch-root',
      fixture(),
    ]
    await expect(
      runCli(args, { resolveOperatorRequest: async () => resolved })
    ).rejects.toMatchObject({ reason: 'AdoptBindingMismatch' })
    if (resolved.operation === 'prepare' && resolved.action === 'verify-current') {
      resolved.expectedCurrentCatalogHash = currentCatalog(root)
      resolved.authorization.expectedCurrentCatalogHash = resolved.expectedCurrentCatalogHash
    }
    expect((await runCli(args, { resolveOperatorRequest: async () => resolved })).exitCode).toBe(0)
  })
})
