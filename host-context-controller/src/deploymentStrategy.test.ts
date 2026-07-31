import { describe, expect, it } from 'vitest'
import { loadAll } from 'js-yaml'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * HCC's safety model assumes a single writer: replicas:1 with NO leader
 * election (see statelessLifecycleExecutor.ts — "Running >1 replica risks two
 * controllers racing"). The default Deployment strategy is RollingUpdate with
 * maxSurge>0, which starts the new pod before the old one exits — a guaranteed
 * two-replica overlap on every rollout. During that window the outgoing replica
 * can win a conflict-retry replace (applyNetworkPolicy → replaceWithConflictRetry)
 * and land its wider spec back over a policy the new replica just hardened and
 * certified. There is no NetworkPolicy watch or periodic resync to heal it, and
 * the new replica's safety fence only sees failures in its own process — so
 * /ready stays 200 over a stale allow. Recreate closes the overlap, which is the
 * only way to honour the documented single-writer assumption during a rollout.
 */
describe('host-context-controller Deployment strategy', () => {
  const docs = loadAll(
    readFileSync(
      path.join(__dirname, '../../deploy/base/control-plane/host-context-controller.yaml'),
      'utf8'
    )
  ) as Array<{ kind?: string; metadata?: { name?: string }; spec?: Record<string, unknown> }>

  const deployment = docs.find(
    d => d?.kind === 'Deployment' && d?.metadata?.name === 'host-context-controller'
  )

  it('defines the host-context-controller Deployment', () => {
    expect(deployment).toBeDefined()
  })

  it('runs a single replica', () => {
    expect(deployment?.spec?.replicas).toBe(1)
  })

  it('uses Recreate so a rollout never overlaps two writers', () => {
    // RollingUpdate (the default) would start the new pod before terminating the
    // old one; with no leader election that races two NetworkPolicy writers.
    const strategy = deployment?.spec?.strategy as { type?: string } | undefined
    expect(strategy?.type).toBe('Recreate')
  })

  it('carries no rollingUpdate block under Recreate', () => {
    // A leftover spec.strategy.rollingUpdate is invalid under Recreate and, if a
    // future edit flipped only `type` back, would quietly reintroduce surge.
    const strategy = deployment?.spec?.strategy as { rollingUpdate?: unknown } | undefined
    expect(strategy?.rollingUpdate).toBeUndefined()
  })
})
