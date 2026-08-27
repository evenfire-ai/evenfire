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
  const yamlPath = path.join(
    __dirname,
    '../../deploy/base/control-plane/host-context-controller.yaml'
  )
  const yamlSource = readFileSync(yamlPath, 'utf8')
  const docs = loadAll(yamlSource) as Array<{
    kind?: string
    metadata?: { name?: string }
    spec?: Record<string, unknown>
  }>

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

  it('bounds rollout-stall detection above the worst legitimate startup', () => {
    // Detection only, not recovery: Recreate + replicas:1 means a botched
    // rollout is healed by the evenfire-infra deploy pipeline
    // (rollout undo --to-revision; evenfire#391), never by Kubernetes itself.
    // The deadline stays 1200; this test must not lower it.
    // This deadline just flips Progressing=False / fails `kubectl rollout
    // status` deterministically for observers without their own --timeout. It
    // must exceed the worst legitimate startup, which — until #205 fully
    // decouples readiness from fleet convergence — scales with the McpServer/
    // Context fleet: origin/dev observed 651s on clerum-dev (108 McpServers /
    // 22 Contexts) on 2026-08-05, so 1200s (900s wait + 300s head-start) is the
    // merged mitigation. Comes back down once readiness no longer waits on the
    // fleet.
    expect(deployment?.spec?.progressDeadlineSeconds).toBe(1200)
  })

  /**
   * evenfire#391 detection-vs-recovery split. The D1b premise is a SET, not
   * three independent knobs: Recreate (terminate-before-create, zero fallback
   * replicas) + replicas:1 (single writer) + progressDeadlineSeconds:1200
   * (detection). Change any one of them and the #391 recovery contract — the
   * evenfire-infra deploy pipeline performing `rollout undo --to-revision`,
   * never Kubernetes and never HCC code — is reasoning about a deployment
   * that no longer exists. These pins fail if the set is broken up or if the
   * documented ownership/detection-only contract is silently deleted.
   */
  describe('evenfire#391 detection-vs-recovery split', () => {
    it('keeps the D1b premise set together: Recreate + replicas:1 + deadline 1200', () => {
      // Asserted as one test on purpose: a partial edit (e.g. bumping replicas
      // while keeping Recreate, or flipping the strategy while keeping the
      // 1200s deadline) must fail HERE as a broken premise set, not pass three
      // unrelated single-field tests.
      const strategy = deployment?.spec?.strategy as
        | { type?: string; rollingUpdate?: unknown }
        | undefined
      expect({
        replicas: deployment?.spec?.replicas,
        strategyType: strategy?.type,
        rollingUpdate: strategy?.rollingUpdate,
        progressDeadlineSeconds: deployment?.spec?.progressDeadlineSeconds,
      }).toEqual({
        replicas: 1,
        strategyType: 'Recreate',
        rollingUpdate: undefined,
        progressDeadlineSeconds: 1200,
      })
    })

    it('keeps the external recovery ownership contract documented', () => {
      // The deadline only detects a stalled rollout. Recovery belongs to the
      // evenfire-infra deploy workflow; this stable marker avoids coupling the
      // test to explanatory prose in the manifest comment.
      expect(yamlSource).toContain(
        '# CONTRACT: hcc-rollout-recovery=external-detection-only; owner=evenfire-infra'
      )
    })
  })
})
