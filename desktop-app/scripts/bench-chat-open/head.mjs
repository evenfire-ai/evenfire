import assert from 'node:assert/strict'
import { AUTHORITY_SCOPE } from './fixtures.mjs'

export default {
  ref: 'HEAD',
  handlesPendingCleanups: true,
  // HEAD's chat:getIndex handler in ipc.ts delegates to chatGetIndexHandler.ts;
  // the benchmark calls that compiled export.
  verifyHandler({ source }) {
    assert.ok(source.includes('runChatGetIndex'))
  },
  bind(ChatStore, root) {
    const store = new ChatStore(root)
    store.setAuthorityScope(AUTHORITY_SCOPE)
    return store
  },
  context(store, { runChatGetIndex }) {
    assert.equal(typeof runChatGetIndex, 'function')
    let cleanupErrors = 0
    const deps = {
      store,
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
      // Drain the real cleanup outside timing before removing its fixture. This
      // also keeps a nonblocking handler from leaking work into another run.
      settle: () => store.retryPendingDeleteCleanups(AUTHORITY_SCOPE),
    }
  },
}
