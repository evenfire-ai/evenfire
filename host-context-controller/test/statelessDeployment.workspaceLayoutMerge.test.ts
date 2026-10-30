/**
 * The workspace-layout merge init returns a split stateless PVC
 * (`state/` + `workspace/`) to the single layout every Host now uses: the PVC
 * root is the workspace and holds `state.db`. Trees are built the way they
 * arise on a cluster: a real SQLite database whose writer was killed with
 * uncheckpointed WAL frames, split by the base `workspace-layout-init`
 * (committed verbatim as a fixture), then merged by the new script.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWorkspaceLayoutMergeScript } from '../src/statelessDeployment'

const BASE_INIT = join(__dirname, '__fixtures__', 'base-workspace-layout-init.sh')
const ROWS = 40
const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodRecursive(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})

function chmodRecursive(dir: string): void {
  chmodSync(dir, 0o755)
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) chmodRecursive(join(dir, entry.name))
  }
}

interface RunResult {
  status: number
  stderr: string
}

function runScript(script: string, args: string[] = [], env?: NodeJS.ProcessEnv): RunResult {
  const res = spawnSync('/bin/sh', ['-c', script, 'sh', ...args], {
    encoding: 'utf8',
    env: env ?? process.env,
  })
  if (res.error) throw res.error
  return { status: res.status ?? -1, stderr: res.stderr ?? '' }
}

// deploy/scripts/host-layout-merge.sh predicts this merge on clusters from a
// committed copy of the script, run read-only. Every merge below without a
// crash env first asks it for a prediction and then checks it against what
// the merge did, so each tree in this file is also a drift case.
const DEPLOY_SCRIPTS = join(__dirname, '..', '..', 'deploy', 'scripts')
const MERGE_SCRIPT_COPY = join(DEPLOY_SCRIPTS, 'workspace-layout-merge.sh')
const VERIFY_SCRIPT = join(DEPLOY_SCRIPTS, 'host-layout-merge.sh')
const PREDICTED_TOKENS = new Set<string>()

function predictMerge(root: string): string {
  const printed = spawnSync('bash', [VERIFY_SCRIPT, 'check-script', '--root', root], {
    encoding: 'utf8',
  })
  if (printed.error) throw printed.error
  expect(printed.status, printed.stderr).toBe(0)
  const res = spawnSync('/bin/sh', ['-c', printed.stdout], { encoding: 'utf8' })
  if (res.error) throw res.error
  expect(res, `check on ${root}`).toMatchObject({ status: 0, stderr: '' })
  return res.stdout
}

function rootListing(root: string): string {
  return readdirSync(root).sort().join('\0')
}

function merge(root: string, env?: NodeJS.ProcessEnv): RunResult {
  if (env) return runScript(buildWorkspaceLayoutMergeScript(root), [], env)
  const predicted = predictMerge(root)
  // A root that is not a directory is refused, so it has no listing to compare.
  const before = statSync(root).isDirectory() ? rootListing(root) : null
  const res = runScript(buildWorkspaceLayoutMergeScript(root))
  const token = predicted.split(/[ \n]/, 1)[0]
  PREDICTED_TOKENS.add(token)
  if (res.status === 1) {
    expect(token, predicted).toMatch(/^WILL_REFUSE_F[1-4]$/)
    expect(predicted.slice(token.length + 1)).toBe(res.stderr)
  } else {
    expect(res.status, res.stderr).toBe(0)
    expect(before, `${root} merged without being a directory`).not.toBeNull()
    const after = rootListing(root)
    // A merge removes workspace/; superseding state/ leaves workspace/ in place.
    const superseded =
      before!.split('\0').includes('state') &&
      !after.split('\0').includes('state') &&
      after.split('\0').includes('workspace')
    const expected =
      after === before ? 'NO_SPLIT_SIGNATURE' : superseded ? 'WILL_SUPERSEDE' : 'WILL_MERGE'
    expect(predicted).toBe(`${expected}\n`)
  }
  return res
}

afterAll(() => {
  // Liveness of the drift check: every outcome was predicted at least once.
  expect([...PREDICTED_TOKENS].sort()).toEqual([
    'NO_SPLIT_SIGNATURE',
    'WILL_MERGE',
    'WILL_REFUSE_F1',
    'WILL_REFUSE_F2',
    'WILL_REFUSE_F3',
    'WILL_REFUSE_F4',
    'WILL_SUPERSEDE',
  ])
})

function baseInit(root: string): void {
  const res = runScript(readFileSync(BASE_INIT, 'utf8'), [root])
  expect(res, res.stderr).toMatchObject({ status: 0 })
}

/**
 * A stateful Host's PVC root: `ROWS` rows committed only to the WAL (the
 * writer is SIGKILLed with auto-checkpoint off), personalization files, a
 * user directory and the ext4 `lost+found`.
 */
function statefulRoot(): string {
  const root = tempDir('clerum-merge-')
  const writer = `
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(${JSON.stringify(join(root, 'state.db'))})
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA wal_autocheckpoint=0')
    db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
    const insert = db.prepare('INSERT INTO messages (body) VALUES (?)')
    for (let i = 0; i < ${ROWS}; i++) insert.run('message ' + i)
    process.kill(process.pid, 'SIGKILL')
  `
  const res = spawnSync(process.execPath, ['-e', writer])
  expect(res.signal).toBe('SIGKILL')
  mkdirSync(join(root, 'lost+found'))
  for (const name of ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'USER.md']) {
    writeFileSync(join(root, name), `${name} content`)
  }
  mkdirSync(join(root, 'users', 'u1'), { recursive: true })
  writeFileSync(join(root, 'users', 'u1', 'notes.md'), 'user notes')
  return root
}

/** A stateless Host's PVC as the base init leaves it. */
function splitRoot(): string {
  const root = statefulRoot()
  baseInit(root)
  return root
}

/** A committed SQLite database with `rows` messages, closed cleanly. */
function writeDb(dbPath: string, rows: number): void {
  const writer = `
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(${JSON.stringify(dbPath)})
    db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
    const insert = db.prepare('INSERT INTO messages (body) VALUES (?)')
    for (let i = 0; i < ${rows}; i++) insert.run('stateful ' + i)
    db.close()
  `
  const res = spawnSync(process.execPath, ['-e', writer], { encoding: 'utf8' })
  expect(res.status, res.stderr).toBe(0)
}

const STATEFUL_ROWS = 7

/**
 * A stateless Host switched back to stateful before the upgrade (T5): the
 * stateful Pod serves a new root state.db while the older history stays under
 * state/ next to workspace/. The two state/ shapes are the ones read on the
 * clerum PVCs on 2026-10-17.
 */
function supersededSplitRoot(stateShape: 'main only' | 'empty WAL and SHM'): string {
  const root = splitRoot()
  if (stateShape === 'main only') {
    rmSync(join(root, 'state', 'state.db-wal'))
    rmSync(join(root, 'state', 'state.db-shm'))
  } else {
    writeFileSync(join(root, 'state', 'state.db-wal'), '')
  }
  writeDb(join(root, 'state.db'), STATEFUL_ROWS)
  return root
}

function supersededName(root: string): string {
  const names = readdirSync(root).filter(n => n.startsWith('state.db.superseded-'))
  expect(names).toHaveLength(1)
  expect(names[0]).toMatch(/^state\.db\.superseded-\d{8}T\d{6}Z$/)
  return names[0]
}

function copyTree(root: string): string {
  const copy = tempDir('clerum-merge-copy-')
  rmSync(copy, { recursive: true })
  cpSync(root, copy, { recursive: true, verbatimSymlinks: true })
  return copy
}

/** Path → type and content hash for every entry, symlinks unresolved. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string, rel: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )
    for (const entry of entries) {
      const path = join(dir, entry.name)
      const key = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) out[key] = `link:${readlinkSync(path)}`
      else if (entry.isDirectory()) {
        out[key] = 'dir'
        walk(path, key)
      } else out[key] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(root, '')
  return out
}

/** Row count and quick_check, read in a child process (node:sqlite). */
function messageCount(dbPath: string): { rows: number; check: string } {
  const reader = `
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(${JSON.stringify(dbPath)})
    const rows = db.prepare('SELECT count(*) AS n FROM messages').get().n
    const check = db.prepare('PRAGMA quick_check').get().quick_check
    db.close()
    process.stdout.write(JSON.stringify({ rows, check }))
  `
  const res = spawnSync(process.execPath, ['-e', reader], { encoding: 'utf8' })
  expect(res.status, res.stderr).toBe(0)
  return JSON.parse(res.stdout) as { rows: number; check: string }
}

/** A PATH whose `mv` fails on call number `failAt` without moving anything. */
function crashingMvEnv(failAt: number): NodeJS.ProcessEnv {
  const bin = tempDir('clerum-merge-bin-')
  const counter = join(bin, 'count')
  writeFileSync(counter, '0')
  const realMv = spawnSync('/bin/sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).stdout.trim()
  writeFileSync(
    join(bin, 'mv'),
    `#!/bin/sh
n=$(( $(cat '${counter}') + 1 ))
echo "$n" > '${counter}'
[ "$n" -ne ${failAt} ] || exit 1
exec '${realMv}' "$@"
`,
    { mode: 0o755 }
  )
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, MV_COUNTER: counter }
}

function mvCalls(env: NodeJS.ProcessEnv): number {
  return Number(readFileSync(env.MV_COUNTER as string, 'utf8').trim())
}

describe('workspace layout merge', () => {
  it('ships the rendered script as the copy the verify script reads', () => {
    // The copy has no shebang (HCC runs it with `sh -c`), so its first line
    // names the shell for the T0 shellcheck gate.
    expect(
      readFileSync(MERGE_SCRIPT_COPY, 'utf8'),
      'regenerate deploy/scripts/workspace-layout-merge.sh from buildWorkspaceLayoutMergeScript()'
    ).toBe(`# shellcheck shell=sh\n${buildWorkspaceLayoutMergeScript()}`)
  })

  // A root state.db exists only after a stateful run that followed the last
  // stateless run (the base init moves it into state/ on every stateless
  // start), so state/ holds the older history. The base init kept the root
  // database and backed the state/ one up; the merge keeps the root one and
  // renames state/ whole, so no signature is left for a later start.
  it.each([
    { name: 'state/state.db only', shape: 'main only' as const, backup: false },
    {
      name: 'state/state.db with an empty WAL and SHM',
      shape: 'empty WAL and SHM' as const,
      backup: false,
    },
    { name: 'state/ with a .pre-*.bak copy', shape: 'main only' as const, backup: true },
  ])(
    'supersedes the stale state/ of a Host that went back to stateful (T5, $name)',
    ({ shape, backup }) => {
      const root = supersededSplitRoot(shape)
      if (backup) writeFileSync(join(root, 'state', 'state.db.pre-1.bak'), 'older backup')
      // The stateful run rewrote personalization files at the root too, so
      // the same names exist under workspace/.
      writeFileSync(join(root, 'SOUL.md'), 'stateful copy')
      const before = snapshot(root)
      expect(before['workspace/SOUL.md']).toBeDefined()
      expect(before['SOUL.md']).not.toBe(before['workspace/SOUL.md'])
      expect(before['state/state.db']).toBeDefined()

      expect(merge(root)).toEqual({ status: 0, stderr: '' })

      const after = snapshot(root)
      const superseded = supersededName(root)
      const expected: Record<string, string> = {}
      for (const [key, value] of Object.entries(before)) {
        const moved = key === 'state' || key.startsWith('state/')
        expected[moved ? `${superseded}${key.slice('state'.length)}` : key] = value
      }
      expect(after).toEqual(expected)
      if (backup) expect(after[`${superseded}/state.db.pre-1.bak`]).toBeDefined()

      // A second start finds no signature and changes nothing.
      expect(merge(root)).toEqual({ status: 0, stderr: '' })
      expect(snapshot(root)).toEqual(after)
      expect(messageCount(join(root, 'state.db'))).toEqual({ rows: STATEFUL_ROWS, check: 'ok' })
    },
    15_000
  )

  it('refuses to supersede state/ when the PVC root is not writable (F4)', () => {
    const root = supersededSplitRoot('main only')
    chmodSync(root, 0o555)
    const before = snapshot(root)

    const refused = merge(root)

    chmodSync(root, 0o755)
    expect(refused).toEqual({
      status: 1,
      stderr: `workspace layout merge refused: not writable by uid ${process.getuid!()}: ${root}\n`,
    })
    expect(snapshot(root)).toEqual(before)
    // Witness: once the root is writable the same tree is superseded.
    expect(merge(root)).toEqual({ status: 0, stderr: '' })
    expect(readdirSync(join(root, supersededName(root)))).toContain('state.db')
  }, 15_000)

  it('merges a superseded tree back after a rollback re-splits it with the base init', () => {
    // No root personalization file here: the base init refuses a name present
    // at the root and under workspace/, before and after this PR.
    const root = supersededSplitRoot('main only')
    expect(merge(root).status).toBe(0)
    const superseded = supersededName(root)
    const supersededTree = snapshot(root)

    baseInit(root)
    // Witness: the base init really split the tree again.
    expect(snapshot(root)['state/state.db']).toBe(supersededTree['state.db'])
    expect(merge(root)).toEqual({ status: 0, stderr: '' })

    // Roll-forward: the stale history and the served database are back at the
    // root, and the files the stateless run left under workspace/ are merged.
    const after = snapshot(root)
    const expected: Record<string, string> = {}
    for (const [key, value] of Object.entries(supersededTree)) {
      if (key === 'workspace') continue
      expected[key.startsWith('workspace/') ? key.slice('workspace/'.length) : key] = value
    }
    expect(after).toEqual(expected)
    expect(after[`${superseded}/state.db`]).toBe(supersededTree[`${superseded}/state.db`])
    expect(messageCount(join(root, 'state.db'))).toEqual({ rows: STATEFUL_ROWS, check: 'ok' })
  }, 15_000)

  it('merges a split tree with an uncheckpointed WAL back to the PVC root', () => {
    const root = splitRoot()
    // Witness that the split tree is the real one: the database and its
    // non-empty WAL sit under state/, agent files under workspace/.
    expect(statSync(join(root, 'state', 'state.db-wal')).size).toBeGreaterThan(0)
    expect(readFileSync(join(root, 'workspace', 'SOUL.md'), 'utf8')).toBe('SOUL.md content')

    expect(merge(root)).toEqual({ status: 0, stderr: '' })

    expect(readdirSync(root).sort()).toEqual([
      'AGENTS.md',
      'IDENTITY.md',
      'SOUL.md',
      'USER.md',
      'lost+found',
      'state.db',
      'state.db-shm',
      'state.db-wal',
      'users',
    ])
    expect(statSync(join(root, 'state.db-wal')).size).toBeGreaterThan(0)
    expect(readFileSync(join(root, 'users', 'u1', 'notes.md'), 'utf8')).toBe('user notes')
    expect(messageCount(join(root, 'state.db'))).toEqual({ rows: ROWS, check: 'ok' })
  }, 15_000)

  it('finishes a merge stopped after the journals moved and before the database', () => {
    const split = splitRoot()
    const interrupted = copyTree(split)
    // The merge moves every state/ entry except state.db first.
    renameSync(join(interrupted, 'state', 'state.db-wal'), join(interrupted, 'state.db-wal'))
    renameSync(join(interrupted, 'state', 'state.db-shm'), join(interrupted, 'state.db-shm'))
    for (const name of readdirSync(join(interrupted, 'workspace'))) {
      renameSync(join(interrupted, 'workspace', name), join(interrupted, name))
    }

    expect(merge(split).status).toBe(0)
    expect(merge(interrupted)).toEqual({ status: 0, stderr: '' })

    expect(snapshot(interrupted)).toEqual(snapshot(split))
    expect(messageCount(join(interrupted, 'state.db'))).toEqual({ rows: ROWS, check: 'ok' })
  }, 15_000)

  it.each([
    {
      name: 'a state.db file is a symlink',
      prepare: (root: string) => {
        renameSync(join(root, 'state', 'state.db-shm'), join(root, 'shm-real'))
        symlinkSync(join(root, 'shm-real'), join(root, 'state', 'state.db-shm'))
      },
      undo: (root: string) => {
        rmSync(join(root, 'state', 'state.db-shm'))
        renameSync(join(root, 'shm-real'), join(root, 'state', 'state.db-shm'))
      },
      message: 'SQLite file is a symlink',
    },
    {
      name: 'a state.db entry is a directory',
      prepare: (root: string) => {
        renameSync(join(root, 'state', 'state.db-shm'), join(root, 'shm-real'))
        mkdirSync(join(root, 'state', 'state.db-shm'))
      },
      undo: (root: string) => {
        rmSync(join(root, 'state', 'state.db-shm'), { recursive: true })
        renameSync(join(root, 'shm-real'), join(root, 'state', 'state.db-shm'))
      },
      message: 'SQLite file is not a regular file',
    },
    {
      // A root database is superseded over state/ only while workspace/ has none.
      name: 'live databases at the root and under workspace (F2)',
      prepare: (root: string) => {
        writeFileSync(join(root, 'state.db'), 'second database')
        writeFileSync(join(root, 'workspace', 'state.db'), 'third database')
      },
      undo: (root: string) => {
        rmSync(join(root, 'state.db'))
        rmSync(join(root, 'workspace', 'state.db'))
      },
      message: 'more than one live SQLite database',
    },
    {
      name: 'a second live database under workspace (F2)',
      prepare: (root: string) =>
        writeFileSync(join(root, 'workspace', 'state.db-wal'), 'orphan journal'),
      undo: (root: string) => rmSync(join(root, 'workspace', 'state.db-wal')),
      message: 'more than one live SQLite database',
    },
    {
      name: 'a workspace name that already exists at the root (F3)',
      prepare: (root: string) => writeFileSync(join(root, 'SOUL.md'), 'root copy'),
      undo: (root: string) => rmSync(join(root, 'SOUL.md')),
      message: 'destination exists',
    },
    {
      name: 'a name present under both state/ and workspace/ (F3)',
      prepare: (root: string) => writeFileSync(join(root, 'state', 'SOUL.md'), 'state copy'),
      undo: (root: string) => rmSync(join(root, 'state', 'SOUL.md')),
      message: 'exists under both state/ and workspace/',
    },
    {
      name: 'a lost+found under workspace/ that cannot be removed (F3)',
      prepare: (root: string) => mkdirSync(join(root, 'workspace', 'lost+found')),
      undo: (root: string) => rmSync(join(root, 'workspace', 'lost+found'), { recursive: true }),
      message: 'workspace/lost+found',
    },
    {
      name: 'state/ is not writable (F4)',
      prepare: (root: string) => chmodSync(join(root, 'state'), 0o555),
      undo: (root: string) => chmodSync(join(root, 'state'), 0o755),
      message: 'not writable',
    },
  ])(
    'refuses before the first move when $name',
    ({ prepare, undo, message }) => {
      const root = splitRoot()
      prepare(root)
      const before = snapshot(root)

      const refused = merge(root)

      expect(refused.status).toBe(1)
      expect(refused.stderr).toContain('workspace layout merge refused:')
      expect(refused.stderr).toContain(message)
      expect(refused.stderr.trim().split('\n')).toHaveLength(1)
      expect(snapshot(root)).toEqual(before)
      // Witness: once the cause is removed, the same tree merges.
      undo(root)
      expect(merge(root).status).toBe(0)
      expect(messageCount(join(root, 'state.db'))).toEqual({ rows: ROWS, check: 'ok' })
    },
    15_000
  )

  // A state/ that cannot be listed hides the signature from the glob; without
  // this check the merge would exit 0 and mcp-host would start on an empty
  // database next to the hidden one.
  it.each(['111', '333', '666'])(
    'refuses a state/ directory with mode %s before the signature check',
    mode => {
      const root = splitRoot()
      const before = snapshot(root)
      chmodSync(join(root, 'state'), parseInt(mode, 8))

      const refused = merge(root)

      chmodSync(join(root, 'state'), 0o755)
      expect(refused.status).toBe(1)
      expect(refused.stderr.trim()).toBe(
        `workspace layout merge refused: state directory is not readable and searchable: ${root}/state`
      )
      expect(snapshot(root)).toEqual(before)
      // Witness: with its mode restored the same tree merges.
      expect(merge(root).status).toBe(0)
      expect(messageCount(join(root, 'state.db'))).toEqual({ rows: ROWS, check: 'ok' })
    },
    15_000
  )

  // A workspace/ that can be entered and written but not listed hides its
  // entries from the globs: without this check the state files and state.db
  // would move, `rmdir workspace` would fail, and the next start (no
  // signature left) would exit 0 with the files stranded under workspace/.
  it.each(['333', '300'])(
    'refuses a workspace/ directory with mode %s before the first move',
    mode => {
      const root = splitRoot()
      const before = snapshot(root)
      chmodSync(join(root, 'workspace'), parseInt(mode, 8))

      const refused = merge(root)

      chmodSync(join(root, 'workspace'), 0o755)
      expect(refused.status).toBe(1)
      expect(refused.stderr.trim()).toBe(
        `workspace layout merge refused: workspace directory is not readable and searchable: ${root}/workspace`
      )
      expect(snapshot(root)).toEqual(before)
      // Witness: with its mode restored the same tree merges.
      expect(merge(root).status).toBe(0)
      expect(messageCount(join(root, 'state.db'))).toEqual({ rows: ROWS, check: 'ok' })
      expect(readdirSync(root)).not.toContain('workspace')
    },
    15_000
  )

  it('refuses before the first move when a source directory cannot be listed', () => {
    const root = splitRoot()
    mkdirSync(join(root, 'cache'))
    mkdirSync(join(root, 'workspace', 'cache'))
    writeFileSync(join(root, 'workspace', 'cache', 'entry'), 'cached')
    const before = snapshot(root)
    chmodSync(join(root, 'workspace', 'cache'), 0o333)

    const refused = merge(root)

    chmodSync(join(root, 'workspace', 'cache'), 0o755)
    expect(refused.status).toBe(1)
    expect(refused.stderr.trim()).toBe(
      `workspace layout merge refused: cannot list directory: ${root}/workspace/cache`
    )
    expect(snapshot(root)).toEqual(before)
    // Witness: once listable, the non-empty source is a real collision (F3).
    expect(merge(root).stderr).toContain(`destination exists: ${root}/cache`)
  }, 15_000)

  // Renaming a directory to a new parent rewrites its `..` entry, so it needs
  // write permission on that directory. Without this check the merge would
  // stop part-way with `mv: Permission denied` on every start.
  it.each(['workspace', 'state'])(
    'refuses before the first move when a directory under %s/ is not writable (F4)',
    source => {
      const root = splitRoot()
      const locked = join(root, source, 'readonly')
      mkdirSync(locked)
      writeFileSync(join(locked, 'entry'), 'kept')
      chmodSync(locked, 0o555)
      const before = snapshot(root)

      const refused = merge(root)

      expect(refused).toEqual({
        status: 1,
        stderr: `workspace layout merge refused: not writable by uid ${process.getuid!()}: ${locked}\n`,
      })
      expect(snapshot(root)).toEqual(before)
      // Witness: once writable, the same tree merges and the directory moves.
      chmodSync(locked, 0o755)
      expect(merge(root)).toEqual({ status: 0, stderr: '' })
      expect(readFileSync(join(root, 'readonly', 'entry'), 'utf8')).toBe('kept')
      expect(messageCount(join(root, 'state.db'))).toEqual({ rows: ROWS, check: 'ok' })
    },
    15_000
  )

  // A directory moved whole is renamed, never listed: an unlistable one with a
  // free name moves intact. Refusing it would let an agent's chmod stop the Host.
  it.each(['workspace', 'state'])(
    'moves an unlistable directory under %s/ whose name is free at the root',
    source => {
      const root = splitRoot()
      const hidden = join(root, source, 'hidden')
      mkdirSync(hidden)
      writeFileSync(join(hidden, 'entry'), 'kept')
      chmodSync(hidden, 0o333)

      const merged = merge(root)

      chmodSync(join(root, 'hidden'), 0o755)
      expect(merged).toEqual({ status: 0, stderr: '' })
      expect(readFileSync(join(root, 'hidden', 'entry'), 'utf8')).toBe('kept')
      expect(readdirSync(root)).not.toContain(source)
      expect(messageCount(join(root, 'state.db'))).toEqual({ rows: ROWS, check: 'ok' })
    },
    15_000
  )

  it('refuses a journal present both at the root and under state/ in a resumed merge', () => {
    const root = splitRoot()
    // A merge stopped after the journals moved, with a second copy of one.
    cpSync(join(root, 'state', 'state.db-wal'), join(root, 'state.db-wal'))
    const before = snapshot(root)

    const refused = merge(root)

    expect(refused).toEqual({
      status: 1,
      stderr: `workspace layout merge refused: destination exists: ${root}/state.db-wal\n`,
    })
    expect(snapshot(root)).toEqual(before)
    // Witness: with only the root copy left, the resumed merge completes.
    rmSync(join(root, 'state', 'state.db-wal'))
    expect(merge(root)).toEqual({ status: 0, stderr: '' })
    expect(messageCount(join(root, 'state.db'))).toEqual({ rows: ROWS, check: 'ok' })
  }, 15_000)

  it.each([
    {
      name: 'a symlink',
      prepare: () => {
        const parent = tempDir('clerum-merge-link-')
        const target = splitRoot()
        const root = join(parent, 'root')
        symlinkSync(target, root)
        return { root, watched: target, line: `workspace PVC root is a symlink: ${root}` }
      },
    },
    {
      name: 'not a directory',
      prepare: () => {
        const parent = tempDir('clerum-merge-file-')
        const root = join(parent, 'root')
        writeFileSync(root, 'not a directory')
        return { root, watched: parent, line: `workspace PVC root is not a directory: ${root}` }
      },
    },
    {
      name: '/',
      prepare: () => ({ root: '/', watched: undefined, line: 'workspace PVC root resolves to /' }),
    },
  ])(
    'refuses a PVC root that is $name before the signature check',
    ({ prepare }) => {
      const { root, watched, line } = prepare()
      const before = watched ? snapshot(watched) : undefined

      const refused = merge(root)

      expect(refused).toEqual({ status: 1, stderr: `workspace layout merge refused: ${line}\n` })
      if (watched) expect(snapshot(watched)).toEqual(before)
    },
    15_000
  )

  it('moves symlinks under workspace/ as links without following them', () => {
    const root = splitRoot()
    symlinkSync('/tmp/evenfire', join(root, 'workspace', 'evenfire'))
    symlinkSync('/workspace/users/u1/src', join(root, 'workspace', 'src-link'))

    expect(merge(root)).toEqual({ status: 0, stderr: '' })

    expect(readlinkSync(join(root, 'evenfire'))).toBe('/tmp/evenfire')
    expect(readlinkSync(join(root, 'src-link'))).toBe('/workspace/users/u1/src')
    expect(messageCount(join(root, 'state.db'))).toEqual({ rows: ROWS, check: 'ok' })
  }, 15_000)

  // $(basename ...) drops trailing newlines, which would rename the entry or
  // report a collision with a different name.
  it('moves an entry whose name ends in a newline under its exact name', () => {
    const root = splitRoot()
    writeFileSync(join(root, 'workspace', 'notes\n'), 'workspace file')
    writeFileSync(join(root, 'state', 'SOUL.md\n'), 'state file')

    expect(merge(root)).toEqual({ status: 0, stderr: '' })

    expect(readFileSync(join(root, 'notes\n'), 'utf8')).toBe('workspace file')
    expect(readFileSync(join(root, 'SOUL.md\n'), 'utf8')).toBe('state file')
    expect(readdirSync(root)).not.toContain('notes')
    expect(readFileSync(join(root, 'SOUL.md'), 'utf8')).toBe('SOUL.md content')
    expect(messageCount(join(root, 'state.db'))).toEqual({ rows: ROWS, check: 'ok' })
  }, 15_000)

  it('removes an empty source directory whose name exists at the root', () => {
    const root = splitRoot()
    mkdirSync(join(root, 'workspace', 'state'))

    expect(merge(root)).toEqual({ status: 0, stderr: '' })

    expect(readdirSync(root)).not.toContain('state')
    expect(messageCount(join(root, 'state.db'))).toEqual({ rows: ROWS, check: 'ok' })
  }, 15_000)

  it('reaches the uninterrupted result after a crash before any move', () => {
    const seed = splitRoot()
    const uninterrupted = copyTree(seed)
    const counting = crashingMvEnv(Number.MAX_SAFE_INTEGER)
    expect(merge(uninterrupted, counting).status).toBe(0)
    const moves = mvCalls(counting)
    // Witness: every workspace entry and every state/ entry was one rename.
    expect(moves).toBe(
      readdirSync(join(seed, 'workspace')).length + readdirSync(join(seed, 'state')).length
    )
    const expected = snapshot(uninterrupted)

    for (let failAt = 1; failAt <= moves; failAt++) {
      const root = copyTree(seed)
      const crashed = merge(root, crashingMvEnv(failAt))
      expect(crashed.status, `crash at move ${failAt}`).not.toBe(0)
      expect(merge(root), `re-run after move ${failAt}`).toEqual({ status: 0, stderr: '' })
      expect(snapshot(root), `tree after crash at move ${failAt}`).toEqual(expected)
    }
  }, 60_000)

  it('leaves empty state/ and workspace/ when it stops after the database moved', () => {
    const root = splitRoot()
    for (const name of readdirSync(join(root, 'workspace'))) {
      renameSync(join(root, 'workspace', name), join(root, name))
    }
    for (const name of readdirSync(join(root, 'state'))) {
      renameSync(join(root, 'state', name), join(root, name))
    }
    const before = snapshot(root)

    // Without a state.db* entry under state/ the tree is not split: no-op.
    expect(merge(root)).toEqual({ status: 0, stderr: '' })

    expect(snapshot(root)).toEqual(before)
    expect(before.state).toBe('dir')
    expect(before.workspace).toBe('dir')
    expect(messageCount(join(root, 'state.db'))).toEqual({ rows: ROWS, check: 'ok' })
  }, 15_000)

  it('leaves every tree without the split signature unchanged', () => {
    const cases: Record<string, (root: string) => void> = {
      'stateful or desktop root': () => undefined,
      'empty PVC': root => {
        for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true })
      },
      'files without a database': root => {
        for (const name of readdirSync(root).filter(n => n.startsWith('state.db'))) {
          rmSync(join(root, name))
        }
      },
      'user workspace/ folder': root => {
        mkdirSync(join(root, 'workspace'))
        writeFileSync(join(root, 'workspace', 'state.db'), 'user file')
      },
      'user state/ folder without state.db*': root => {
        mkdirSync(join(root, 'state'))
        writeFileSync(join(root, 'state', 'notes.md'), 'user file')
      },
      'state/ is a symlink': root => {
        mkdirSync(join(root, 'elsewhere'))
        writeFileSync(join(root, 'elsewhere', 'state.db'), 'not ours')
        symlinkSync(join(root, 'elsewhere'), join(root, 'state'))
      },
      'state is a regular file': root => {
        writeFileSync(join(root, 'state'), 'user file')
      },
      'state is a dangling symlink': root => {
        symlinkSync(join(root, 'missing'), join(root, 'state'))
      },
      'workspace is a symlink and there is no state/': root => {
        mkdirSync(join(root, 'elsewhere'))
        writeFileSync(join(root, 'elsewhere', 'SOUL.md'), 'user file')
        symlinkSync(join(root, 'elsewhere'), join(root, 'workspace'))
      },
      // The base init writes only state.db, its journals and their .bak copies.
      'user state/ folder with other state.db* names': root => {
        mkdirSync(join(root, 'state'))
        for (const name of ['state.db.json', 'state.dbx', 'state.db.notes', 'config.yaml']) {
          writeFileSync(join(root, 'state', name), 'user file')
        }
        mkdirSync(join(root, 'workspace'))
        writeFileSync(join(root, 'workspace', 'README.md'), 'user file')
      },
      // Its backups are state.db.pre-<ts>.bak, state.db-wal.pre-<ts>.bak and
      // state.db-shm.pre-<ts>.bak; any other .pre-*.bak name is a user file.
      'user state/ folder with .pre-*.bak names the base init never writes': root => {
        mkdirSync(join(root, 'state'))
        for (const name of [
          'state.dbX.pre-1.bak',
          'state.db.x.pre-1.bak',
          'state.db-journal.pre-1.bak',
        ]) {
          writeFileSync(join(root, 'state', name), 'user file')
        }
        mkdirSync(join(root, 'workspace'))
        writeFileSync(join(root, 'workspace', 'README.md'), 'user file')
      },
      // A desktop PVC never held the database before v1; a user project in
      // state/ must not be adopted as the conversation store.
      'desktop project state/{state.db,app.yml} without workspace/': root => {
        for (const name of readdirSync(root).filter(n => n.startsWith('state.db'))) {
          rmSync(join(root, name))
        }
        mkdirSync(join(root, 'state'))
        writeFileSync(join(root, 'state', 'state.db'), 'user database')
        writeFileSync(join(root, 'state', 'app.yml'), 'user file')
        mkdirSync(join(root, 'Desktop'))
      },
      'state/state.db with workspace a symlink': root => {
        mkdirSync(join(root, 'state'))
        writeFileSync(join(root, 'state', 'state.db'), 'user database')
        mkdirSync(join(root, 'elsewhere'))
        symlinkSync(join(root, 'elsewhere'), join(root, 'workspace'))
      },
      'state/state.db with workspace a regular file': root => {
        mkdirSync(join(root, 'state'))
        writeFileSync(join(root, 'state', 'state.db'), 'user database')
        writeFileSync(join(root, 'workspace'), 'user file')
      },
    }
    for (const [name, prepare] of Object.entries(cases)) {
      const root = statefulRoot()
      prepare(root)
      const before = snapshot(root)
      // Soft, so one failing case does not hide the others.
      expect.soft(merge(root), name).toEqual({ status: 0, stderr: '' })
      expect.soft(snapshot(root), name).toEqual(before)
    }
    // Witness: the split tree is changed by the same script.
    const split = splitRoot()
    const splitBefore = snapshot(split)
    expect(merge(split).status).toBe(0)
    expect(snapshot(split)).not.toEqual(splitBefore)
  }, 30_000)

  // The base init always leaves a real workspace/ directory. A split tree
  // without one carries no signature: the merge leaves it for an operator
  // (docs/architecture/host-storage-layout.md) rather than adopting it.
  it('leaves a split tree whose workspace/ is missing, a symlink or a file unchanged', () => {
    const cases: Record<string, (root: string) => void> = {
      'workspace/ is missing': root => {
        rmSync(join(root, 'workspace'), { recursive: true })
      },
      'workspace is a symlink': root => {
        renameSync(join(root, 'workspace'), join(root, 'workspace-real'))
        symlinkSync(join(root, 'workspace-real'), join(root, 'workspace'))
      },
      'workspace is a regular file': root => {
        renameSync(join(root, 'workspace'), join(root, 'workspace-real'))
        writeFileSync(join(root, 'workspace'), 'not a directory')
      },
    }
    for (const [name, prepare] of Object.entries(cases)) {
      const root = splitRoot()
      prepare(root)
      const before = snapshot(root)
      expect.soft(merge(root), name).toEqual({ status: 0, stderr: '' })
      expect.soft(snapshot(root), name).toEqual(before)
      // The history stays where the base init put it.
      expect.soft(messageCount(join(root, 'state', 'state.db')), name).toEqual({
        rows: ROWS,
        check: 'ok',
      })
    }
    // Witness: an intact split tree is merged by the same script.
    const split = splitRoot()
    expect(merge(split)).toEqual({ status: 0, stderr: '' })
    expect(messageCount(join(split, 'state.db'))).toEqual({ rows: ROWS, check: 'ok' })
  }, 30_000)

  it('restores the merged tree after a rollback re-splits it with the base init', () => {
    const root = splitRoot()
    expect(merge(root).status).toBe(0)
    const merged = snapshot(root)

    baseInit(root)
    // Witness: the base init really split the tree again.
    expect(snapshot(root)['state/state.db']).toBe(merged['state.db'])
    expect(merge(root)).toEqual({ status: 0, stderr: '' })

    expect(snapshot(root)).toEqual(merged)
    expect(messageCount(join(root, 'state.db'))).toEqual({ rows: ROWS, check: 'ok' })
  }, 15_000)

  it('a rollback init refuses a merged root holding a symlink and moves nothing', () => {
    const root = splitRoot()
    symlinkSync('/tmp/evenfire', join(root, 'workspace', 'evenfire'))
    expect(merge(root).status).toBe(0)
    const merged = snapshot(root)
    expect(merged.evenfire).toBe('link:/tmp/evenfire')

    const rolledBack = runScript(readFileSync(BASE_INIT, 'utf8'), [root])

    expect(rolledBack.status).toBe(1)
    expect(rolledBack.stderr).toContain(`legacy source is a symlink: ${root}/evenfire`)
    // It creates its two empty directories before validating the sources.
    const refusedTree = { ...merged, state: 'dir', workspace: 'dir' }
    expect(snapshot(root)).toEqual(refusedTree)
    // Rolling forward leaves those empty directories and the history intact.
    expect(merge(root)).toEqual({ status: 0, stderr: '' })
    expect(snapshot(root)).toEqual(refusedTree)
    expect(messageCount(join(root, 'state.db'))).toEqual({ rows: ROWS, check: 'ok' })
    // Witness: without the root symlink the same rollback init splits the tree.
    rmSync(join(root, 'evenfire'))
    baseInit(root)
    expect(readdirSync(join(root, 'state'))).toContain('state.db')
  }, 15_000)
})
