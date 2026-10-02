import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type CanonicalMaintenanceOptions,
  CanonicalStoreMaintenance,
  type ConversationStoreMaintenanceStatus,
} from '../canonicalStoreMaintenance'

const roots: string[] = []
const binding = { hostUid: randomUUID(), pvcUid: randomUUID() }
const podUid = randomUUID()
const maintenanceId = randomUUID()
function fixture(overrides: Partial<CanonicalMaintenanceOptions> = {}) {
  const stateDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'canonical-maintenance-'))
  roots.push(stateDir)
  const quiesce = vi
    .fn()
    .mockResolvedValue({ mode: 'sqlite', dbPath: path.join(stateDir, 'state.db') })
  const activate = vi.fn()
  const discard = vi.fn().mockResolvedValue(undefined)
  const resume = vi.fn().mockResolvedValue({ activate, discard })
  const processIdentity = () => ({
    pid: 42,
    uid: 1001,
    startTimeTicks: '12345',
    executable: '/usr/local/bin/node',
    script: '/app/mcp-host/dist/main.js',
  })
  const manager = new CanonicalStoreMaintenance({
    binding,
    podUid,
    stateDir,
    quiesce,
    resume,
    processIdentity,
    ...overrides,
  })
  const report = path.join(
    stateDir,
    '.canonical-store',
    'maintenance',
    maintenanceId,
    `${podUid}.json`
  )
  return { manager, quiesce, resume, activate, discard, stateDir, report }
}
function host(phase: ConversationStoreMaintenanceStatus['phase']) {
  return {
    uid: binding.hostUid,
    status: { conversationStore: { maintenance: { ...binding, maintenanceId, phase } } },
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('durable conversation-store maintenance', () => {
  it('fences synchronously and publishes no report until the actual close callback completes', async () => {
    let complete!: (value: { mode: 'sqlite'; dbPath: string }) => void
    const closing = new Promise<{ mode: 'sqlite'; dbPath: string }>(resolve => {
      complete = resolve
    })
    const quiesce = vi.fn(() => closing)
    const fixtureData = fixture({ quiesce })
    const first = fixtureData.manager.observe(host('quiescing'))
    const duplicate = fixtureData.manager.observe(host('quiescing'))
    expect(first).toBe(duplicate)
    expect(fixtureData.manager.isFenced()).toBe(true)
    expect(fs.existsSync(fixtureData.report)).toBe(false)
    expect(quiesce).toHaveBeenCalledTimes(1)
    complete({ mode: 'sqlite', dbPath: path.join(fixtureData.stateDir, 'state.db') })
    await first
    const report = JSON.parse(fs.readFileSync(fixtureData.report, 'utf8'))
    expect(report).toMatchObject({
      ...binding,
      maintenanceId,
      podUid,
      schemaVersion: 1,
      closure: 'acknowledged-worker-exit',
    })
    expect(fs.statSync(fixtureData.report).mode & 0o777).toBe(0o600)
  })

  it('ignores missing status and ordinary wake changes until a same-bound operator release', async () => {
    const { manager, resume } = fixture()
    await manager.observe(host('quiescing'))
    await manager.observe({ uid: binding.hostUid })
    await manager.observe(host('completed'))
    expect(manager.isFenced()).toBe(true)
    expect(resume).not.toHaveBeenCalled()
    await manager.observe(host('released'))
    expect(resume).toHaveBeenCalledTimes(1)
    expect(manager.isFenced()).toBe(false)
  })

  it('never produces a closure report when a producer or worker failed to drain', async () => {
    const { manager, report } = fixture({
      quiesce: vi.fn().mockRejectedValue(new Error('accepted write failed')),
    })
    await expect(manager.observe(host('quiescing'))).rejects.toThrow('accepted write failed')
    expect(manager.isFenced()).toBe(true)
    expect(fs.existsSync(report)).toBe(false)
    await expect(manager.observe(host('released'))).rejects.toThrow('ReleaseBeforeQuiescence')
  })

  it('keeps admission closed when rebuilding the durable runtime on release fails', async () => {
    const { manager } = fixture({
      resume: vi.fn().mockRejectedValue(new Error('identity changed')),
    })
    await manager.observe(host('quiescing'))
    await expect(manager.observe(host('released'))).rejects.toThrow('identity changed')
    expect(manager.isFenced()).toBe(true)
  })

  it('rejects changed Host, PVC and maintenance bindings without publishing a report', async () => {
    for (const replacement of [
      { ...host('quiescing'), uid: randomUUID() },
      {
        uid: binding.hostUid,
        status: {
          conversationStore: {
            maintenance: {
              ...binding,
              pvcUid: randomUUID(),
              maintenanceId,
              phase: 'quiescing' as const,
            },
          },
        },
      },
    ]) {
      const { manager, quiesce, report } = fixture()
      await expect(manager.observe(replacement)).rejects.toThrow()
      expect(quiesce).not.toHaveBeenCalled()
      expect(manager.isFenced()).toBe(true)
      expect(fs.existsSync(report)).toBe(false)
    }
  })

  it.each(['quiescing', 'new-episode', 'missing', 'invalid-binding'] as const)(
    'discards a prepared runtime after release authority changes: %s',
    async change => {
      let complete!: (prepared: { activate(): void; discard(): Promise<void> }) => void
      const pending = new Promise<{ activate(): void; discard(): Promise<void> }>(resolve => {
        complete = resolve
      })
      const activate = vi.fn()
      const discard = vi.fn().mockResolvedValue(undefined)
      const { manager } = fixture({ resume: () => pending })
      await manager.observe(host('quiescing'))
      const release = manager.observe(host('released'))
      if (change === 'missing') await manager.observe({ uid: binding.hostUid })
      else if (change === 'new-episode') {
        void manager.observe({
          uid: binding.hostUid,
          status: {
            conversationStore: {
              maintenance: { ...binding, maintenanceId: randomUUID(), phase: 'quiescing' },
            },
          },
        })
      } else if (change === 'invalid-binding') {
        await expect(
          manager.observe({ uid: randomUUID(), status: host('quiescing').status })
        ).rejects.toThrow()
      } else void manager.observe(host('quiescing'))
      complete({ activate, discard })
      await release
      expect(activate).not.toHaveBeenCalled()
      expect(discard).toHaveBeenCalledOnce()
      expect(manager.isFenced()).toBe(true)
    }
  )

  it('reports a new episode after discarding the previous prepared runtime', async () => {
    let complete!: (prepared: { activate(): void; discard(): Promise<void> }) => void
    const pending = new Promise<{ activate(): void; discard(): Promise<void> }>(resolve => {
      complete = resolve
    })
    const f = fixture({ resume: () => pending })
    await f.manager.observe(host('quiescing'))
    const release = f.manager.observe(host('released'))
    const nextId = randomUUID()
    const next = f.manager.observe({
      uid: binding.hostUid,
      status: {
        conversationStore: {
          maintenance: { ...binding, maintenanceId: nextId, phase: 'quiescing' },
        },
      },
    })
    const activate = vi.fn()
    const discard = vi.fn().mockResolvedValue(undefined)
    complete({ activate, discard })
    await Promise.all([release, next])
    expect(activate).not.toHaveBeenCalled()
    expect(discard).toHaveBeenCalledOnce()
    expect(f.manager.isFenced()).toBe(true)
    expect(f.quiesce).toHaveBeenCalledTimes(2)
    const report = path.join(
      f.stateDir,
      '.canonical-store',
      'maintenance',
      nextId,
      `${podUid}.json`
    )
    expect(JSON.parse(fs.readFileSync(report, 'utf8')).maintenanceId).toBe(nextId)
  })

  it('unchanged repeated release prepares and activates exactly once', async () => {
    let complete!: (prepared: { activate(): void; discard(): Promise<void> }) => void
    const pending = new Promise<{ activate(): void; discard(): Promise<void> }>(resolve => {
      complete = resolve
    })
    const activate = vi.fn()
    const discard = vi.fn().mockResolvedValue(undefined)
    const resume = vi.fn(() => pending)
    const { manager } = fixture({ resume })
    await manager.observe(host('quiescing'))
    const first = manager.observe(host('released'))
    const duplicate = manager.observe(host('released'))
    expect(first).toBe(duplicate)
    complete({ activate, discard })
    await first
    await manager.observe(host('released'))
    expect(resume).toHaveBeenCalledOnce()
    expect(activate).toHaveBeenCalledOnce()
    expect(discard).not.toHaveBeenCalled()
    expect(manager.isFenced()).toBe(false)
  })

  it('rejects a symlink in the private report namespace', async () => {
    const { manager, stateDir } = fixture()
    const other = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), 'canonical-maintenance-outside-')
    )
    roots.push(other)
    fs.symlinkSync(other, path.join(stateDir, '.canonical-store'))
    await expect(manager.observe(host('quiescing'))).rejects.toThrow('LayoutUnsafe')
    expect(fs.readdirSync(other)).toEqual([])
    expect(manager.isFenced()).toBe(true)
  })
})
