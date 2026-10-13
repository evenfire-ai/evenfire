import { extname, join } from 'node:path'
import { serialize } from 'node:v8'
import { Worker } from 'node:worker_threads'
import type {
  DocumentJob,
  DocumentJobFailure,
  DocumentJobOutcome,
  DocumentLimitName,
  RunDocumentJob,
} from './types'

const { isMarkedAsUntransferable } = require('node:worker_threads') as {
  // Available in the required Node 24 runtime, beyond our Node 20 typings.
  isMarkedAsUntransferable(value: object): boolean
}

/**
 * A worker that crashes, exits without an outcome or posts a malformed one has
 * hit a defect, not an unreadable file. The fixed message never carries the
 * worker's own error text, which could quote document content.
 */
function workerFailed(): Error {
  return new Error('Document reader worker failed')
}

const JOB_FAILURE_REASONS: ReadonlySet<unknown> = new Set<DocumentJobFailure['reason']>([
  'no_text_layer',
  'document_encrypted',
  'document_parse_failed',
  'document_limits_exceeded',
  'invalid_range',
])
const LIMIT_NAMES: ReadonlySet<unknown> = new Set<DocumentLimitName>([
  'source_bytes',
  'page_count',
  'pixels',
  'image_bytes',
  'output_bytes',
  'time',
  'heap',
])

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null
const isArrayOf = (value: unknown, item: (entry: unknown) => boolean): boolean =>
  Array.isArray(value) && value.every(item)

/** `next` is set exactly when a per-call limit stopped the read, and names it. */
const hasStopReason = (message: Record<string, unknown>, stops: readonly string[]): boolean =>
  message.next === undefined
    ? message.stoppedBy === undefined
    : typeof message.stoppedBy === 'string' && stops.includes(message.stoppedBy)

/**
 * The outcome contract the Tool relies on, checked at the thread boundary so
 * a worker or dependency regression rejects as a defect instead of becoming a
 * malformed model-visible result. The Tool still checks content bounds.
 */
function isJobOutcome(kind: DocumentJob['kind'], message: unknown): boolean {
  if (!isRecord(message)) return false
  if (message.ok === false) {
    return (
      JOB_FAILURE_REASONS.has(message.reason) &&
      (message.limit === undefined || LIMIT_NAMES.has(message.limit)) &&
      (message.limit === undefined) === (message.reason !== 'document_limits_exceeded')
    )
  }
  if (message.ok !== true) return false
  switch (kind) {
    case 'pdf_text':
      return (
        isCount(message.pageCount) &&
        isArrayOf(
          message.pages,
          page =>
            isRecord(page) &&
            isCount(page.page) &&
            typeof page.text === 'string' &&
            isCount(page.from) &&
            isCount(page.to) &&
            page.from <= page.to &&
            page.to <= page.text.length &&
            typeof page.lowText === 'boolean'
        ) &&
        (message.next === undefined ||
          (isRecord(message.next) &&
            isCount(message.next.page) &&
            isCount(message.next.charOffset))) &&
        hasStopReason(message, ['max_pages', 'max_extracted_chars'])
      )
    case 'pdf_visual':
      return (
        isCount(message.pageCount) &&
        isArrayOf(
          message.images,
          image =>
            isRecord(image) &&
            isCount(image.page) &&
            isCount(image.width) &&
            isCount(image.height) &&
            image.png instanceof Uint8Array
        )
      )
    case 'xlsx':
      return (
        isArrayOf(message.sheetNames, name => typeof name === 'string') &&
        isArrayOf(
          message.sheets,
          sheet =>
            isRecord(sheet) &&
            typeof sheet.name === 'string' &&
            isCount(sheet.startRow) &&
            typeof sheet.truncated === 'boolean' &&
            isArrayOf(sheet.rows, row =>
              isArrayOf(
                row,
                cell => cell === null || ['string', 'number', 'boolean'].includes(typeof cell)
              )
            )
        ) &&
        (message.next === undefined ||
          (isRecord(message.next) &&
            isCount(message.next.sheetIndex) &&
            isCount(message.next.row))) &&
        hasStopReason(message, ['max_rows', 'max_cells'])
      )
  }
}

function workerEntry(): { filename: string; eval: boolean } {
  if (extname(__filename) !== '.ts') {
    return { filename: join(__dirname, 'worker.js'), eval: false }
  }
  const script = join(__dirname, 'worker.ts')
  // Source tests/dev have TypeScript and no adjacent emitted worker.js. Like
  // boundedSchemaValidation, use a static CommonJS bootstrap under eval. Only
  // repository TypeScript is transpiled; document bytes remain workerData.
  // Production dist runs the emitted worker directly and needs no compiler.
  return {
    eval: true,
    filename: `
      const fs = require('node:fs');
      const load = require('node:module').createRequire(${JSON.stringify(script)});
      const ts = load('typescript');
      require.extensions['.ts'] = (module, filename) => {
        const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
          fileName: filename,
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true
          }
        });
        module._compile(result.outputText, filename);
      };
      load(${JSON.stringify(script)});
    `,
  }
}

export const runDocumentJob: RunDocumentJob = <J extends DocumentJob>(
  job: J,
  signal?: AbortSignal
): Promise<DocumentJobOutcome<J>> => {
  if (signal?.aborted) return Promise.reject(signal.reason)
  if (job.bytes.byteLength > job.limits.maxSourceBytes) {
    return Promise.resolve({
      ok: false,
      reason: 'document_limits_exceeded',
      limit: 'source_bytes',
    } as DocumentJobOutcome<J>)
  }
  if (
    !Number.isSafeInteger(job.limits.timeoutMs) ||
    job.limits.timeoutMs < 1 ||
    !Number.isSafeInteger(job.limits.maxHeapMb) ||
    job.limits.maxHeapMb < 1 ||
    !Number.isSafeInteger(job.limits.maxOutputBytes) ||
    job.limits.maxOutputBytes < 1
  ) {
    return Promise.reject(new Error('Invalid document reader limits'))
  }

  return new Promise((resolve, reject) => {
    let worker: Worker | undefined
    let outcome: DocumentJobOutcome<J> | undefined
    let failure: DocumentJobFailure | undefined
    let defect = false
    let aborted = false
    let abortReason: unknown
    let exited = false

    const terminate = (nextFailure?: DocumentJobFailure) => {
      if (exited) return
      failure ??= nextFailure
      // The exit handler settles the promise, even when terminate() is
      // asynchronous or an error arrives while cancellation is in progress.
      // A rejected terminate() may never be followed by an exit event, so it
      // settles the call as a defect instead of leaving it pending.
      void worker?.terminate().catch(() => {
        if (exited) return
        exited = true
        cleanup()
        reject(aborted ? abortReason : workerFailed())
      })
    }
    const onAbort = () => {
      aborted = true
      abortReason = signal?.reason
      terminate()
    }
    const timer = setTimeout(
      () => terminate({ ok: false, reason: 'document_limits_exceeded', limit: 'time' }),
      job.limits.timeoutMs
    )
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onExit = (code: number) => {
      exited = true
      cleanup()
      if (aborted) reject(abortReason)
      else if (failure) resolve(failure as DocumentJobOutcome<J>)
      else if (defect || code !== 0 || !outcome) reject(workerFailed())
      else resolve(outcome)
    }

    try {
      const source = job.bytes
      // Exact, transferable backing stores cross the boundary without copying.
      // A view of a pooled/larger/SharedArrayBuffer gets one bounded owned copy.
      const bytes =
        source.buffer instanceof ArrayBuffer &&
        source.byteOffset === 0 &&
        source.byteLength === source.buffer.byteLength &&
        !isMarkedAsUntransferable(source.buffer)
          ? source
          : new Uint8Array(source)
      const entry = workerEntry()
      worker = new Worker(entry.filename, {
        eval: entry.eval,
        workerData: { ...job, bytes },
        transferList: [bytes.buffer as ArrayBuffer],
        // Do not inherit test loaders or process heap flags that can override
        // resourceLimits. Both source and dist have an explicit entry path.
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: job.limits.maxHeapMb,
          maxYoungGenerationSizeMb: Math.max(1, Math.min(16, Math.floor(job.limits.maxHeapMb / 4))),
          stackSizeMb: 4,
        },
        // Contain and discard dependency diagnostics; no PDF text, file names,
        // or parser errors can flow into the Host's logs via worker streams.
        stdout: true,
        stderr: true,
      })
      worker.stdout?.resume()
      worker.stderr?.resume()
      worker.once('message', (message: DocumentJobOutcome<J>) => {
        try {
          if (!isJobOutcome(job.kind, message)) {
            defect = true
            terminate()
          } else if (serialize(message).byteLength > job.limits.maxOutputBytes) {
            // V8 serialization measures the received structured outcome,
            // including the raw PNG buffers, never base64 or content logging.
            terminate({ ok: false, reason: 'document_limits_exceeded', limit: 'output_bytes' })
          } else {
            outcome = message
          }
        } catch {
          defect = true
          terminate()
        }
      })
      worker.once('error', (error: Error & { code?: string }) => {
        if (error.code === 'ERR_WORKER_OUT_OF_MEMORY') {
          terminate({ ok: false, reason: 'document_limits_exceeded', limit: 'heap' })
        } else {
          defect = true
          terminate()
        }
      })
      worker.once('exit', onExit)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    } catch (error) {
      if (worker) {
        defect = true
        terminate()
      } else {
        // The worker never started (for example a missing emitted worker.js).
        cleanup()
        reject(signal?.aborted ? signal.reason : error)
      }
    }
  })
}
