import assert from 'node:assert/strict'
import { AUTHORITY_SCOPE } from './fixtures.mjs'

export default {
  ref: 'v0.11.0',
  handlesPendingCleanups: true,
  // git show v0.11.0:desktop-app/src/ipc.ts:1839-1862; cleanup at 1851-1860,
  // followed by getIndex at 1861. Sender/payload checks precede these store costs.
  verifyHandler({ start, end, source }) {
    assert.equal(start, 1839)
    assert.equal(end, 1862)
    assert.ok(
      source.indexOf('await store.retryPendingDeleteCleanups') <
        source.indexOf('return store.getIndex')
    )
    assert.ok(source.includes('retryPendingDeleteCleanups(authority.authorityScope, agentRef)'))
  },
  bind(ChatStore, root) {
    const store = new ChatStore(root)
    store.setAuthorityScope(AUTHORITY_SCOPE)
    return store
  },
  context(store) {
    let cleanupErrors = 0
    return {
      get cleanupErrors() {
        return cleanupErrors
      },
      async getIndex(agentRef) {
        try {
          await store.retryPendingDeleteCleanups(AUTHORITY_SCOPE, agentRef)
        } catch {
          // The historical handler reports the cleanup failure, then returns the
          // catalog. Retain a numeric witness instead of logging identifiers/errors.
          cleanupErrors += 1
        }
        return store.getIndex(agentRef)
      },
    }
  },
}
