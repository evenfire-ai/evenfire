/**
 * Stage 4 Smoke Tests (Layer 3) — Minikube clerum-test cluster required.
 *
 * These tests validate the Stage 4 Scheduling & Triggers CRD schema
 * extensions and CEL validation rules in a real Kubernetes cluster.
 *
 * Prerequisites:
 *   - minikube profile 'clerum-test' running with Calico CNI
 *   - CRDs installed (with spec.scheduling field)
 *   - Namespaces created (sandbox-recipes)
 *
 * Run: TEST_SMOKE=true npx vitest run tests/smoke/workflow/stage4.smoke.test.ts
 *
 * Source of truth: STAGE-4-SCHEDULING-TRIGGERS.md §4.1
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execSync } from 'child_process'

const PROFILE = 'clerum-test'
const KC = `kubectl --context=${PROFILE}`
const NAMESPACE = 'sandbox-recipes'

const SCHEDULED_FIXTURE = 'tests/fixtures/workflow/smoke-scheduled-recipe.yaml'
const INVALID_NO_STEPS = 'tests/fixtures/workflow/invalid-scheduling-no-steps.yaml'
const INVALID_BAD_CRON = 'tests/fixtures/workflow/invalid-scheduling-bad-cron.yaml'
const RECIPE_NAME = 'smoke-sched-test'

const runSmoke = process.env.TEST_SMOKE === 'true'

function kubectl(cmd: string, timeout = 30000): string {
  return execSync(`${KC} ${cmd}`, { timeout, encoding: 'utf-8' }).trim()
}

function kubectlSafe(cmd: string, timeout = 30000): string | null {
  try {
    return kubectl(cmd, timeout)
  } catch {
    return null
  }
}

function kubectlFails(cmd: string, timeout = 30000): string {
  try {
    execSync(`${KC} ${cmd}`, { timeout, encoding: 'utf-8' })
    return ''
  } catch (err: unknown) {
    return (err as { stderr?: string }).stderr ?? String(err)
  }
}

describe.skipIf(!runSmoke)('Stage 4 Smoke Tests — Scheduling CRD & CEL', () => {
  afterAll(() => {
    kubectlSafe(`delete workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} --ignore-not-found`, 15000)
    kubectlSafe(
      `delete workflowrecipe invalid-sched-no-steps -n ${NAMESPACE} --ignore-not-found`,
      15000
    )
    kubectlSafe(
      `delete workflowrecipe invalid-sched-bad-cron -n ${NAMESPACE} --ignore-not-found`,
      15000
    )
  }, 30000)

  // S4.1: CRD accepts valid scheduling spec
  it('S4.1 — Apply scheduled recipe (valid cron + steps)', () => {
    const result = kubectl(`apply -f ${SCHEDULED_FIXTURE}`)
    expect(result).toMatch(/created|configured/)

    // Verify scheduling fields persisted
    const cron = kubectl(
      `get workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} -o jsonpath='{.spec.scheduling.cron}'`
    )
    expect(cron).toContain('0 9 * * *')

    const tz = kubectl(
      `get workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} -o jsonpath='{.spec.scheduling.timezone}'`
    )
    expect(tz).toContain('UTC')

    const policy = kubectl(
      `get workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} -o jsonpath='{.spec.scheduling.concurrencyPolicy}'`
    )
    expect(policy).toContain('Forbid')
  })

  // S4.2: CRD defaults are applied
  it('S4.2 — Verify scheduling defaults (successfulHistoryLimit, failedHistoryLimit, suspend)', () => {
    const successLimit = kubectl(
      `get workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} -o jsonpath='{.spec.scheduling.successfulHistoryLimit}'`
    )
    expect(successLimit).toContain('3')

    const failLimit = kubectl(
      `get workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} -o jsonpath='{.spec.scheduling.failedHistoryLimit}'`
    )
    expect(failLimit).toContain('1')

    const suspend = kubectl(
      `get workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} -o jsonpath='{.spec.scheduling.suspend}'`
    )
    expect(suspend).toContain('false')
  })

  // S4.3: CEL rejects scheduling without steps (R5)
  it('S4.3 — CEL rejects scheduling without steps (R5)', () => {
    const err = kubectlFails(`apply -f ${INVALID_NO_STEPS}`)
    expect(err).toContain('scheduling requires spec.steps')
  })

  // S4.4: CEL rejects invalid cron expression (R6)
  it('S4.4 — CEL rejects invalid cron expression (R6)', () => {
    const err = kubectlFails(`apply -f ${INVALID_BAD_CRON}`)
    expect(err).toContain('valid five-field cron')
  })

  // S4.5: Labels present for kubectl visibility
  it('S4.5 — Scheduled recipe has expected spec structure', () => {
    const json = kubectl(
      `get workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} -o jsonpath='{.spec.scheduling}'`
    )
    // Should contain all scheduling fields
    expect(json).toContain('cron')
    expect(json).toContain('concurrencyPolicy')
  })

  // S4.6: Cleanup — delete scheduled recipe
  it('S4.6 — Delete scheduled recipe succeeds', () => {
    const result = kubectl(`delete workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE}`)
    expect(result).toContain('deleted')

    // Verify it's gone
    const get = kubectlSafe(`get workflowrecipe ${RECIPE_NAME} -n ${NAMESPACE} 2>&1`)
    expect(get).toBeNull()
  })
})
