import { type ChildProcess, spawn } from 'node:child_process'
import { extname, join } from 'node:path'
import { serialize } from 'node:v8'
import {
  DOCUMENT_CGROUP_MARGIN_BYTES,
  documentCgroupSampler,
  effectiveDocumentMemoryCaps,
} from './documentMemory'
import { residentMemorySampler } from './residentMemory'
import type {
  DocumentJob,
  DocumentJobFailure,
  DocumentJobOutcome,
  DocumentLimitName,
  RunDocumentJob,
} from './types'

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
  'document_empty',
  'document_limits_exceeded',
  'invalid_range',
])
const LIMIT_NAMES: ReadonlySet<unknown> = new Set<DocumentLimitName>([
  'source_bytes',
  'uncompressed_bytes',
  'page_count',
  'pixels',
  'image_bytes',
  'output_bytes',
  'time',
  'heap',
])

const isCount = (value: unknown, minimum = 0): value is number =>
  Number.isSafeInteger(value) && (value as number) >= minimum
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null
const isArrayOf = (value: unknown, item: (entry: unknown) => boolean): boolean =>
  Array.isArray(value) && value.every(item)
/** A success always delivers content: the producers never emit an empty one. */
const isNonEmptyArrayOf = (value: unknown, item: (entry: unknown) => boolean): boolean =>
  isArrayOf(value, item) && (value as unknown[]).length > 0

/** `next` is set exactly when a per-call limit stopped the read, and names it. */
const hasStopReason = (message: Record<string, unknown>, stops: readonly string[]): boolean =>
  message.next === undefined
    ? message.stoppedBy === undefined
    : typeof message.stoppedBy === 'string' && stops.includes(message.stoppedBy)

/**
 * The outcome contract the Tool relies on, checked at the process boundary so
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
        isCount(message.pageCount, 1) &&
        isNonEmptyArrayOf(
          message.pages,
          page =>
            isRecord(page) &&
            isCount(page.page, 1) &&
            page.page <= (message.pageCount as number) &&
            typeof page.text === 'string' &&
            isCount(page.from) &&
            isCount(page.to) &&
            page.from <= page.to &&
            page.to <= page.text.length &&
            typeof page.lowText === 'boolean'
        ) &&
        (message.next === undefined ||
          (isRecord(message.next) &&
            isCount(message.next.page, 1) &&
            message.next.page <= message.pageCount &&
            isCount(message.next.charOffset))) &&
        hasStopReason(message, ['max_pages', 'max_extracted_chars'])
      )
    case 'pdf_visual':
      return (
        isCount(message.pageCount, 1) &&
        isNonEmptyArrayOf(
          message.images,
          image =>
            isRecord(image) &&
            isCount(image.page, 1) &&
            image.page <= (message.pageCount as number) &&
            isCount(image.width, 1) &&
            isCount(image.height, 1) &&
            image.png instanceof Uint8Array
        ) &&
        (message.next === undefined ||
          (isRecord(message.next) &&
            isCount(message.next.page, 1) &&
            message.next.page <= message.pageCount &&
            message.next.charOffset === 0)) &&
        hasStopReason(message, ['max_pages'])
      )
    case 'xlsx':
      return (
        Array.isArray(message.sheetNames) &&
        isArrayOf(message.sheetNames, name => typeof name === 'string') &&
        isArrayOf(
          message.sheets,
          sheet =>
            isRecord(sheet) &&
            typeof sheet.name === 'string' &&
            isCount(sheet.startRow, 1) &&
            typeof sheet.truncated === 'boolean' &&
            isArrayOf(sheet.rows, row =>
              isArrayOf(
                row,
                cell => cell === null || ['string', 'number', 'boolean'].includes(typeof cell)
              )
            )
        ) &&
        (message.sheets as Array<{ rows: unknown[] }>).some(sheet => sheet.rows.length > 0) &&
        (message.next === undefined ||
          (isRecord(message.next) &&
            isCount(message.next.sheetIndex) &&
            message.next.sheetIndex < message.sheetNames.length &&
            isCount(message.next.row, 1))) &&
        hasStopReason(message, ['max_rows', 'max_cells'])
      )
  }
}

function workerEntry(): string[] {
  if (extname(__filename) !== '.ts') return [join(__dirname, 'worker.js')]
  const script = join(__dirname, 'worker.ts')
  // Source tests/dev transpile repository TypeScript in the child. The
  // production entry is emitted JavaScript and never loads a compiler.
  const bootstrap = [
    "const fs = require('node:fs');",
    "const load = require('node:module').createRequire(" + JSON.stringify(script) + ');',
    "const ts = load('typescript');",
    "require.extensions['.ts'] = (module, filename) => {",
    "  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {",
    '    fileName: filename,',
    '    compilerOptions: {',
    '      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true',
    '    }',
    '  });',
    '  module._compile(result.outputText, filename);',
    '};',
    'load(' + JSON.stringify(script) + ');',
  ].join('\n')
  return ['-e', bootstrap]
}

interface WaitingDocumentReader {
  start: () => void
}

let documentReaderActive = false
const waitingDocumentReaders: WaitingDocumentReader[] = []

/** One child owns cgroup headroom until its exit is observed. */
function acquireDocumentReader(signal?: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const index = waitingDocumentReaders.indexOf(waiting)
      if (index >= 0) waitingDocumentReaders.splice(index, 1)
      reject(signal?.reason)
    }
    const waiting: WaitingDocumentReader = {
      start: () => {
        signal?.removeEventListener('abort', onAbort)
        documentReaderActive = true
        let released = false
        resolve(() => {
          if (released) return
          released = true
          // Settle the complete public promise chain before admitting the next
          // job, including the async cgroup-read and child-outcome layers.
          setImmediate(() => {
            documentReaderActive = false
            waitingDocumentReaders.shift()?.start()
          })
        })
      },
    }
    if (signal?.aborted) return reject(signal.reason)
    if (!documentReaderActive) waiting.start()
    else {
      waitingDocumentReaders.push(waiting)
      signal?.addEventListener('abort', onAbort, { once: true })
    }
  })
}

export const runDocumentJob: RunDocumentJob = <J extends DocumentJob>(
  job: J,
  signal?: AbortSignal
): Promise<DocumentJobOutcome<J>> => {
  if (signal?.aborted) return Promise.reject(signal.reason)
  const requiredLimits = [
    job.limits.maxSourceBytes,
    job.limits.maxUncompressedBytes,
    job.limits.timeoutMs,
    job.limits.maxHeapMb,
    job.limits.maxResidentMb,
    job.limits.maxOutputBytes,
    job.limits.maxRenderPixelsPerCall,
    job.limits.maxEmbeddedImagePixels,
  ]
  if (requiredLimits.some(value => !Number.isSafeInteger(value) || value < 1)) {
    return Promise.reject(new Error('Invalid document reader limits'))
  }
  if (job.bytes.byteLength > job.limits.maxSourceBytes) {
    return Promise.resolve({
      ok: false,
      reason: 'document_limits_exceeded',
      limit: 'source_bytes',
    } as DocumentJobOutcome<J>)
  }

  return acquireDocumentReader(signal).then(async release => {
    let sampleResidentMemory: (pid: number) => Promise<number>
    let sampleCgroupMemory: ReturnType<typeof documentCgroupSampler>
    let caps: ReturnType<typeof effectiveDocumentMemoryCaps>
    try {
      sampleResidentMemory = residentMemorySampler(process.platform)
      sampleCgroupMemory = documentCgroupSampler(process.platform)
      caps = effectiveDocumentMemoryCaps(job.limits, await sampleCgroupMemory())
    } catch {
      release()
      throw workerFailed()
    }
    if (signal?.aborted) {
      release()
      throw signal.reason
    }
    if (!caps) {
      release()
      return {
        ok: false,
        reason: 'document_limits_exceeded',
        limit: 'heap',
      } as DocumentJobOutcome<J>
    }
    const memoryCaps = caps
    return new Promise<DocumentJobOutcome<J>>((resolve, reject) => {
      let child: ChildProcess | undefined
      let outcome: DocumentJobOutcome<J> | undefined
      let failure: DocumentJobFailure | undefined
      let defect = false
      let aborted = false
      let abortReason: unknown
      let exited = false
      let stopping = false
      let sampling = false
      let residentTimer: ReturnType<typeof setInterval> | undefined

      const cleanup = () => {
        clearTimeout(timer)
        clearInterval(residentTimer)
        signal?.removeEventListener('abort', onAbort)
      }
      const terminate = (nextFailure?: DocumentJobFailure) => {
        if (exited || stopping) return
        if (failure === undefined) failure = nextFailure
        stopping = true
        try {
          if (!child || !child.kill('SIGKILL')) throw workerFailed()
        } catch {
          // A failed kill may have no exit event. Reject instead of leaving the
          // call pending; never turn a termination defect into a typed limit.
          exited = true
          cleanup()
          reject(aborted ? abortReason : workerFailed())
          // A spawn that never created a process emits no exit and holds no
          // memory. A live child keeps the slot until its exit is observed.
          if (child?.pid === undefined) release()
        }
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
      const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) => {
        exited = true
        cleanup()
        if (aborted) reject(abortReason)
        else if (failure) resolve(failure as DocumentJobOutcome<J>)
        else if (!defect && (exitSignal === 'SIGABRT' || exitSignal === 'SIGKILL')) {
          // V8 heap exhaustion aborts Node; the OS OOM killer uses SIGKILL.
          resolve({
            ok: false,
            reason: 'document_limits_exceeded',
            limit: 'heap',
          } as DocumentJobOutcome<J>)
        } else if (defect || code !== 0 || !outcome) reject(workerFailed())
        else resolve(outcome)
        release()
      }
      const sample = async () => {
        if (sampling || stopping || exited || !child || child.pid === undefined) return
        sampling = true
        try {
          const cgroup = await sampleCgroupMemory()
          if (
            !stopping &&
            !exited &&
            cgroup?.maxBytes !== null &&
            cgroup !== null &&
            cgroup.currentBytes >= cgroup.maxBytes - DOCUMENT_CGROUP_MARGIN_BYTES
          ) {
            terminate({ ok: false, reason: 'document_limits_exceeded', limit: 'heap' })
            return
          }
          const bytes = await sampleResidentMemory(child.pid)
          if (!stopping && !exited && bytes > memoryCaps.maxResidentBytes) {
            terminate({ ok: false, reason: 'document_limits_exceeded', limit: 'heap' })
          }
        } catch {
          // A read racing an observed exit needs no cap. Every failure while
          // the child is still live is a defect and stops the job.
          if (!stopping && !exited && child.exitCode === null && child.signalCode === null) {
            defect = true
            terminate()
          }
        } finally {
          sampling = false
        }
      }

      try {
        child = spawn(
          process.execPath,
          ['--max-old-space-size=' + memoryCaps.maxHeapMb, ...workerEntry()],
          {
            // No Host secrets or inherited Node loaders reach the child.
            env: {},
            // Dependency diagnostics may contain document data. Discard them.
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            serialization: 'advanced',
          }
        )
        child.once('message', (message: DocumentJobOutcome<J>) => {
          try {
            if (!isJobOutcome(job.kind, message)) {
              defect = true
              terminate()
            } else if (serialize(message).byteLength > job.limits.maxOutputBytes) {
              terminate({ ok: false, reason: 'document_limits_exceeded', limit: 'output_bytes' })
            } else {
              outcome = message
            }
          } catch {
            defect = true
            terminate()
          }
        })
        child.once('error', () => {
          defect = true
          terminate()
        })
        child.once('exit', onExit)
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) onAbort()
        if (!stopping) {
          residentTimer = setInterval(() => void sample(), 25)
          void sample()
          // Advanced IPC serializes only the supplied byte view. The source cap
          // bounds this copy, and the caller retains ownership of its bytes.
          if (!child.send) throw workerFailed()
          child.send(job, error => {
            if (error && !exited && !stopping) {
              defect = true
              terminate()
            }
          })
        }
      } catch {
        if (child) {
          defect = true
          terminate()
        } else {
          cleanup()
          reject(signal?.aborted ? signal.reason : workerFailed())
          release()
        }
      }
    })
  })
}
