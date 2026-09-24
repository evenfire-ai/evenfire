import { Worker } from 'node:worker_threads'

const MAX_BYTES = 256 * 1024
const MAX_NODES = 10_000
const MAX_DEPTH = 64
const DEADLINE_MS = 2_000
const MAX_WORKERS = 4
const MAX_QUEUED = 32
let activeWorkers = 0
const queue: Array<() => void> = []

export type SchemaValidationFailure =
  | 'input_limit'
  | 'queue_full'
  | 'timeout'
  | 'unsupported_schema'
  | 'invalid_schema'
  | 'invalid_arguments'
  | 'worker_failure'

function reserveWorker(): Promise<true | 'queue_full' | 'timeout'> {
  if (activeWorkers < MAX_WORKERS) {
    activeWorkers++
    return Promise.resolve(true)
  }
  if (queue.length >= MAX_QUEUED) return Promise.resolve('queue_full')
  return new Promise(resolve => {
    const start = () => {
      clearTimeout(timer)
      activeWorkers++
      resolve(true)
    }
    const timer = setTimeout(() => {
      queue.splice(queue.indexOf(start), 1)
      resolve('timeout')
    }, DEADLINE_MS)
    queue.push(start)
  })
}

function releaseWorker(): void {
  activeWorkers--
  queue.shift()?.()
}

/** Bound cloning/serialization before crossing the worker boundary. Catalog and
 * argument inputs are JSON data; reject accessors, cycles and non-JSON values.
 * No toJSON hook is called and no caller-owned value is mutated. */
export class BoundedJsonError extends Error {
  constructor(readonly failure: 'input_limit' | 'input_invalid') {
    super(failure)
  }
}

export function boundedJson(value: unknown): string {
  let nodes = 0
  let characters = 0
  const ancestors = new Set<object>()
  function clone(input: unknown, depth: number): unknown {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new BoundedJsonError('input_limit')
    if (typeof input === 'string') {
      characters += input.length
      if (characters > MAX_BYTES) throw new BoundedJsonError('input_limit')
      return input
    }
    if (input === null || typeof input === 'boolean') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (!input || typeof input !== 'object' || ancestors.has(input))
      throw new BoundedJsonError('input_invalid')
    const array = Array.isArray(input)
    if (
      !array &&
      Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null
    )
      throw new BoundedJsonError('input_invalid')
    if (array && input.length > MAX_NODES) throw new BoundedJsonError('input_limit')
    ancestors.add(input)
    const output: Record<string, unknown> | unknown[] = array ? [] : Object.create(null)
    let entries = 0
    for (const key in input) {
      if (!Object.hasOwn(input, key)) continue
      if (array && key !== String(entries)) throw new BoundedJsonError('input_invalid')
      entries++
      characters += key.length
      if (characters > MAX_BYTES) throw new BoundedJsonError('input_limit')
      const property = Object.getOwnPropertyDescriptor(input, key)!
      if (!('value' in property)) throw new BoundedJsonError('input_invalid')
      Object.defineProperty(output, key, {
        value: clone(property.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    if (array && entries !== input.length) throw new BoundedJsonError('input_invalid')
    ancestors.delete(input)
    return output
  }
  const serialized = JSON.stringify(clone(value, 0))
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new BoundedJsonError('input_limit')
  return serialized
}

// Trusted, static CommonJS worker program works in both source tests and tsc
// output. Only Ajv compile/evaluation executes here; no remote ref loader exists.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
let failure = 'invalid_schema';
try {
  const schema = JSON.parse(workerData.schema);
  const params = JSON.parse(workerData.params);
  const dialect = typeof schema.$schema === 'string' ? schema.$schema.replace(/#$/, '').replace(/^http:/, 'https:') : undefined;
  const index = dialect === undefined || dialect === 'https://json-schema.org/draft/2020-12/schema' ? 2
    : dialect === 'https://json-schema.org/draft/2019-09/schema' ? 1
    : dialect === 'https://json-schema.org/draft-07/schema' ? 0 : -1;
  if (index < 0 || schema.$async === true) { failure = 'unsupported_schema'; throw new Error(); }
  if (dialect !== undefined) schema.$schema = index === 0
    ? 'http://json-schema.org/draft-07/schema#' : dialect;
  const module = require(workerData.modules[index]);
  const Ajv = module.default || module;
  const ajv = new Ajv({ strict: false, allErrors: false, coerceTypes: false,
    useDefaults: false, removeAdditional: false, validateFormats: false });
  const validate = ajv.compile(schema);
  failure = 'invalid_arguments';
  parentPort.postMessage(validate(params) === true ? true : failure);
} catch { parentPort.postMessage(failure); }
`

/** Disposable workers with a bounded FIFO queue and total wait/execution deadline.
 * Capacity remains reserved until the worker actually exits, including timeout
 * cancellation. Resource exhaustion, startup errors and invalid replies fail closed.
 * No schema, arguments or Ajv diagnostics are returned to the Host. */
export async function validateBoundedSchema(
  schema: string,
  params: string,
  onFailure?: (failure: SchemaValidationFailure) => void
): Promise<boolean> {
  const reject = (failure: SchemaValidationFailure) => {
    onFailure?.(failure)
    return false
  }
  if (Buffer.byteLength(schema) > MAX_BYTES || Buffer.byteLength(params) > MAX_BYTES)
    return reject('input_limit')
  const deadline = Date.now() + DEADLINE_MS
  const reservation = await reserveWorker()
  if (reservation !== true) return reject(reservation)
  if (Date.now() >= deadline) {
    releaseWorker()
    return reject('timeout')
  }
  return new Promise<boolean>(resolve => {
    let worker: Worker
    let done = false
    const finish = (valid: boolean, failure: SchemaValidationFailure = 'worker_failure') => {
      if (done) return
      done = true
      clearTimeout(timer)
      // Successful sequential calls wait for capacity to be released on exit.
      if (valid && worker) {
        void worker.terminate().then(
          () => resolve(true),
          () => resolve(reject('worker_failure'))
        )
      } else {
        resolve(reject(failure))
        if (worker)
          void worker.terminate().catch(() => {
            /* Exit retains capacity ownership. */
          })
      }
    }
    const timer = setTimeout(() => finish(false, 'timeout'), Math.max(0, deadline - Date.now()))
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          schema,
          params,
          modules: [
            require.resolve('ajv'),
            require.resolve('ajv/dist/2019'),
            require.resolve('ajv/dist/2020'),
          ],
        },
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      })
      worker.once('message', message => {
        const failure = ['unsupported_schema', 'invalid_schema', 'invalid_arguments'].includes(
          message
        )
          ? (message as SchemaValidationFailure)
          : 'worker_failure'
        finish(message === true, failure)
      })
      worker.once('error', () => finish(false))
      worker.once('exit', () => {
        releaseWorker()
        finish(false)
      })
    } catch {
      releaseWorker()
      finish(false)
    }
  })
}
