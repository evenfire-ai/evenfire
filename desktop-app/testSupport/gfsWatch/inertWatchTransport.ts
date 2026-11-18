import { afterEach } from 'vitest'
import { setGfsWatchTransportDefaults } from '../../src/gfs/watchTransportDefaults.js'

/**
 * Vitest setup: a GFS watch client created without its own transport (every
 * AppService built by a test that is not about the watch) gets a GET that never
 * answers until it is aborted, so no session token leaves the process and no
 * reconnect timer outlives its test. Each such client is disposed after its
 * test. Tests of the watch pass their own `fetch` and are unaffected.
 */
const created = new Set<{ dispose(): void }>()

setGfsWatchTransportDefaults({
  fetch: (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    }),
  onClientCreated: client => created.add(client),
})

afterEach(() => {
  for (const client of created) client.dispose()
  created.clear()
})
