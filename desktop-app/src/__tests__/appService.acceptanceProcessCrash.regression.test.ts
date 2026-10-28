import { afterEach, describe, expect, it } from 'vitest'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type WorkerReport = {
  ok: boolean
  crashReached?: string
  authenticated?: boolean
  sessionMode?: string
  owner?: string | null
  bearerPersisted?: boolean
  getMeOwners?: string[]
  authority?: {
    frameMode: string
    frameRevision: string
    source: {
      format: string
      kind: string
      accountId: string
      sourceRef: string
      sourceRevision: string
      storedValueDigest: string
      sourceBytesPresent: boolean
      sourceBytesMatchReceipt: boolean
      sourceBytesDigest: string | null
    } | null
    cleanupDebts: Array<{
      id: string
      accountId: string
      sourceRef: string
      sourceRevision: string
      storedValueDigest: string
      sourceBytesPresent: boolean
      sourceBytesMatchReceipt: boolean
      supersedingFrameRevision: string
    }>
    projectionIntent: { operationId: string } | null
    projectionReceipt: {
      operationId: string
      markerRevision: string
      markerContents: string
      journalDigest: string
    } | null
    marker: {
      kind: string
      revision: string | null
      intent: string | null
      digest: string
      contents: string | null
    }
    journal: { status: string; digest?: string; denialCount?: number }
    candidates: Array<{
      accountId: string
      phase: string
      transactionId: string
      sourceRef: string
    }>
    legacyDenialHashes?: string[]
  }
  candidateSource?: { accountId: string; sourceRef: string; sourceRevision: string }
  candidateSourceRef?: string | null
  candidateSourcePresent?: boolean
  errorCategory?: string
  activeEnvKey?: string
  priorEnvKey?: string
  targetEnvKey?: string
  profileSelection?: {
    status: string
    state?: string | null
    mode?: string | null
    envKey?: string | null
    userId?: string | null
    teamId?: string | null
    sessionGeneration?: number | null
    transactionId?: string | null
    sourceRef?: string | null
  }
  priorEnvironmentRestoreStatus?: { status: string; frameMode: string | null } | null
  denialHash?: string
  corruptedJournal?: boolean
  corruptedJournalDigest?: string
  corruptedJournalBytes?: number
  coldWasSignedOut?: boolean
  startupGetMeOwners?: string[]
  protectedHttpDispatches?: number
  protectedRpcDispatches?: number
  deniedCandidateRejected?: boolean
  quarantineFiles?: Array<{ digest: string; byteLength: number }>
}

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workerPath = path.join(desktopRoot, 'testSupport/sessionAuthorityCrashWorker.cjs')
const profileRoots = new Set<string>()
const activeChildren = new Map<ChildProcess, string>()

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    let deadline: ReturnType<typeof setTimeout>
    const onClose = () => {
      clearTimeout(deadline)
      resolve(true)
    }
    deadline = setTimeout(() => {
      child.off('close', onClose)
      resolve(false)
    }, timeoutMs)
    child.once('close', onClose)
  })
}

async function runWorker(
  role:
    | 'seed'
    | 'candidate'
    | 'recover'
    | 'memory-seed'
    | 'memory-recover'
    | 'journal-seed'
    | 'journal-recover',
  profileRoot: string,
  phase?: string,
  scenario: 'same-environment' | 'environment-switch' = 'same-environment'
): Promise<{ code: number | null; report: WorkerReport }> {
  const reportPath = path.join(profileRoot, `${role}-${phase ?? 'none'}.json`)
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: profileRoot,
    TMPDIR: profileRoot,
    TMP: profileRoot,
    TEMP: profileRoot,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
  }

  const child = spawn(
    process.execPath,
    [workerPath, role, profileRoot, phase ?? 'none', scenario],
    {
      cwd: desktopRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  activeChildren.set(child, profileRoot)
  child.once('close', () => activeChildren.delete(child))
  let outputBytes = 0
  child.stdout.on('data', chunk => {
    outputBytes += chunk.length
  })
  child.stderr.on('data', chunk => {
    outputBytes += chunk.length
  })

  const code = await new Promise<number | null>((resolve, reject) => {
    let timedOut = false
    let reapDeadline: ReturnType<typeof setTimeout> | undefined
    const deadline = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      reapDeadline = setTimeout(() => {
        reject(new Error(`session acceptance child did not close after termination (${role})`))
      }, 5_000)
    }, 30_000)
    child.once('error', error => {
      clearTimeout(deadline)
      reject(new Error(`session acceptance child could not start (${error.name})`))
    })
    child.once('close', exitCode => {
      clearTimeout(deadline)
      if (reapDeadline) clearTimeout(reapDeadline)
      if (timedOut)
        reject(new Error(`session acceptance child exceeded its bounded deadline (${role})`))
      else resolve(exitCode)
    })
  })

  let report: WorkerReport
  try {
    report = JSON.parse(await fs.readFile(reportPath, 'utf8')) as WorkerReport
  } catch {
    throw new Error(
      `session acceptance child did not write its sanitized report (${role}); output bytes=${outputBytes}`
    )
  }
  return { code, report }
}

async function runKilledJournalRecoveryWorker(
  profileRoot: string
): Promise<{ signal: NodeJS.Signals | null; report: WorkerReport }> {
  const reportPath = path.join(profileRoot, 'journal-recovery-crash-after-lp.json')
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: profileRoot,
    TMPDIR: profileRoot,
    TMP: profileRoot,
    TEMP: profileRoot,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
  }
  const child = spawn(
    process.execPath,
    [workerPath, 'journal-recovery-crash', profileRoot, 'after-lp'],
    { cwd: desktopRoot, env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  activeChildren.set(child, profileRoot)
  child.once('close', () => activeChildren.delete(child))
  let outputBytes = 0
  child.stdout.on('data', chunk => {
    outputBytes += chunk.length
  })
  child.stderr.on('data', chunk => {
    outputBytes += chunk.length
  })

  const deadline = Date.now() + 30_000
  let report: WorkerReport | undefined
  while (Date.now() < deadline) {
    try {
      report = JSON.parse(await fs.readFile(reportPath, 'utf8')) as WorkerReport
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (child.exitCode !== null || child.signalCode !== null) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }

  if (!report || report.crashReached !== 'after-lp-sidecar-cas') {
    child.kill('SIGKILL')
    await waitForChildClose(child, 5_000)
    throw new Error(
      `journal recovery crash child missed the LP boundary; output bytes=${outputBytes}`
    )
  }
  child.kill('SIGKILL')
  if (!(await waitForChildClose(child, 5_000)))
    throw new Error('journal recovery crash child did not close after SIGKILL')
  return { signal: child.signalCode, report }
}

describe('public password login acceptance across process crashes', () => {
  afterEach(async () => {
    const rootsWithUnclosedChildren = new Set<string>()
    for (const [child, root] of [...activeChildren]) {
      if (!profileRoots.has(root)) continue
      child.kill('SIGKILL')
      if (!(await waitForChildClose(child, 5_000))) rootsWithUnclosedChildren.add(root)
    }
    for (const root of profileRoots) {
      if (!rootsWithUnclosedChildren.has(root)) await fs.rm(root, { recursive: true, force: true })
    }
    profileRoots.clear()
    for (const root of rootsWithUnclosedChildren) profileRoots.add(root)
    if (rootsWithUnclosedChildren.size > 0)
      throw new Error('A crash-test child remained alive; its isolated profile was retained')
  })

  it.each([
    { phase: 'after-intent', code: 86, acceptedOwner: 'A' },
    { phase: 'after-marker', code: 87, acceptedOwner: 'A' },
    { phase: 'after-profile-selection', code: 89, acceptedOwner: 'B' },
    { phase: 'after-acceptance', code: 88, acceptedOwner: 'B' },
  ])(
    'recovers the exact accepted owner after process termination at $phase',
    async ({ phase, code, acceptedOwner }) => {
      const profileRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), `evenfire-session-acceptance-crash-${randomUUID()}-`)
      )
      profileRoots.add(profileRoot)
      await fs.chmod(profileRoot, 0o700)

      const seeded = await runWorker('seed', profileRoot)
      expect(seeded.code).toBe(0)
      expect(seeded.report).toMatchObject({
        ok: true,
        authenticated: true,
        owner: 'crash-owner-A',
        authority: {
          frameMode: 'persistent',
          source: {
            format: 'v1',
            accountId: 'crash-owner-A',
            sourceBytesPresent: true,
            sourceBytesMatchReceipt: true,
          },
          projectionIntent: null,
          journal: { status: 'observed' },
        },
      })
      const priorAuthority = seeded.report.authority
      expect(priorAuthority?.source?.sourceRef).toBeTruthy()
      expect(priorAuthority?.source?.sourceRevision).toBeTruthy()
      expect(priorAuthority?.source?.storedValueDigest).toBeTruthy()

      const crashed = await runWorker('candidate', profileRoot, phase)
      expect(crashed.code).toBe(code)
      expect(crashed.report).toMatchObject({
        ok: true,
        crashReached: phase,
        candidateSource: {
          accountId: 'crash-owner-B',
          sourceRef: expect.any(String),
          sourceRevision: expect.any(String),
        },
      })

      const recovered = await runWorker('recover', profileRoot, phase)
      expect(recovered.code).toBe(0)
      expect(recovered.report.ok).toBe(true)
      expect(recovered.report.authenticated, JSON.stringify(recovered.report)).toBe(true)
      expect(recovered.report.owner).toBe(`crash-owner-${acceptedOwner}`)
      expect(recovered.report.getMeOwners).toEqual([acceptedOwner])

      const authority = recovered.report.authority
      expect(authority?.frameMode).toBe('persistent')
      expect(authority?.source).toMatchObject({
        format: 'v1',
        accountId: `crash-owner-${acceptedOwner}`,
        sourceBytesPresent: true,
        sourceBytesMatchReceipt: true,
      })
      expect(authority?.projectionIntent).toBeNull()
      expect(authority?.journal).toMatchObject({
        status: 'observed',
        digest: priorAuthority?.journal.digest,
      })
      expect(authority?.projectionReceipt?.markerRevision).toBe(authority?.marker.revision)
      expect(authority?.projectionReceipt?.markerContents).toBe(authority?.marker.contents)
      expect(authority?.projectionReceipt?.journalDigest).toBe(authority?.journal.digest)

      if (acceptedOwner === 'A') {
        expect(authority?.source).toEqual(priorAuthority?.source)
        expect(authority?.marker).toEqual(priorAuthority?.marker)
        expect(authority?.cleanupDebts).toEqual([])
        expect(authority?.candidates).not.toContainEqual(
          expect.objectContaining({ accountId: 'crash-owner-B' })
        )
        expect(recovered.report.candidateSourceRef).toBe(crashed.report.candidateSource?.sourceRef)
        expect(recovered.report.candidateSourcePresent).toBe(false)
      } else {
        expect(authority?.source?.accountId).toBe('crash-owner-B')
        expect(authority?.source?.sourceRef).not.toBe(priorAuthority?.source?.sourceRef)
        expect(recovered.report.candidateSourceRef).toBe(authority?.source?.sourceRef)
        expect(recovered.report.candidateSourcePresent).toBe(true)
        expect(authority?.cleanupDebts).toHaveLength(1)
        expect(authority?.cleanupDebts[0]).toMatchObject({
          accountId: 'crash-owner-A',
          sourceRef: priorAuthority?.source?.sourceRef,
          sourceRevision: priorAuthority?.source?.sourceRevision,
          storedValueDigest: priorAuthority?.source?.storedValueDigest,
          sourceBytesPresent: true,
          sourceBytesMatchReceipt: true,
          supersedingFrameRevision: authority?.frameRevision,
        })
      }
    },
    120_000
  )

  it.each([
    { phase: 'after-intent', code: 86, acceptedOwner: 'signed-out' },
    { phase: 'after-marker', code: 87, acceptedOwner: 'signed-out' },
    { phase: 'after-profile-selection', code: 89, acceptedOwner: 'B' },
    { phase: 'after-acceptance', code: 88, acceptedOwner: 'B' },
  ])(
    'restores only the logout-first environment after a cross-environment crash at $phase',
    async ({ phase, code, acceptedOwner }) => {
      const profileRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), `evenfire-session-profile-crash-${randomUUID()}-`)
      )
      profileRoots.add(profileRoot)
      await fs.chmod(profileRoot, 0o700)

      const seeded = await runWorker('seed', profileRoot, undefined, 'environment-switch')
      expect(seeded.code).toBe(0)
      expect(seeded.report).toMatchObject({
        ok: true,
        authenticated: true,
        owner: 'crash-owner-A',
        profileSelection: {
          status: 'observed',
          state: 'active',
          mode: 'persistent',
          envKey: seeded.report.activeEnvKey,
          userId: 'crash-owner-A',
        },
      })
      const priorEnvKey = seeded.report.activeEnvKey
      expect(priorEnvKey).toBeTruthy()

      const crashed = await runWorker('candidate', profileRoot, phase, 'environment-switch')
      expect(crashed.code).toBe(code)
      expect(crashed.report).toMatchObject({
        ok: true,
        crashReached: phase,
        priorEnvKey,
        targetEnvKey: expect.any(String),
        candidateSource: {
          accountId: 'crash-owner-B',
          sourceRef: expect.any(String),
          sourceRevision: expect.any(String),
        },
      })
      expect(crashed.report.targetEnvKey).not.toBe(priorEnvKey)

      const recovered = await runWorker('recover', profileRoot, phase, 'environment-switch')
      expect(recovered.code).toBe(0)
      expect(recovered.report.ok).toBe(true)
      if (acceptedOwner === 'signed-out') {
        expect(recovered.report.authenticated).toBe(false)
        expect(recovered.report.owner).toBeNull()
        expect(recovered.report.getMeOwners).toEqual([])
        expect(recovered.report.profileSelection).toMatchObject({
          status: 'observed',
          state: 'signed-out',
        })
        expect(recovered.report.authority?.source).toBeNull()
        expect(recovered.report.priorEnvironmentRestoreStatus).toEqual({
          status: 'denied',
          frameMode: 'logged-out',
        })
      } else {
        expect(recovered.report.authenticated, JSON.stringify(recovered.report)).toBe(true)
        expect(recovered.report.owner).toBe('crash-owner-B')
        expect(recovered.report.getMeOwners).toEqual(['B'])
        expect(recovered.report.activeEnvKey).toBe(crashed.report.targetEnvKey)
        expect(recovered.report.profileSelection).toMatchObject({
          status: 'observed',
          state: 'active',
          mode: 'persistent',
          envKey: crashed.report.targetEnvKey,
          userId: 'crash-owner-B',
        })
        expect(recovered.report.authority?.source).toMatchObject({
          format: 'v1',
          accountId: 'crash-owner-B',
          sourceBytesPresent: true,
          sourceBytesMatchReceipt: true,
        })
        expect(recovered.report.profileSelection?.sourceRef).toBe(
          recovered.report.authority?.source?.sourceRef
        )
        expect(recovered.report.priorEnvironmentRestoreStatus).toEqual({
          status: 'denied',
          frameMode: 'logged-out',
        })
      }
    },
    120_000
  )

  it('stays signed out after process death between logout-marker CAS and journal recovery commit', async () => {
    const profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), `evenfire-session-journal-recovery-crash-${randomUUID()}-`)
    )
    profileRoots.add(profileRoot)
    await fs.chmod(profileRoot, 0o700)

    const seeded = await runWorker('journal-seed', profileRoot)
    expect(seeded.code).toBe(0)
    expect(seeded.report).toMatchObject({
      ok: true,
      corruptedJournal: true,
      denialHash: expect.any(String),
      corruptedJournalDigest: expect.any(String),
      corruptedJournalBytes: expect.any(Number),
    })

    const crashed = await runKilledJournalRecoveryWorker(profileRoot)
    expect(crashed.signal).toBe('SIGKILL')
    expect(crashed.report).toMatchObject({
      ok: true,
      crashReached: 'after-lp-sidecar-cas',
      frameMode: 'uninitialized',
      markerIntent: 'logout-pending',
      markerRevisionPresent: true,
    })

    const recovered = await runWorker('journal-recover', profileRoot)
    expect(recovered.code).toBe(0)
    expect(recovered.report).toMatchObject({
      ok: true,
      coldWasSignedOut: true,
      startupGetMeOwners: [],
      protectedHttpDispatches: 0,
      protectedRpcDispatches: 0,
      deniedCandidateRejected: true,
      authenticated: true,
      owner: 'crash-owner-B',
      getMeOwners: ['B'],
      authority: {
        frameMode: 'persistent',
        source: {
          accountId: 'crash-owner-B',
          sourceBytesPresent: true,
          sourceBytesMatchReceipt: true,
        },
        legacyDenialHashes: [seeded.report.denialHash],
      },
      quarantineFiles: [
        {
          digest: seeded.report.corruptedJournalDigest,
          byteLength: seeded.report.corruptedJournalBytes,
        },
      ],
    })
    expect(recovered.report.getMeOwners).not.toContain('A')
  }, 120_000)

  it('keeps memory-only login signed out after restart with prior persistent-source residue', async () => {
    const profileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), `evenfire-session-memory-restart-${randomUUID()}-`)
    )
    profileRoots.add(profileRoot)
    await fs.chmod(profileRoot, 0o700)

    const prior = await runWorker('seed', profileRoot)
    expect(prior.code).toBe(0)
    expect(prior.report.authority?.source).toMatchObject({
      format: 'v1',
      accountId: 'crash-owner-A',
      sourceBytesPresent: true,
      sourceBytesMatchReceipt: true,
    })

    const accepted = await runWorker('memory-seed', profileRoot)
    expect(accepted.code).toBe(0)
    expect(accepted.report).toMatchObject({
      ok: true,
      authenticated: true,
      sessionMode: 'temporary',
      owner: 'crash-owner-M',
      bearerPersisted: false,
      authority: {
        frameMode: 'memory-only',
        source: null,
        marker: { intent: 'acceptance-pending' },
        cleanupDebts: [
          {
            accountId: 'crash-owner-A',
            sourceBytesPresent: true,
            sourceBytesMatchReceipt: true,
          },
        ],
      },
    })
    expect(accepted.report.authority?.cleanupDebts[0]).toMatchObject({
      sourceRef: prior.report.authority?.source?.sourceRef,
      sourceRevision: prior.report.authority?.source?.sourceRevision,
      storedValueDigest: prior.report.authority?.source?.storedValueDigest,
    })
    expect(accepted.report.authority?.cleanupDebts[0].supersedingFrameRevision).toBe(
      accepted.report.authority?.frameRevision
    )

    const restarted = await runWorker('memory-recover', profileRoot)
    expect(restarted.code).toBe(0)
    expect(restarted.report).toMatchObject({
      ok: true,
      authenticated: false,
      owner: null,
      getMeOwners: [],
      bearerPersisted: false,
      authority: {
        frameMode: 'memory-only',
        source: null,
        marker: { intent: 'acceptance-pending' },
        cleanupDebts: accepted.report.authority?.cleanupDebts,
      },
    })
    expect(restarted.report.authority?.cleanupDebts[0]).toEqual(
      accepted.report.authority?.cleanupDebts[0]
    )
  }, 120_000)
})
