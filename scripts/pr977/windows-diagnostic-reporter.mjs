import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const desktopRoot = process.env.PR977_DESKTOP_ROOT
if (!desktopRoot || !path.isAbsolute(desktopRoot)) {
  throw new Error('The diagnostic reporter requires the exact Desktop checkout root')
}
const { JsonReporter } = await import(
  pathToFileURL(path.join(desktopRoot, 'node_modules/vitest/dist/reporters.js')).href
)
const progressPath = process.env.PR977_PROGRESS_PATH
const progressStartedAt = Date.now()

function safeLabel(value, limit = 180) {
  return String(value ?? '')
    .replace(/[\r\n]/g, ' ')
    .replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_.-]{20,}\b/g, '<token>')
    .replace(/\b[A-Za-z0-9_=-]{32,}\b/g, '<value>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/)[^\s:]+/g, '<path>')
    .slice(0, limit)
}

// Keep Vitest's counters, statuses and file inventory intact. Its JSON reporter uses
// error.stack OR error.message, losing the timeout message when the stack is STACK_TRACE_ERROR.
export default class WindowsDiagnosticReporter extends JsonReporter {
  taskFiles = new Map()
  startedFiles = new Set()
  completedFiles = new Set()
  completedCases = 0
  passedCases = 0
  failedCases = 0
  skippedCases = 0
  active = { file: null, testCase: null, hook: null }
  lastCompletedOperation = 'run-created'

  progress(event, fields = {}) {
    if (!progressPath) return
    const record = {
      elapsedMs: Date.now() - progressStartedAt,
      event,
      activeFile: this.active.file,
      activeCase: this.active.testCase,
      activeHook: this.active.hook,
      lastCompletedOperation: this.lastCompletedOperation,
      filesStarted: this.startedFiles.size,
      filesCompleted: this.completedFiles.size,
      casesCompleted: this.completedCases,
      passed: this.passedCases,
      failed: this.failedCases,
      skipped: this.skippedCases,
      ...fields,
    }
    appendFileSync(progressPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8' })
  }

  fileFor(entity) {
    // Vitest 4.1 reporter hooks receive TestModule/TestCase entities directly.
    const file =
      entity?.filepath ??
      entity?.module?.relativeModuleId ??
      entity?.module?.moduleId ??
      entity?.relativeModuleId ??
      entity?.moduleId ??
      entity?.task?.filepath
    return file ? path.basename(String(file)) : null
  }

  diagnosticErrors(task, fallbackPhase, moduleErrors = []) {
    const hooks = task.result?.hooks ?? {}
    const failedHooks = ['beforeAll', 'beforeEach', 'afterEach', 'afterAll'].filter(
      name => hooks[name] === 'run'
    )
    // Vitest leaves a throwing hook in "run" and marks only successful hooks "pass".
    // Event updates are batched; do not infer error timing from reporter callback order.
    const setup = failedHooks.some(name => name.startsWith('before'))
    const teardown = failedHooks.some(name => name.startsWith('after'))
    const phase = setup
      ? teardown
        ? 'setup-or-teardown'
        : 'setup'
      : teardown
        ? 'test-or-teardown'
        : fallbackPhase
    return [...(task.result?.errors ?? []), ...moduleErrors].map(error => ({
      message: error.message,
      stack: error.stack,
      name: error.name,
      code: error.code,
      reason:
        typeof error.reason === 'string' && /^[a-z-]{1,80}$/.test(error.reason)
          ? error.reason
          : undefined,
      diagnostic: this.safeNativeDiagnostic(error.diagnostic),
      phase,
      failedHooks,
    }))
  }

  safeNativeDiagnostic(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const allowed = new Set([
      'failure',
      'elapsedMs',
      'processErrorCode',
      'exitStatus',
      'signal',
      'nativePhase',
      'nativeErrorType',
      'hresult',
      'nativeOperation',
      'win32Error',
      'nativeReason',
    ])
    const safe = {}
    for (const [key, item] of Object.entries(value)) {
      if (!allowed.has(key)) continue
      if (typeof item === 'string' && /^[A-Za-z0-9x-]{1,80}$/.test(item)) safe[key] = item
      else if (
        typeof item === 'number' &&
        Number.isSafeInteger(item) &&
        item >= -1 &&
        item <= 60_000
      ) {
        safe[key] = item
      } else if (item === null && key === 'exitStatus') {
        safe[key] = null
      }
    }
    return Object.keys(safe).length ? safe : undefined
  }

  onTestModuleQueued(module) {
    this.active.file = this.fileFor(module)
    this.active.testCase = null
    this.active.hook = null
    this.progress('file-queued')
    return super.onTestModuleQueued?.(module)
  }

  onTestModuleStart(module) {
    const file = this.fileFor(module)
    this.active.file = file
    if (file) this.startedFiles.add(file)
    this.active.testCase = null
    this.active.hook = null
    this.progress('file-started')
    return super.onTestModuleStart?.(module)
  }

  onTestCaseReady(test) {
    this.active.file = this.fileFor(test) ?? this.active.file
    this.active.testCase = safeLabel(test.name)
    this.active.hook = null
    this.progress('case-started')
    return super.onTestCaseReady?.(test)
  }

  onHookStart(hook) {
    this.active.file = this.fileFor(hook.entity) ?? this.active.file
    this.active.testCase = hook.entity?.type === 'test' ? safeLabel(hook.entity.name) : null
    this.active.hook = ['beforeAll', 'beforeEach', 'afterEach', 'afterAll'].includes(hook.name)
      ? hook.name
      : 'unknown-hook'
    this.progress('hook-started')
    return super.onHookStart?.(hook)
  }

  onHookEnd(hook) {
    this.active.file = this.fileFor(hook.entity) ?? this.active.file
    this.active.hook = null
    this.lastCompletedOperation = `${hook.name}-completed`
    this.progress('hook-completed')
    return super.onHookEnd?.(hook)
  }

  onTestCaseResult(test) {
    const result = test.result?.()
    this.completedCases += 1
    if (result?.state === 'passed') this.passedCases += 1
    else if (result?.state === 'failed') this.failedCases += 1
    else this.skippedCases += 1
    this.active.file = this.fileFor(test) ?? this.active.file
    this.active.testCase = null
    this.active.hook = null
    this.lastCompletedOperation = 'case-completed'
    this.progress('case-completed', { caseStatus: result?.state ?? 'unknown' })
    return super.onTestCaseResult?.(test)
  }

  onTestModuleEnd(module) {
    const file = this.fileFor(module)
    if (file) this.completedFiles.add(file)
    this.active.file = file
    this.active.testCase = null
    this.active.hook = null
    this.lastCompletedOperation = 'file-completed'
    this.progress('file-completed')
    return super.onTestModuleEnd?.(module)
  }

  async onTestRunEnd(modules, unhandledErrors, reason) {
    for (const module of modules) {
      this.taskFiles.set(module.task.filepath, {
        task: module.task,
        errors: typeof module.errors === 'function' ? module.errors() : [],
      })
    }
    this.lastCompletedOperation = 'run-completed'
    this.progress('run-completed', { runReason: reason ?? 'unknown' })
    await super.onTestRunEnd(modules, unhandledErrors, reason)
  }

  async writeReport(json) {
    const report = JSON.parse(json)
    const tests = task => (task.type === 'test' ? [task] : (task.tasks ?? []).flatMap(tests))
    for (const file of report.testResults) {
      const reportPath = String(file.name).replaceAll('\\', '/')
      const saved =
        this.taskFiles.get(file.name) ??
        [...this.taskFiles.values()].find(({ task }) => {
          const moduleId = String(task.moduleId ?? '').replaceAll('\\', '/')
          const relativeModuleId = String(task.relativeModuleId ?? '').replaceAll('\\', '/')
          return (
            (moduleId && (reportPath === moduleId || reportPath.endsWith(`/${moduleId}`))) ||
            (relativeModuleId &&
              (reportPath === relativeModuleId || reportPath.endsWith(`/${relativeModuleId}`)))
          )
        })
      if (!saved) throw new Error('Diagnostic file provenance mismatch')
      const { task, errors } = saved
      const cases = tests(task)
      if (cases.length !== file.assertionResults.length) {
        throw new Error(
          `Diagnostic assertion inventory mismatch for ${path.basename(file.name)}: ${cases.length} tasks, ${file.assertionResults.length} assertions`
        )
      }
      file.diagnosticErrors = this.diagnosticErrors(task, 'collection', errors)
      for (const [index, assertion] of file.assertionResults.entries()) {
        const test = cases[index]
        if (test && test.name !== assertion.title)
          throw new Error('Diagnostic case provenance mismatch')
        if (!test) continue
        assertion.diagnosticErrors = this.diagnosticErrors(test, 'test')
      }
    }
    return super.writeReport(JSON.stringify(report))
  }
}
