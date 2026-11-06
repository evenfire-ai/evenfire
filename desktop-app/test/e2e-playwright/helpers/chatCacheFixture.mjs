import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

// A synthetic chat cache written through ChatStore: shared by the chat-open benchmark
// (scripts/bench-chat-open) and the Desktop A/B spec, which uses it as the large cache.
export const AUTHORITY_SCOPE = Object.freeze({
  environmentKey: 'benchmark-environment',
  userId: 'benchmark-user',
  teamId: 'benchmark-team',
})
export const TARGET_AGENT = 'agent-000'
export const FULL_CHAT = 'chat-0000'
export const PARTIAL_CHAT = 'chat-0001'
export const PAGE_SIZE = 100
export const PARTIAL_SIZE = 37

function messages(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: 'Synthetic benchmark message.',
    timestamp: 1_700_000_000_000 + index,
  }))
}

export const FULL_MESSAGES = messages(PAGE_SIZE)
export const PARTIAL_MESSAGES = messages(PARTIAL_SIZE)

export async function createFixture({
  runDir,
  adapter,
  ChatStore,
  agents,
  chatsPerAgent,
  pendingCleanupsPerAgent,
}) {
  const root = await fs.mkdtemp(join(runDir, 'data-'))
  const agentNames = Array.from(
    { length: agents },
    (_, index) => `agent-${String(index).padStart(3, '0')}`
  )
  const tombstones = Array.from({ length: pendingCleanupsPerAgent }, (_, index) => ({
    chatId: `deleted-${index}`,
    authorityScope: { ...AUTHORITY_SCOPE },
  }))
  const chats = Array.from({ length: chatsPerAgent }, (_, index) => ({
    id: `chat-${String(index).padStart(4, '0')}`,
    title: 'Synthetic benchmark chat',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    messageCount: index === 0 ? PAGE_SIZE : index === 1 ? PARTIAL_SIZE : 0,
    errorCount: 0,
    toolCallCount: 0,
  }))
  const index = {
    version: 2,
    lastActiveChatId: PARTIAL_CHAT,
    onboardingDismissed: false,
    chats,
    ...(tombstones.length
      ? { deletedChatTombstones: tombstones, pendingChatCleanup: tombstones }
      : {}),
  }
  const catalog = JSON.stringify(index, null, 2)
  const emptyChatCatalog = JSON.stringify(
    {
      ...index,
      chats: chats.map(chat => ({ ...chat, messageCount: 0 })),
    },
    null,
    2
  )
  for (const agent of agentNames) {
    const agentDir = join(root, agent)
    await fs.mkdir(join(agentDir, '.corrupt'), { recursive: true, mode: 0o700 })
    await fs.writeFile(
      join(agentDir, 'index.json'),
      agent === TARGET_AGENT ? catalog : emptyChatCatalog,
      { mode: 0o600 }
    )
    for (const tombstone of tombstones) {
      const chatDir = join(agentDir, 'chats', tombstone.chatId)
      await fs.mkdir(chatDir, { recursive: true, mode: 0o700 })
      await fs.writeFile(
        join(chatDir, 'meta.json'),
        JSON.stringify({
          version: 1,
          chatId: tombstone.chatId,
          pageSize: PAGE_SIZE,
          messageCount: 0,
          localMessageCount: 0,
          pages: [],
        }),
        { mode: 0o600 }
      )
      await fs.writeFile(
        join(agentDir, `${tombstone.chatId}.json`),
        JSON.stringify({
          version: 2,
          chatId: tombstone.chatId,
          messages: [],
        }),
        { mode: 0o600 }
      )
    }
  }
  // Use each version's own writer for valid page/compatibility metadata. Other
  // catalog entries are empty chats: their transcripts are not opened by this bench.
  const seedStore = adapter.bind(ChatStore, root)
  await seedStore.saveMessages(TARGET_AGENT, FULL_CHAT, FULL_MESSAGES)
  await seedStore.saveMessages(TARGET_AGENT, PARTIAL_CHAT, PARTIAL_MESSAGES)
  // Seeding updates activity/counts. Restore identical catalogs before a fresh bind.
  await fs.writeFile(join(root, TARGET_AGENT, 'index.json'), catalog, { mode: 0o600 })
  assert.equal(
    JSON.parse(await fs.readFile(join(root, TARGET_AGENT, 'index.json'), 'utf8')).chats.length,
    chatsPerAgent
  )
  if (tombstones.length) {
    assert.ok(
      (await fs.stat(join(root, TARGET_AGENT, 'chats', tombstones[0].chatId))).isDirectory()
    )
  }
  return { root, agentNames, tombstones, catalogBytes: Buffer.byteLength(catalog) }
}
