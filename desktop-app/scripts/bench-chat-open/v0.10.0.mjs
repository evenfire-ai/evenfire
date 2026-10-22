import assert from 'node:assert/strict'

export default {
  ref: 'v0.10.0',
  handlesPendingCleanups: false,
  // git show v0.10.0:desktop-app/src/ipc.ts:1575-1580: getIndex only.
  verifyHandler({ start, end, source }) {
    assert.equal(start, 1575)
    assert.equal(end, 1580)
    assert.ok(source.includes('return requireChatStore().getIndex(agentRef)'))
    assert.ok(!source.includes('retryPendingDeleteCleanups'))
  },
  bind(ChatStore, root) {
    return new ChatStore(root)
  },
  context(store) {
    return { cleanupErrors: 0, getIndex: agentRef => store.getIndex(agentRef) }
  },
}
