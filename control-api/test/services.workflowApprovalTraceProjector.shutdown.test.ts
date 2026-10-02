import { beforeEach, describe, expect, it, vi } from 'vitest'

const traceTransactions = vi.hoisted(() => ({ withTraceIngestTransaction: vi.fn() }))

vi.mock('../src/services/tracing/pools.js', () => ({
  withTraceIngestTransaction: traceTransactions.withTraceIngestTransaction,
}))

describe('workflow approval trace projector shutdown', () => {
  beforeEach(() => {
    vi.resetModules()
    traceTransactions.withTraceIngestTransaction.mockReset()
  })

  it('waits for the active producer-backed scan before allowing pool shutdown', async () => {
    let releaseScan!: () => void
    let markScanStarted!: () => void
    const scanStarted = new Promise<void>(resolve => (markScanStarted = resolve))
    const heldScan = new Promise<void>(resolve => (releaseScan = resolve))
    traceTransactions.withTraceIngestTransaction.mockImplementation(async work => {
      const db = {
        query: vi.fn(async () => {
          markScanStarted()
          await heldScan
          return { rows: [] }
        }),
      }
      return work(db as never)
    })

    const { startWorkflowApprovalTraceProjector, stopWorkflowApprovalTraceProjector } =
      await import('../src/services/tracing/workflowApprovalTraceProjector.js')
    startWorkflowApprovalTraceProjector()
    await scanStarted

    let stopFinished = false
    const stopping = Promise.resolve(stopWorkflowApprovalTraceProjector()).then(() => {
      stopFinished = true
    })
    await Promise.resolve()
    expect(stopFinished).toBe(false)

    releaseScan()
    await stopping
    expect(stopFinished).toBe(true)
    expect(traceTransactions.withTraceIngestTransaction).toHaveBeenCalledOnce()
  })
})
