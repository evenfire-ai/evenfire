/**
 * issue #510 — the control-api half of the `provider` port ceiling.
 *
 * `egressClass: provider` was accepted on surfaces where `egressClass:
 * public-web` is refused, and reached arbitrary ports where `public-web` is
 * capped. The reproduction in the issue rendered `140.82.112.0/20` on **TCP/22**
 * for a non-transport workload and reached `phase: active`.
 *
 * The ceiling is enforced in three layers (CRD CEL, control-api, WRC reconciler)
 * from one shared constant. These tests cover the control-api layer. The CEL
 * literal is pinned to the same constant by a parity test in
 * `packages/network-policy-core/index.test.cjs`; the reconciler layer is covered
 * in `workflow-recipes/src/reconciler/reconciler.test.ts`.
 *
 * Two surfaces matter, and the second is the one the issue actually reported:
 *  - workload `egressBindings`, which carry `egressClass: 'provider'`;
 *  - `spec.ui.egress.external`, which has NO `egressClass` field at all yet
 *    accepts a `provider` object. Keying the check only on `egressClass` would
 *    leave that surface ungated — the exact hole being closed.
 */
import { describe, expect, it } from 'vitest'
import { validateWorkflowRecipeLimits } from '../src/services/workflowRecipeLimits.js'

const CEILING_MESSAGE_FRAGMENT = 'is limited to port 80 or 443'

const providerBinding = (port: number) => ({
  egressClass: 'provider',
  dns: 'api.github.com',
  port,
  provider: { name: 'github', categories: ['api'] },
})

const recipeWithWorkload = (workload: Record<string, unknown>) => ({
  contextRef: 'default',
  workloads: [{ id: 'worker', type: 'deployment', image: 'worker:latest', ...workload }],
})

const ceilingErrors = (spec: unknown) =>
  validateWorkflowRecipeLimits(spec).filter(error =>
    error.message.includes(CEILING_MESSAGE_FRAGMENT)
  )

describe('issue #510 — provider port ceiling on non-transport surfaces', () => {
  it('rejects a provider binding on a non-web port for a non-transport workload', () => {
    const errors = ceilingErrors(
      recipeWithWorkload({ port: 8080, egressBindings: [providerBinding(22)] })
    )

    expect(errors).toHaveLength(1)
    expect(errors[0].field).toBe('spec.workloads[0].egressBindings[0].port')
  })

  it('accepts a provider binding on 443 for a non-transport workload', () => {
    expect(
      ceilingErrors(recipeWithWorkload({ port: 8080, egressBindings: [providerBinding(443)] }))
    ).toHaveLength(0)
  })

  it('accepts a provider binding on 80 for a non-transport workload', () => {
    expect(
      ceilingErrors(recipeWithWorkload({ port: 8080, egressBindings: [providerBinding(80)] }))
    ).toHaveLength(0)
  })

  it('does not cap a transport workload — that class may reach any port', () => {
    expect(
      ceilingErrors(
        recipeWithWorkload({
          port: 3000,
          transport: { type: 'streamableHttp' },
          egressBindings: [providerBinding(22)],
        })
      )
    ).toHaveLength(0)
  })

  it('leaves exact-host bindings alone on any port', () => {
    expect(
      ceilingErrors(
        recipeWithWorkload({
          port: 8080,
          egressBindings: [{ dns: 'api.github.com', port: 22 }],
        })
      )
    ).toHaveLength(0)
  })

  it('rejects a ui.egress.external provider entry on a non-web port, despite it having no egressClass field', () => {
    const errors = ceilingErrors({
      contextRef: 'default',
      ui: {
        workloadRef: 'worker',
        egress: {
          external: [
            { fqdn: 'api.github.com', port: 22, provider: { name: 'github', categories: ['api'] } },
          ],
        },
      },
    })

    expect(errors).toHaveLength(1)
    expect(errors[0].field).toBe('spec.ui.egress.external[0].port')
  })

  it('accepts a ui.egress.external provider entry on 443', () => {
    expect(
      ceilingErrors({
        contextRef: 'default',
        ui: {
          workloadRef: 'worker',
          egress: {
            external: [
              {
                fqdn: 'api.github.com',
                port: 443,
                provider: { name: 'github', categories: ['api'] },
              },
            ],
          },
        },
      })
    ).toHaveLength(0)
  })

  it('leaves a ui.egress.external entry with no provider object alone', () => {
    expect(
      ceilingErrors({
        contextRef: 'default',
        ui: {
          workloadRef: 'worker',
          egress: { external: [{ fqdn: 'api.github.com', port: 22 }] },
        },
      })
    ).toHaveLength(0)
  })
})
