import { Worker } from 'node:worker_threads'

const MAX_BYTES = 256 * 1024
const MAX_NODES = 10_000
const MAX_DEPTH = 64
const DEADLINE_MS = 2_000
const MAX_WORKERS = 4
let activeWorkers = 0

/** Bound cloning/serialization before crossing the worker boundary. Catalog and
 * argument inputs are JSON data; reject accessors, cycles and non-JSON values.
 * No toJSON hook is called and no caller-owned value is mutated. */
export function boundedJson(value: unknown): string {
  let nodes = 0
  let characters = 0
  const ancestors = new Set<object>()
  function clone(input: unknown, depth: number): unknown {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error('JSON limit')
    if (typeof input === 'string') {
      characters += input.length
      if (characters > MAX_BYTES) throw new Error('JSON limit')
      return input
    }
    if (input === null || typeof input === 'boolean') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (!input || typeof input !== 'object' || ancestors.has(input)) throw new Error('JSON type')
    const array = Array.isArray(input)
    if (
      !array &&
      Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null
    )
      throw new Error('JSON type')
    if (array && input.length > MAX_NODES) throw new Error('JSON limit')
    ancestors.add(input)
    const output: Record<string, unknown> | unknown[] = array ? [] : Object.create(null)
    let entries = 0
    for (const key in input) {
      if (!Object.hasOwn(input, key)) continue
      if (array && key !== String(entries)) throw new Error('JSON array')
      entries++
      characters += key.length
      if (characters > MAX_BYTES) throw new Error('JSON limit')
      const property = Object.getOwnPropertyDescriptor(input, key)!
      if (!('value' in property)) throw new Error('JSON accessor')
      Object.defineProperty(output, key, {
        value: clone(property.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    if (array && entries !== input.length) throw new Error('JSON array')
    ancestors.delete(input)
    return output
  }
  const serialized = JSON.stringify(clone(value, 0))
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('JSON limit')
  return serialized
}

// Trusted, static CommonJS worker program works in both source tests and tsc
// output. Only Ajv compile/evaluation executes here; no remote ref loader exists.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  const schema = JSON.parse(workerData.schema);
  const params = JSON.parse(workerData.params);
  const dialect = typeof schema.$schema === 'string' ? schema.$schema.replace(/#$/, '') : undefined;
  const index = dialect === undefined || dialect === 'https://json-schema.org/draft/2020-12/schema' ? 2
    : dialect === 'https://json-schema.org/draft/2019-09/schema' ? 1
    : dialect === 'http://json-schema.org/draft-07/schema' ? 0 : -1;
  if (index < 0) throw new Error('Unsupported schema');
  const module = require(workerData.modules[index]);
  const Ajv = module.default || module;
  const ajv = new Ajv({ strict: false, allErrors: false, coerceTypes: false,
    useDefaults: false, removeAdditional: false, validateFormats: false });
  const validate = ajv.compile(schema);
  parentPort.postMessage(!('$async' in validate) && validate(params) === true);
} catch { parentPort.postMessage(false); }
`

/** One disposable worker per validation, no unbounded queue or schema cache.
 * Capacity remains reserved until the worker actually exits, including timeout
 * cancellation. Resource exhaustion, startup errors and invalid replies fail closed.
 * No schema, arguments or Ajv diagnostics are returned to the Host. */
export async function validateBoundedSchema(schema: string, params: string): Promise<boolean> {
  if (
    Buffer.byteLength(schema) > MAX_BYTES ||
    Buffer.byteLength(params) > MAX_BYTES ||
    activeWorkers >= MAX_WORKERS
  )
    return false
  activeWorkers++
  return new Promise<boolean>(resolve => {
    let worker: Worker
    let done = false
    const finish = (valid: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      // Successful sequential calls wait for capacity to be released on exit.
      if (valid && worker) {
        void worker.terminate().then(
          () => resolve(true),
          () => resolve(false)
        )
      } else {
        resolve(false)
        if (worker)
          void worker.terminate().catch(() => {
            /* Exit retains capacity ownership. */
          })
      }
    }
    const timer = setTimeout(() => finish(false), DEADLINE_MS)
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
      worker.once('message', message => finish(message === true))
      worker.once('error', () => finish(false))
      worker.once('exit', () => {
        activeWorkers--
        finish(false)
      })
    } catch {
      activeWorkers--
      finish(false)
    }
  })
}
