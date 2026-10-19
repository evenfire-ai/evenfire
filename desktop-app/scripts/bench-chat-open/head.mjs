import assert from 'node:assert/strict'
import { AUTHORITY_SCOPE } from './fixtures.mjs'

export default {
  ref: 'HEAD',
  handlesPendingCleanups: true,
  bind(ChatStore, root) {
    const store = new ChatStore(root)
    store.setAuthorityScope(AUTHORITY_SCOPE)
    return store
  },
  // HEAD's chat:getIndex handler in ipc.ts delegates to chatGetIndexHandler.ts;
  // the benchmark calls that compiled export.
  context(store, { runChatGetIndex }) {
    assert.equal(typeof runChatGetIndex, 'function')
    let cleanupErrors = 0
    const started = []
    const deps = {
      store: {
        retryPendingDeleteCleanups: (...args) => {
          const cleanup = store.retryPendingDeleteCleanups(...args)
          started.push(cleanup)
          return cleanup
        },
        getIndex: agentRef => store.getIndex(agentRef),
      },
      getChatDeletionFenceAuthority: () => ({ authorityScope: AUTHORITY_SCOPE }),
      warnCleanupFailure: () => {
        cleanupErrors += 1
      },
    }
    return {
      get cleanupErrors() {
        return cleanupErrors
      },
      getIndex: agentRef => runChatGetIndex(deps, agentRef),
      // Waits, outside timing, for exactly the cleanups the handler started, so
      // the fixture state afterwards is what the handler alone left behind.
      settle: async () => {
        await Promise.allSettled(started.splice(0))
      },
    }
  },
}
