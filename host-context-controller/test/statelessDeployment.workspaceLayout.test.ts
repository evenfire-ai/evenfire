import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWorkspaceLayoutInitScript } from '../src/statelessDeployment'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'clerum-workspace-layout-'))
  roots.push(root)
  return root
}

function runMigration(root: string): void {
  execFileSync('/bin/sh', ['-c', buildWorkspaceLayoutInitScript(root)], { stdio: 'pipe' })
}

function migrationFailure(root: string): { stderr?: Buffer } {
  try {
    runMigration(root)
  } catch (error) {
    return error as { stderr?: Buffer }
  }
  throw new Error('expected workspace layout migration to fail')
}

// Captures stderr even on SUCCESS (execFileSync only surfaces stderr on throw),
// so the loud round-trip resolution log can be asserted on a passing migration.
function runMigrationCapture(root: string): { status: number; stderr: string } {
  const res = spawnSync('/bin/sh', ['-c', buildWorkspaceLayoutInitScript(root)], {
    encoding: 'utf8',
  })
  if (res.error) throw res.error
  return { status: res.status ?? -1, stderr: res.stderr ?? '' }
}

function stateBackups(root: string, prefix = 'state.db'): string[] {
  return readdirSync(join(root, 'state'))
    .filter(name => name.startsWith(`${prefix}.pre-`) && name.endsWith('.bak'))
    .sort()
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('stateless workspace layout migration', () => {
  // This is the only case that launches the migration shell twice. Keep its
  // runner budget above the generic 5s limit so CI process contention cannot
  // turn a completed idempotency check into a harness timeout.
  it('moves legacy workspace and SQLite files once and is idempotent', () => {
    const root = makeRoot()
    writeFileSync(join(root, 'notes.md'), 'workspace-data')
    writeFileSync(join(root, 'state.db'), 'durable-db')

    runMigration(root)
    runMigration(root)

    expect(readFileSync(join(root, 'workspace', 'notes.md'), 'utf8')).toBe('workspace-data')
    expect(readFileSync(join(root, 'state', 'state.db'), 'utf8')).toBe('durable-db')
  }, 15_000)

  it('finishes a partial migration whose SQLite source is already under workspace', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'workspace'))
    writeFileSync(join(root, 'workspace', 'state.db'), 'durable-db')

    runMigration(root)

    expect(readFileSync(join(root, 'state', 'state.db'), 'utf8')).toBe('durable-db')
  })

  it.each([
    {
      rootArtifact: 'state.db',
      workspaceArtifact: 'state.db-wal',
    },
    {
      rootArtifact: 'state.db-shm',
      workspaceArtifact: 'state.db',
    },
  ])(
    'fails closed when $rootArtifact and $workspaceArtifact split SQLite source authority',
    ({ rootArtifact, workspaceArtifact }) => {
      const root = makeRoot()
      mkdirSync(join(root, 'workspace'))
      writeFileSync(join(root, 'notes.md'), 'must-stay-root')
      writeFileSync(join(root, rootArtifact), 'root-artifact')
      writeFileSync(join(root, 'workspace', workspaceArtifact), 'workspace-artifact')

      expect(String(migrationFailure(root).stderr)).toContain(
        'SQLite artifacts are split across root and workspace'
      )
      expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('must-stay-root')
      expect(readFileSync(join(root, rootArtifact), 'utf8')).toBe('root-artifact')
      expect(readFileSync(join(root, 'workspace', workspaceArtifact), 'utf8')).toBe(
        'workspace-artifact'
      )
    }
  )

  it('fails closed without overwriting a duplicate workspace entry', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'workspace'))
    writeFileSync(join(root, 'notes.md'), 'legacy-data')
    writeFileSync(join(root, 'workspace', 'notes.md'), 'current-data')

    expect(String(migrationFailure(root).stderr)).toContain('workspace layout migration collision')
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('legacy-data')
    expect(readFileSync(join(root, 'workspace', 'notes.md'), 'utf8')).toBe('current-data')
  })

  it('fails closed without overwriting an existing durable SQLite file', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'workspace'))
    mkdirSync(join(root, 'state'))
    writeFileSync(join(root, 'workspace', 'state.db'), 'legacy-db')
    writeFileSync(join(root, 'state', 'state.db'), 'current-db')

    expect(String(migrationFailure(root).stderr)).toContain('workspace layout migration collision')
    expect(readFileSync(join(root, 'workspace', 'state.db'), 'utf8')).toBe('legacy-db')
    expect(readFileSync(join(root, 'state', 'state.db'), 'utf8')).toBe('current-db')
  })

  it('resolves a root SQLite round-trip collision: backs up the older destination and migrates the fresher root source', () => {
    // Addendum 6 item 6 (newest-source-wins): a stateful<->stateless round-trip
    // leaves BOTH root state.db (freshest — the stateful life just left) and an
    // earlier stateless life's state/state.db. The migration must self-heal, not
    // deadlock: back up the older destination (never delete) and migrate the
    // fresher root source in, while non-SQLite root content still moves to
    // workspace/.
    const root = makeRoot()
    mkdirSync(join(root, 'workspace'))
    mkdirSync(join(root, 'state'))
    writeFileSync(join(root, 'notes.md'), 'must-migrate-to-workspace')
    writeFileSync(join(root, 'state.db'), 'fresh-stateful-db')
    writeFileSync(join(root, 'state', 'state.db'), 'older-stateless-db')

    const { status, stderr } = runMigrationCapture(root)

    expect(status).toBe(0)
    // Fresher root data migrated into the durable destination.
    expect(readFileSync(join(root, 'state', 'state.db'), 'utf8')).toBe('fresh-stateful-db')
    expect(existsSync(join(root, 'state.db'))).toBe(false)
    // Non-SQLite root content still migrated to workspace/.
    expect(readFileSync(join(root, 'workspace', 'notes.md'), 'utf8')).toBe(
      'must-migrate-to-workspace'
    )
    // Older destination preserved (never deleted) as a timestamped backup.
    const backups = stateBackups(root)
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(root, 'state', backups[0]), 'utf8')).toBe('older-stateless-db')
    // Loud one-line resolution log naming the backup + migration.
    expect(stderr).toContain('newest-source-wins round-trip resolution')
    expect(stderr).toContain('.pre-')
  })

  it('renames wal/shm destination companions in lockstep with the state.db backup', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'state'))
    for (const db of ['state.db', 'state.db-wal', 'state.db-shm']) {
      writeFileSync(join(root, db), `fresh-${db}`)
      writeFileSync(join(root, 'state', db), `older-${db}`)
    }

    const { status } = runMigrationCapture(root)
    expect(status).toBe(0)

    // All three fresher root companions migrated into state/.
    for (const db of ['state.db', 'state.db-wal', 'state.db-shm']) {
      expect(readFileSync(join(root, 'state', db), 'utf8')).toBe(`fresh-${db}`)
      expect(existsSync(join(root, db))).toBe(false)
    }
    // All three older destinations backed up under ONE shared timestamp suffix.
    const backups = readdirSync(join(root, 'state'))
      .filter(name => name.endsWith('.bak'))
      .sort()
    expect(backups).toHaveLength(3)
    const suffixes = new Set(
      backups.map(name => name.replace(/^state\.db(-wal|-shm)?\.pre-/, '').replace(/\.bak$/, ''))
    )
    expect(suffixes.size).toBe(1)
    expect(
      readFileSync(join(root, 'state', backups.find(f => f.startsWith('state.db.pre-'))!), 'utf8')
    ).toBe('older-state.db')
    expect(
      readFileSync(
        join(root, 'state', backups.find(f => f.startsWith('state.db-wal.pre-'))!),
        'utf8'
      )
    ).toBe('older-state.db-wal')
    expect(
      readFileSync(
        join(root, 'state', backups.find(f => f.startsWith('state.db-shm.pre-'))!),
        'utf8'
      )
    ).toBe('older-state.db-shm')
  })

  it('is idempotent after a backup: a second run with no root source is a no-op', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'state'))
    writeFileSync(join(root, 'state.db'), 'fresh-db')
    writeFileSync(join(root, 'state', 'state.db'), 'older-db')

    const first = runMigrationCapture(root)
    expect(first.status).toBe(0)
    const afterFirst = stateBackups(root)
    expect(afterFirst).toHaveLength(1)

    const second = runMigrationCapture(root)
    expect(second.status).toBe(0)
    // No new backup, destination unchanged, no resolution log on the no-op run.
    expect(stateBackups(root)).toEqual(afterFirst)
    expect(readFileSync(join(root, 'state', 'state.db'), 'utf8')).toBe('fresh-db')
    expect(second.stderr).not.toContain('newest-source-wins')
  })

  it('backs up under a NEW unique suffix on each later round-trip collision', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'state'))
    writeFileSync(join(root, 'state.db'), 'stateful-life-1')
    writeFileSync(join(root, 'state', 'state.db'), 'stateless-life-0')

    expect(runMigrationCapture(root).status).toBe(0)
    // A new stateful life re-creates the root source for a second round-trip.
    writeFileSync(join(root, 'state.db'), 'stateful-life-2')
    expect(runMigrationCapture(root).status).toBe(0)

    // Two distinct backups: nothing was overwritten across the two collisions.
    const backups = stateBackups(root)
    expect(backups).toHaveLength(2)
    const contents = backups.map(name => readFileSync(join(root, 'state', name), 'utf8')).sort()
    expect(contents).toEqual(['stateful-life-1', 'stateless-life-0'].sort())
    // Final durable state is the newest life.
    expect(readFileSync(join(root, 'state', 'state.db'), 'utf8')).toBe('stateful-life-2')
  })

  it('keeps a WORKSPACE SQLite source colliding with the destination fail-loud (genuinely ambiguous)', () => {
    // Only the ROOT round-trip collision self-heals. A workspace SQLite source
    // (an interrupted partial migration) colliding with an existing durable
    // destination stays fail-loud, preserving every source for recovery.
    const root = makeRoot()
    mkdirSync(join(root, 'workspace'))
    mkdirSync(join(root, 'state'))
    writeFileSync(join(root, 'workspace', 'state.db'), 'legacy-db')
    writeFileSync(join(root, 'state', 'state.db'), 'current-db')

    expect(String(migrationFailure(root).stderr)).toContain('workspace layout migration collision')
    expect(readFileSync(join(root, 'workspace', 'state.db'), 'utf8')).toBe('legacy-db')
    expect(readFileSync(join(root, 'state', 'state.db'), 'utf8')).toBe('current-db')
    expect(stateBackups(root)).toHaveLength(0)
  })

  it.each(['workspace', 'state'])(
    'rejects a symlinked %s directory without writing through it',
    managedDir => {
      const root = makeRoot()
      const outside = makeRoot()
      symlinkSync(outside, join(root, managedDir), 'dir')
      writeFileSync(join(root, managedDir === 'workspace' ? 'notes.md' : 'state.db'), 'must-stay')

      expect(String(migrationFailure(root).stderr)).toContain(
        `${managedDir} directory is a symlink`
      )
      expect(
        readFileSync(join(root, managedDir === 'workspace' ? 'notes.md' : 'state.db'), 'utf8')
      ).toBe('must-stay')
      expect(existsSync(join(outside, 'notes.md'))).toBe(false)
      expect(existsSync(join(outside, 'state.db'))).toBe(false)
    }
  )

  it('rejects a symlinked PVC root without touching its target', () => {
    const target = makeRoot()
    const parent = makeRoot()
    const linkedRoot = join(parent, 'workspace-root')
    writeFileSync(join(target, 'notes.md'), 'target-data')
    symlinkSync(target, linkedRoot, 'dir')

    expect(String(migrationFailure(linkedRoot).stderr)).toContain('PVC root is a symlink')
    expect(readFileSync(join(target, 'notes.md'), 'utf8')).toBe('target-data')
    expect(existsSync(join(target, 'workspace'))).toBe(false)
    expect(existsSync(join(target, 'state'))).toBe(false)
  })

  it('rejects a symlinked legacy source without moving it or touching its target', () => {
    const root = makeRoot()
    const outside = makeRoot()
    const outsideTarget = join(outside, 'target.txt')
    const source = join(root, 'notes.md')
    writeFileSync(outsideTarget, 'outside-data')
    symlinkSync(outsideTarget, source)

    expect(String(migrationFailure(root).stderr)).toContain('legacy source is a symlink')
    expect(lstatSync(source).isSymbolicLink()).toBe(true)
    expect(readFileSync(outsideTarget, 'utf8')).toBe('outside-data')
    expect(existsSync(join(root, 'workspace', 'notes.md'))).toBe(false)
  })

  it.each(['workspace', 'state'])(
    'rejects a symlinked SQLite artifact under %s without touching its target',
    sqliteDir => {
      const root = makeRoot()
      const outside = makeRoot()
      const outsideTarget = join(outside, 'outside-state.db')
      mkdirSync(join(root, sqliteDir))
      writeFileSync(outsideTarget, 'outside-db')
      symlinkSync(outsideTarget, join(root, sqliteDir, 'state.db'))
      if (sqliteDir === 'state') writeFileSync(join(root, 'state.db'), 'legacy-db')

      expect(String(migrationFailure(root).stderr)).toContain('SQLite')
      expect(readFileSync(outsideTarget, 'utf8')).toBe('outside-db')
      expect(lstatSync(join(root, sqliteDir, 'state.db')).isSymbolicLink()).toBe(true)
      if (sqliteDir === 'state')
        expect(readFileSync(join(root, 'state.db'), 'utf8')).toBe('legacy-db')
    }
  )
})
