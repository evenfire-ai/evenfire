import path from 'node:path'
import { pathToFileURL } from 'node:url'

const desktopRoot = process.env.PR977_DESKTOP_ROOT
if (!desktopRoot || !path.isAbsolute(desktopRoot)) {
  throw new Error('The diagnostic reporter requires the exact Desktop checkout root')
}
const { JsonReporter } = await import(
  pathToFileURL(path.join(desktopRoot, 'node_modules/vitest/dist/reporters.js')).href
)

// Keep Vitest's counters, statuses and file inventory intact. Its JSON reporter uses
// error.stack OR error.message, losing the timeout message when the stack is STACK_TRACE_ERROR.
export default class WindowsDiagnosticReporter extends JsonReporter {
  taskFiles = new Map()

  diagnosticErrors(task, fallbackPhase) {
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
    return (task.result?.errors ?? []).map(error => ({
      message: error.message,
      stack: error.stack,
      phase,
      failedHooks,
    }))
  }

  async onTestRunEnd(modules) {
    for (const module of modules) this.taskFiles.set(module.task.filepath, module.task)
    return super.onTestRunEnd(modules)
  }

  async writeReport(json) {
    const report = JSON.parse(json)
    const tests = task => (task.type === 'test' ? [task] : (task.tasks ?? []).flatMap(tests))
    for (const file of report.testResults) {
      const task = this.taskFiles.get(file.name)
      if (!task) throw new Error('Diagnostic file provenance mismatch')
      const cases = tests(task)
      if (cases.length !== file.assertionResults.length) {
        throw new Error('Diagnostic assertion inventory mismatch')
      }
      file.diagnosticErrors = this.diagnosticErrors(task, 'collection')
      for (const [index, assertion] of file.assertionResults.entries()) {
        const test = cases[index]
        if (test.name !== assertion.title) throw new Error('Diagnostic case provenance mismatch')
        assertion.diagnosticErrors = this.diagnosticErrors(test, 'test')
      }
    }
    return super.writeReport(JSON.stringify(report))
  }
}
