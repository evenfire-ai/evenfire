import { type ChildProcess, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { serialize } from 'node:v8'
import { logger } from '../../../logger'
import {
  DOCUMENT_CGROUP_MARGIN_BYTES,
  DOCUMENT_CHILD_VIRTUAL_RESERVE_BYTES,
  documentCgroupSampler,
  documentCgroupWorkingSetBytes,
  effectiveDocumentMemoryCaps,
} from './documentMemory'
import { oomVictimMarker } from './oomScore'
import { childVirtualDataBytes, residentMemorySampler } from './residentMemory'
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
  'row_width',
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
            isCount(sheet.lastRow) &&
            Array.isArray(sheet.rows) &&
            (sheet.skippedRows === undefined ||
              (isRecord(sheet.skippedRows) &&
                isCount(sheet.skippedRows.count, 1) &&
                isNonEmptyArrayOf(sheet.skippedRows.first, row => isCount(row, 1)) &&
                (sheet.skippedRows.first as unknown[]).length <= 20 &&
                (sheet.skippedRows.first as number[]).every(
                  row =>
                    row >= (sheet.startRow as number) &&
                    row < (sheet.startRow as number) + (sheet.rows as unknown[]).length
                ))) &&
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
        hasStopReason(message, ['max_rows', 'max_cells', 'max_extracted_chars'])
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

/**
 * `ignore_rlimit_data=Y` makes Linux ignore RLIMIT_DATA, so the hard child
 * ceiling would silently disappear. The premise is read on every job and
 * never cached; an unreadable parameter is indistinguishable from an ignored
 * limit and fails closed with `host_memory_unavailable`. macOS has no such
 * knob, and its direct spawn has no data limit.
 */
export async function rlimitDataEnforced(
  platform: NodeJS.Platform,
  filePath = '/sys/module/kernel/parameters/ignore_rlimit_data'
): Promise<boolean> {
  if (platform === 'darwin') return true
  if (platform !== 'linux') {
    throw new Error('Unsupported document reader RLIMIT_DATA platform')
  }
  try {
    return (await readFile(filePath, 'utf8')).trim() === 'N'
  } catch {
    return false
  }
}

/** RLIMIT_DATA in KiB: the resident cap plus the child's non-resident VmData. */
export function dataLimitKiB(maxResidentBytes: number): number {
  return Math.ceil((maxResidentBytes + DOCUMENT_CHILD_VIRTUAL_RESERVE_BYTES) / 1_024)
}

export interface WorkerSpawnCommand {
  file: string
  args: string[]
}

/**
 * Linux caps the child's data segment from the shell: `ulimit -d` takes KiB,
 * then `exec "$@"` replaces the shell and preserves each argument exactly,
 * including the multiline source bootstrap. macOS keeps the direct spawn.
 */
export function workerSpawnCommand(
  platform: NodeJS.Platform,
  maxResidentBytes: number,
  maxHeapMb: number
): WorkerSpawnCommand {
  const heap = '--max-old-space-size=' + maxHeapMb
  if (platform === 'linux') {
    return {
      file: '/bin/sh',
      args: [
        '-c',
        'ulimit -d "$0" && exec "$@"',
        String(dataLimitKiB(maxResidentBytes)),
        process.execPath,
        heap,
        ...workerEntry(),
      ],
    }
  }
  return { file: process.execPath, args: [heap, ...workerEntry()] }
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
    let markOomVictim: ReturnType<typeof oomVictimMarker>
    let caps: ReturnType<typeof effectiveDocumentMemoryCaps>
    let rlimitEnforced: boolean
    try {
      sampleResidentMemory = residentMemorySampler(process.platform)
      sampleCgroupMemory = documentCgroupSampler(process.platform)
      markOomVictim = oomVictimMarker(process.platform)
      rlimitEnforced = await rlimitDataEnforced(process.platform)
      caps = rlimitEnforced
        ? effectiveDocumentMemoryCaps(job.limits, await sampleCgroupMemory())
        : null
    } catch {
      release()
      throw workerFailed()
    }
    if (signal?.aborted) {
      release()
      throw signal.reason
    }
    if (!rlimitEnforced) {
      release()
      // Linux would ignore the hard ceiling; never run unbounded.
      return { ok: false, reason: 'host_memory_unavailable' } as DocumentJobOutcome<J>
    }
    if (!caps) {
      release()
      // The Host lacks headroom before any document byte is parsed.
      return { ok: false, reason: 'host_memory_unavailable' } as DocumentJobOutcome<J>
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
      let maxSampledResidentBytes = 0
      let childVmDataBytes: number | null = null
      let vmDataSampled = false

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
          // Before a failed spawn emits `error`, its handle still exists with
          // pid 0, and kill(0) would signal the Host's whole process group.
          if (!child || child.pid === undefined || !child.kill('SIGKILL')) throw workerFailed()
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
        const signaledHeap =
          !defect &&
          (exitSignal === 'SIGABRT' || exitSignal === 'SIGKILL' || exitSignal === 'SIGTRAP')
        const result: 'ok' | 'failure' | 'defect' | 'aborted' = aborted
          ? 'aborted'
          : failure
            ? 'failure'
            : signaledHeap
              ? 'failure'
              : defect || code !== 0 || !outcome
                ? 'defect'
                : 'ok'
        const limit: DocumentLimitName | undefined =
          result === 'failure'
            ? (failure?.limit ??
              (signaledHeap
                ? 'heap'
                : outcome !== undefined && !outcome.ok
                  ? outcome.limit
                  : undefined))
            : undefined
        // One line per job: limits and observed memory only. Never document
        // content, file paths or the child's error text.
        logger.info(
          {
            outcome: result,
            ...(limit === undefined ? {} : { limit }),
            exitSignal,
            exitCode: code,
            residentCapBytes: memoryCaps.maxResidentBytes,
            dataLimitKiB:
              process.platform === 'linux' ? dataLimitKiB(memoryCaps.maxResidentBytes) : null,
            maxSampledResidentBytes,
            ...(typeof childVmDataBytes === 'number' ? { childVmDataBytes } : {}),
          },
          'document reader job finished'
        )
        if (aborted) reject(abortReason)
        else if (failure) resolve(failure as DocumentJobOutcome<J>)
        else if (signaledHeap) {
          // V8 heap exhaustion aborts or traps; the OS OOM killer uses SIGKILL.
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
            documentCgroupWorkingSetBytes(cgroup) >= cgroup.maxBytes - DOCUMENT_CGROUP_MARGIN_BYTES
          ) {
            terminate({ ok: false, reason: 'document_limits_exceeded', limit: 'heap' })
            return
          }
          const bytes = await sampleResidentMemory(child.pid)
          if (!stopping && !exited) {
            maxSampledResidentBytes = Math.max(maxSampledResidentBytes, bytes)
            if (bytes > memoryCaps.maxResidentBytes) {
              terminate({ ok: false, reason: 'document_limits_exceeded', limit: 'heap' })
            } else if (!vmDataSampled && process.platform === 'linux') {
              // Telemetry only: a read racing the exit omits the field.
              vmDataSampled = true
              try {
                childVmDataBytes = await childVirtualDataBytes(child.pid)
              } catch {
                childVmDataBytes = null
              }
            }
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
        const command = workerSpawnCommand(
          process.platform,
          memoryCaps.maxResidentBytes,
          memoryCaps.maxHeapMb
        )
        child = spawn(command.file, command.args, {
          // The child inherits no environment variables or Node loaders. It
          // is a memory and time boundary, not a security sandbox: it runs
          // as the Host's user.
          env: {},
          // Dependency diagnostics may contain document data. Discard them.
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          serialization: 'advanced',
        })
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
          const spawned = child
          if (spawned.pid === undefined || !spawned.send) throw workerFailed()
          // The job is sent only once the child is the OOM victim, so it never
          // runs unmarked; a failed mark is a defect.
          markOomVictim(spawned.pid).then(
            () => {
              if (exited || stopping) return
              // Advanced IPC serializes only the supplied byte view. The source
              // cap bounds this copy, and the caller retains its bytes.
              spawned.send(job, error => {
                if (error && !exited && !stopping) {
                  defect = true
                  terminate()
                }
              })
            },
            () => {
              if (exited || stopping) return
              defect = true
              terminate()
            }
          )
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
