import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  InconclusiveError,
  UnsafeOlderReaderBehaviorError,
  attachFinalCleanupObservations,
  classifyDiagnosticFailure,
  classifyUncaughtExperimentFailure,
  runDiagnosticPhase,
  runWhenOwnedProcessesStopped,
  waitFor,
  waitForOwnedChildClose,
} from '../../scripts/pr977-v011-older-reader-diagnostics.mjs'

describe('v0.11 older-reader phase diagnostics', () => {
  it('returns the successful predicate result for credential readback callers', async () => {
    const matchingCredentials = [{ selector: 'synthetic-selector', matchesSynthetic: true }]
    const predicate = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(matchingCredentials)

    vi.useFakeTimers()
    try {
      const result = waitFor(predicate, 'credential-readback-timeout', 1_000)
      await vi.advanceTimersByTimeAsync(200)

      const found = await result
      expect(found).toBe(matchingCredentials)
      expect(found.length).toBe(1)
      expect(predicate).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps timeout and predicate exceptions observable', async () => {
    vi.useFakeTimers()
    try {
      const timedOut = waitFor(async () => false, 'credential-readback-timeout', 100)
      const timeoutAssertion = expect(timedOut).rejects.toMatchObject({
        category: 'credential-readback-timeout',
      })
      await vi.advanceTimersByTimeAsync(200)
      await timeoutAssertion
    } finally {
      vi.useRealTimers()
    }

    const predicateFailure = new Error('synthetic predicate failure')
    await expect(
      waitFor(async () => Promise.reject(predicateFailure), 'unused-category')
    ).rejects.toBe(predicateFailure)
  })

  it('reports a fixed phase and sanitized category for a failed platform stage', async () => {
    const records: unknown[] = []
    let elapsed = 10
    const observations = {
      processSpawned: true,
      cdpAttached: false,
      profilePath: 'C:\\synthetic-private-path',
    }

    await expect(
      runDiagnosticPhase(
        'packaged-cdp-attachment',
        async () => {
          const error = new Error(
            'sensitive path and token must not appear'
          ) as NodeJS.ErrnoException
          error.code = 'ETIMEDOUT'
          throw error
        },
        {
          scenario: 'lp',
          observations: () => observations,
          report: record => records.push(record),
          now: () => elapsed++,
        }
      )
    ).rejects.toBeInstanceOf(Error)

    expect(records).toEqual([
      {
        kind: 'compatibility-phase',
        phase: 'packaged-cdp-attachment',
        status: 'STARTED',
        elapsedMs: 0,
        scenario: 'lp',
        observations: { processSpawned: true, cdpAttached: false },
      },
      {
        kind: 'compatibility-phase',
        phase: 'packaged-cdp-attachment',
        status: 'INCONCLUSIVE',
        elapsedMs: 1,
        scenario: 'lp',
        failureCategory: 'platform-timeout',
        observations: { processSpawned: true, cdpAttached: false },
      },
    ])
    expect(JSON.stringify(records)).not.toContain('sensitive')
    expect(JSON.stringify(records)).not.toContain('private-path')
  })

  it('keeps elapsed time finite when the timer source is invalid', async () => {
    const records: unknown[] = []

    await runDiagnosticPhase('runner-principal-profile', async () => undefined, {
      report: record => records.push(record),
      now: () => Number.NaN,
    })

    expect(records[0]).toMatchObject({ status: 'STARTED', elapsedMs: 0 })
    expect(records[1]).toMatchObject({ status: 'PASS', elapsedMs: 0 })
    expect(JSON.stringify(records)).not.toContain('null')
  })

  it('preserves the phase when an unexpected exception occurs and omits its message', async () => {
    const records: unknown[] = []
    const error = new Error('Bearer synthetic-secret at C:\\private\\profile')
    Object.defineProperty(error, 'phase', { value: 'lp-restore-observation' })

    await expect(
      runDiagnosticPhase(
        'lp-restore-observation',
        async () => {
          throw error
        },
        { scenario: 'lp', report: record => records.push(record) }
      )
    ).rejects.toBe(error)

    expect(classifyDiagnosticFailure(error)).toEqual({
      status: 'INCONCLUSIVE',
      category: 'unexpected-error',
    })
    expect(classifyUncaughtExperimentFailure(error, 'lp-restore-observation')).toEqual({
      kind: 'compatibility-experiment-result',
      status: 'INCONCLUSIVE',
      failedPhase: 'lp-restore-observation',
      failureCategory: 'unexpected-error',
    })
    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({
      phase: 'lp-restore-observation',
      scenario: 'lp',
      status: 'INCONCLUSIVE',
      failureCategory: 'unexpected-error',
    })
    expect(JSON.stringify(records)).not.toContain('Bearer')
    expect(JSON.stringify(records)).not.toContain('private')
  })

  it('distinguishes expected inconclusive gates from unsafe-reader failures', () => {
    expect(
      classifyDiagnosticFailure(new InconclusiveError('runner-profile-identity-unavailable'))
    ).toEqual({
      status: 'INCONCLUSIVE',
      category: 'runner-profile-identity-unavailable',
    })
    expect(classifyDiagnosticFailure(new InconclusiveError('unreviewed-message'))).toEqual({
      status: 'INCONCLUSIVE',
      category: 'unexpected-error',
    })
    expect(classifyDiagnosticFailure(new UnsafeOlderReaderBehaviorError())).toEqual({
      status: 'FAIL',
      category: 'unsafe-older-reader-behavior',
    })
  })

  it('accepts the LP-to-V2 credential checkpoint and emits only allowlisted observations', async () => {
    const records: unknown[] = []
    await runDiagnosticPhase(
      'lp-credential-state-before-v2',
      async () => 'synthetic credential state verified',
      {
        scenario: 'v2',
        observations: () => ({
          credentialReadSucceeded: true,
          syntheticCredentialPresent: true,
          credentialSelectorCount: 1,
          account: 'must-not-be-reported',
        }),
        report: record => records.push(record),
      }
    )

    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({
      phase: 'lp-credential-state-before-v2',
      status: 'PASS',
      scenario: 'v2',
      observations: {
        credentialReadSucceeded: true,
        syntheticCredentialPresent: true,
        credentialSelectorCount: 1,
      },
    })
    expect(JSON.stringify(records)).not.toContain('must-not-be-reported')
  })

  it('reports the post-cleanup state in the final experiment result', () => {
    const beforeCleanup = {
      kind: 'compatibility-experiment-result',
      status: 'PASS_FOR_TESTED_STATES_ONLY',
      cleanup: {
        processStopped: false,
        syntheticCredentialRemoved: false,
        remainingTargetSelectorCount: 0,
        restEndpointClosed: false,
        rpcEndpointClosed: false,
        taskDirectoryRemoved: false,
      },
    }

    const result = attachFinalCleanupObservations(beforeCleanup, {
      processStopped: true,
      syntheticCredentialRemoved: true,
      remainingTargetSelectorCount: 0,
      restEndpointClosed: true,
      rpcEndpointClosed: true,
      taskDirectoryRemoved: true,
      profilePath: 'C:\\private\\runner-profile',
    })

    expect(result?.cleanup).toEqual({
      processStopped: true,
      syntheticCredentialRemoved: true,
      remainingTargetSelectorCount: 0,
      restEndpointClosed: true,
      rpcEndpointClosed: true,
      taskDirectoryRemoved: true,
    })
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('preserves signal termination as a sanitized inconclusive result', () => {
    expect(
      classifyDiagnosticFailure(new InconclusiveError('child-process-terminated-by-signal'))
    ).toEqual({ status: 'INCONCLUSIVE', category: 'child-process-terminated-by-signal' })
    expect(
      classifyDiagnosticFailure(new InconclusiveError('child-process-exit-state-unknown'))
    ).toEqual({ status: 'INCONCLUSIVE', category: 'child-process-exit-state-unknown' })
  })

  it('waits for a timed-out owned writer to close after requesting termination', async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killCalls: 0,
      kill() {
        this.killCalls += 1
        setImmediate(() => {
          this.signalCode = 'SIGTERM'
          this.emit('close', null, 'SIGTERM')
        })
        return true
      },
    })
    let terminationRequested = false

    const exit = await waitForOwnedChildClose(child, {
      timeoutMs: 0,
      terminationGraceMs: 100,
      onTerminationRequested: () => {
        terminationRequested = true
      },
    })

    expect(terminationRequested).toBe(true)
    expect(child.killCalls).toBe(1)
    expect(exit).toEqual({ code: null, signal: 'SIGTERM', timedOut: true })
    expect(child.listenerCount('close')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
  })

  it('does not claim an owned writer stopped when termination cannot be confirmed', async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killCalls: 0,
      kill() {
        this.killCalls += 1
        return true
      },
    })

    await expect(
      waitForOwnedChildClose(child, { timeoutMs: 0, terminationGraceMs: 5 })
    ).rejects.toMatchObject({
      category: 'current-v2-repository-writer-did-not-exit',
    })
    expect(child.killCalls).toBe(1)
    expect(child.listenerCount('close')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
  })

  it('does not run credential or profile cleanup until every owned process has stopped', async () => {
    const cleanupOperations: string[] = []
    const cleanCredential = () => cleanupOperations.push('credential')
    const removeTaskProfile = () => cleanupOperations.push('profile')

    for (const state of [
      { processStopped: true, writerStopped: false },
      { processStopped: false, writerStopped: true },
    ]) {
      await expect(runWhenOwnedProcessesStopped(state, cleanCredential)).resolves.toBe(false)
      await expect(runWhenOwnedProcessesStopped(state, removeTaskProfile)).resolves.toBe(false)
      expect(cleanupOperations).toEqual([])
    }

    const state = { processStopped: true, writerStopped: true }
    await expect(runWhenOwnedProcessesStopped(state, cleanCredential)).resolves.toBe(true)
    await expect(runWhenOwnedProcessesStopped(state, removeTaskProfile)).resolves.toBe(true)
    expect(cleanupOperations).toEqual(['credential', 'profile'])
  })
})
