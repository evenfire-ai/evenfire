/**
 * U5 — durable round-trip of a `connect_required` suspension.
 *
 * A reactive OAuth-consent suspension must survive a cold restart WITHOUT
 * degrading into a generic approval. This drives the REAL producer end to end:
 * a PendingApproval (built by the real U5 builder) → store.persistSuspend →
 * the real insert statement → the real select → reconstructPendingApproval,
 * asserting reason/mcpServerName are preserved.
 *
 * T1: the persisted row is NOT hand-written — it is whatever persistSuspend
 * actually maps from the PendingApproval. A typo in that mapping (e.g. writing a
 * non-existent column, so mcp_server_name lands NULL) now turns this test red,
 * where a hand-built PendingApprovalRow would have masked it (R3-M2).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { prepareStatements } from '../../../../db/statements'
import type { PendingApprovalRow } from '../../../../db/worker/protocol'
import { buildConnectRequiredApproval } from '../../../extensions/mcpApprovalGateController'
import type { PendingApproval } from '../../../types'
import { ConversationManager } from '../../conversation'
import { reconstructPendingApproval } from '../reconstruct'
import { type StoreHandle, makeSqliteStore } from './testHelpers'

const SESSION_KEY = 'user-u5:rpc:agent:default'

let handle: StoreHandle | undefined
afterEach(async () => {
  await handle?.shutdown()
  handle = undefined
})

/** Persist a suspension through the REAL producer and read the reconstructed
 *  PendingApproval back through the REAL select + reconstruct. */
async function roundTrip(approval: PendingApproval): Promise<PendingApproval> {
  handle = makeSqliteStore()
  const manager = new ConversationManager(handle.store)
  const conv = await manager.getOrCreate(SESSION_KEY)
  // startTurn registers the session (sessionKeyById) and the active task that
  // persistSuspend requires.
  await manager.startTurn(conv, 'do the thing', 'task-1')

  await handle.store.persistSuspend(conv, approval)

  const s = prepareStatements(handle.worker.db)
  const row = s.selectPendingApprovalBySession.get(conv.id) as PendingApprovalRow
  return reconstructPendingApproval(row)
}

describe('U5 — connect_required durable round-trip', () => {
  it('preserves reason/mcpServerName from persistSuspend through select → reconstruct', async () => {
    // Fixture derived from the REAL U5 producer, not hand-authored.
    const approval = buildConnectRequiredApproval(
      { id: 'call-1', name: 'monday__list_boards', arguments: { limit: 5 } },
      { mcpServerName: 'monday' }
    )

    const rehydrated = await roundTrip(approval)

    // Observable: the rehydrated suspension is a connect_required, not a generic
    // approval, and it still names the oauth server.
    expect(rehydrated.reason).toBe('connect_required')
    expect(rehydrated.mcpServerName).toBe('monday')
    expect(rehydrated.tool_name).toBe('monday__list_boards')
  })

  it('a generic HITL approval rehydrates with no reason/mcpServerName', async () => {
    const approval: PendingApproval = {
      request_id: 'req-approval-1',
      tool_name: 'internal__do',
      parameters: {},
      description: 'Approve internal__do',
      tool_call_id: 'call-2',
      context_snapshot: [],
    }

    const rehydrated = await roundTrip(approval)

    expect(rehydrated.reason).toBeUndefined()
    expect(rehydrated.mcpServerName).toBeUndefined()
  })
})
