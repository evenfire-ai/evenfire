import { describe, expect, it } from 'vitest'
import {
  noteDnsBlock,
  noteEnforcedOwnership,
  noteRepairPending,
  runInReconcileContext,
} from './reconcileContext'

describe('reconcile context (#1016)', () => {
  it('collects notes made inside the async chain', async () => {
    const { ctx } = await runInReconcileContext(async () => {
      await Promise.resolve()
      noteDnsBlock('recipe_egress')
      noteEnforcedOwnership('api:s')
      noteRepairPending()
    })
    expect([...ctx.dnsBlocks]).toEqual(['recipe_egress'])
    expect(ctx.enforcedOwnership).toBe('api:s')
    expect(ctx.repairPending).toBe(true)
  })

  it('is a no-op outside a context', () => {
    expect(() => {
      noteDnsBlock('recipe_egress')
      noteRepairPending()
    }).not.toThrow()
  })

  it('does not leak between concurrent reconciles', async () => {
    const gate = (ms: number) => new Promise(r => setTimeout(r, ms))
    const [a, b] = await Promise.all([
      runInReconcileContext(async () => {
        await gate(5)
        noteDnsBlock('recipe_egress')
      }),
      runInReconcileContext(async () => {
        await gate(1)
        noteDnsBlock('runtime_http_egress')
      }),
    ])
    expect([...a.ctx.dnsBlocks]).toEqual(['recipe_egress'])
    expect([...b.ctx.dnsBlocks]).toEqual(['runtime_http_egress'])
  })
})
