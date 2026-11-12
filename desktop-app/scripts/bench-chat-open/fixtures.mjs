import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join, sep } from 'node:path'
import {
  AUTHORITY_SCOPE,
  FULL_CHAT,
  PARTIAL_MESSAGES,
  TARGET_AGENT,
} from '../../test/e2e-playwright/helpers/chatCacheFixture.mjs'

export {
  AUTHORITY_SCOPE,
  FULL_CHAT,
  FULL_MESSAGES,
  PAGE_SIZE,
  PARTIAL_CHAT,
  PARTIAL_MESSAGES,
  PARTIAL_SIZE,
  TARGET_AGENT,
  createFixture,
} from '../../test/e2e-playwright/helpers/chatCacheFixture.mjs'

export function captureFilesystemFailures(root, failCleanup) {
  const originalReaddir = fs.readdir
  const originalWarn = console.warn
  const counters = { filesystemFailures: 0, warnings: 0 }
  // Imported historical code logs identifiers on cleanup failure. Count those
  // diagnostics without copying their identifiers or error text into bench logs.
  console.warn = () => {
    counters.warnings += 1
  }
  fs.readdir = function (path, ...args) {
    if (
      failCleanup &&
      typeof path === 'string' &&
      path.startsWith(`${root}${sep}`) &&
      path.endsWith(`${sep}.corrupt`)
    ) {
      counters.filesystemFailures += 1
      return Promise.reject(
        Object.assign(new Error('Synthetic filesystem denial'), { code: 'EACCES' })
      )
    }
    return originalReaddir.call(this, path, ...args)
  }
  return {
    counters,
    restore() {
      fs.readdir = originalReaddir
      console.warn = originalWarn
    },
  }
}

export async function inspectFixture(fixture, chatsPerAgent) {
  let pending = 0
  let retainedArtifactDirectories = 0
  for (const agent of fixture.agentNames) {
    const agentDir = join(fixture.root, agent)
    const index = JSON.parse(await fs.readFile(join(agentDir, 'index.json'), 'utf8'))
    assert.equal(index.chats.length, chatsPerAgent)
    assert.deepEqual(index.deletedChatTombstones ?? [], fixture.tombstones)
    pending += (index.pendingChatCleanup ?? []).length
    for (const tombstone of fixture.tombstones) {
      try {
        assert.ok((await fs.stat(join(agentDir, 'chats', tombstone.chatId))).isDirectory())
        retainedArtifactDirectories += 1
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }
  const targetIndex = JSON.parse(
    await fs.readFile(join(fixture.root, TARGET_AGENT, 'index.json'), 'utf8')
  )
  assert.equal(targetIndex.lastActiveChatId, FULL_CHAT)
  return { pending, retainedArtifactDirectories }
}

export async function verifyFailingFilesystemModel({ runDir, adapter, ChatStore }) {
  if (!adapter.handlesPendingCleanups) {
    return { supported: false, reason: 'This version predates durable pending-delete cleanup.' }
  }
  const root = await fs.mkdtemp(join(runDir, 'cleanup-proof-'))
  const store = adapter.bind(ChatStore, root)
  const chatId = 'cleanup-proof'
  const artifact = join(root, TARGET_AGENT, 'chats', chatId)
  try {
    await store.createChat(TARGET_AGENT, chatId)
    await store.saveMessages(TARGET_AGENT, chatId, PARTIAL_MESSAGES)
    assert.deepEqual(await store.loadMessages(TARGET_AGENT, chatId), PARTIAL_MESSAGES)
    assert.ok((await fs.stat(artifact)).isDirectory())
    // chatStore.test.ts:305-335: EACCES from readdir during delete leaves the
    // tombstone + cleanup queue and real artifacts; a subsequent retry removes them.
    const failure = captureFilesystemFailures(root, true)
    let failedAttempts
    try {
      assert.deepEqual(await store.deleteChat(TARGET_AGENT, chatId, AUTHORITY_SCOPE), {
        cleanupPending: true,
      })
      assert.equal((await store.getIndex(TARGET_AGENT)).pendingChatCleanup.length, 1)
      assert.ok((await fs.stat(artifact)).isDirectory())
      await store.retryPendingDeleteCleanups(AUTHORITY_SCOPE, TARGET_AGENT)
      assert.equal((await store.getIndex(TARGET_AGENT)).pendingChatCleanup.length, 1)
      failedAttempts = { ...failure.counters }
      assert.ok(failedAttempts.filesystemFailures >= 2)
      assert.ok(failedAttempts.warnings > 0)
    } finally {
      failure.restore()
    }
    await store.retryPendingDeleteCleanups(AUTHORITY_SCOPE, TARGET_AGENT)
    assert.equal((await store.getIndex(TARGET_AGENT)).pendingChatCleanup.length, 0)
    assert.equal((await store.getIndex(TARGET_AGENT)).deletedChatTombstones.length, 1)
    await assert.rejects(fs.stat(artifact), { code: 'ENOENT' })
    return {
      supported: true,
      verified: true,
      ...failedAttempts,
      retainedWhileFailing: true,
      removedAfterRetry: true,
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
