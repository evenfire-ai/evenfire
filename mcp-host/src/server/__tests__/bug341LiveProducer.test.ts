import { expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { ConversationManager } from '../../core/conversation/conversation'
import { createSessionRouteHandlers } from '../sessionRouteHandlers'

const producerFixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../../desktop-app/ui/src/hooks/domain/__tests__/__fixtures__/bug341SessionProducer.json',
      import.meta.url
    ),
    'utf8'
  )
)

function normalizeTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeTimestamps)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [
        key,
        ['lastActivityAt', 'started_at', 'completed_at'].includes(key)
          ? '2000-01-01T00:00:00.000Z'
          : normalizeTimestamps(child),
      ])
  )
}
it('generates a catalog from actual session producer', async () => {
  const manager = new ConversationManager()
  for (const agent of ['agent-x', 'agent-y']) {
    const conversation = await manager.getOrCreate(`user-1:rpc:${agent}:chat-a`)
    await manager.startTurn(conversation, 'fixture request', 'fixture-task')
    await manager.completeTurn(conversation, 'fixture response')
  }
  const probe = await manager.getOrCreate('user-1:rpc:agent-x:catalog-probe')
  await manager.startTurn(probe, 'probe request', 'probe-task')
  await manager.completeTurn(probe, 'probe response')
  const { handleSessionsList, handleSessionMessages } = createSessionRouteHandlers({
    getConversationManager: () => manager,
    redactToolError: (_name, value) => value,
    redactTitle: value => value,
    approvalSnapshot: () => ({ effective: undefined, hostSpec: undefined }),
    sessionModel: () => ({ providerType: 'unknown', modelName: 'unknown' }),
  })
  const payload = await handleSessionsList('user-1', {})
  expect(payload.items.map(item => item.agent).sort()).toEqual(['agent-x', 'agent-x', 'agent-y'])
  const byAgent = Object.fromEntries(
    await Promise.all(
      ['agent-x', 'agent-y'].map(async agent => [
        agent,
        await handleSessionsList('user-1', { agent }),
      ])
    )
  )
  const history = await handleSessionMessages('user-1', 'agent-x', 'chat-a', {})
  expect(history?.turns).toHaveLength(1)
  const empty = await handleSessionsList('fixture-empty-user', {})
  expect(empty.items).toEqual([])
  const active = await manager.getOrCreate('user-1:rpc:agent-x:chat-a')
  await manager.startTurn(active, 'live task', 'fixture-completion')
  const live = await handleSessionMessages('user-1', 'agent-x', 'chat-a', {})
  expect(live?.activeTaskId).toBe('fixture-completion')
  expect(live?.state).toBe('processing')
  const other = await manager.getOrCreate('user-1:rpc:agent-x:chat-b')
  await manager.startTurn(other, 'other request', 'other-task')
  await manager.completeTurn(other, 'other reply')
  const idle = await handleSessionMessages('user-1', 'agent-x', 'chat-b', {})
  const producerPayload = { ...byAgent, history, empty, live, idle }
  expect(normalizeTimestamps(producerPayload)).toEqual(producerFixture)
  const outputPath = process.env.BUG341_PRODUCER_OUTPUT
  if (outputPath) writeFileSync(outputPath, JSON.stringify(producerPayload))
})
