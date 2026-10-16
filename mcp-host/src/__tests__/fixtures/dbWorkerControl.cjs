// Test-side preload for main.persistFailureExit.test.ts. Loaded with
// `node --require` before the compiled main.js, it replaces the Worker class
// on the worker_threads module so the conversation DB worker is still the
// real compiled dbWorker.js, and controls only how it receives one message:
//
// - DB_WORKER_CONTROL=withhold-shutdown: the `shutdown` op is never delivered,
//   as if the worker were wedged in its close checkpoint.
// - DB_WORKER_CONTROL=terminate-on-sigusr2: SIGUSR2 terminates the DB worker,
//   an unexpected worker exit while the Host is serving.
//
// Every other message reaches the real worker unchanged.
//
// In every mode the preload prints PRELOAD_SIGTERM_HANDLER_READY once main.ts
// has installed its SIGTERM handler, so a test never signals before it.
const workerThreads = require('node:worker_threads')

const sigtermReady = setInterval(() => {
  if (process.listenerCount('SIGTERM') > 0) {
    process.stdout.write('PRELOAD_SIGTERM_HANDLER_READY\n')
    clearInterval(sigtermReady)
  }
}, 5)
sigtermReady.unref()

const RealWorker = workerThreads.Worker
const mode = process.env.DB_WORKER_CONTROL
if (mode !== 'withhold-shutdown' && mode !== 'terminate-on-sigusr2') {
  throw new Error(`dbWorkerControl: unknown DB_WORKER_CONTROL '${mode}'`)
}

class ControlledWorker extends RealWorker {
  constructor(filename, options) {
    super(filename, options)
    this.isDbWorker = String(filename).endsWith('/db/worker/dbWorker.js')
    if (this.isDbWorker && mode === 'terminate-on-sigusr2') {
      process.once('SIGUSR2', () => {
        process.stdout.write('PRELOAD_TERMINATING_DB_WORKER\n')
        void this.terminate()
      })
    }
  }

  postMessage(msg, transfer) {
    if (this.isDbWorker && mode === 'withhold-shutdown' && msg?.op?.kind === 'shutdown') {
      process.stdout.write('PRELOAD_WITHHELD_SHUTDOWN\n')
      return
    }
    return super.postMessage(msg, transfer)
  }
}

workerThreads.Worker = ControlledWorker
