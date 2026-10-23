import { afterEach, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExecutionContext } from '../../interfaces'
import { ShellTool } from '../shell'

function executionContext(chunks: string[]): ExecutionContext {
  return {
    onOutput(chunk: string): void {
      chunks.push(chunk)
    },
  }
}

const managedHosts: string[] = []

function managedWorkspace(prefix: string): string {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  managedHosts.push(host)
  const workspace = path.join(host, 'users', 'caller')
  fs.mkdirSync(workspace, { recursive: true })
  return workspace
}

afterEach(() => {
  for (const host of managedHosts.splice(0)) fs.rmSync(host, { recursive: true, force: true })
})

it('bounds retained shell output and live progress independently', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-output-bounds-'))
  const progress: string[] = []
  const tool = new ShellTool(workspace, 10_000, ['PATH'])

  try {
    const result = await tool.execute(
      {
        command: 'node -e "process.stdout.write(\'x\'.repeat(1536 * 1024))"',
      },
      executionContext(progress)
    )

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('output_limit_exceeded')
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(1024 * 1024)
    expect(Buffer.byteLength(progress.join(''), 'utf8')).toBeLessThanOrEqual(64 * 1024)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

it('resets HOME to the caller workspace after environment merging', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-home-boundary-'))
  const tool = new ShellTool(workspace, 5_000, ['PATH', 'HOME'], () => ({ HOME: '/tmp' }))

  try {
    const result = await tool.execute({ command: 'printf %s "$HOME"' })
    expect(result.is_error).toBe(false)
    expect(result.content).toBe(`stdout:\n${workspace}`)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

it('resolves only after the detached process group is terminated', async () => {
  const workspace = managedWorkspace('shell-group-settled-')
  const marker = path.join(workspace, 'grandchild-pid')
  const script = path.join(workspace, 'spawn-group-child.js')
  fs.writeFileSync(
    script,
    `const cp = require('child_process')\n` +
      `cp.spawn(process.execPath, ['-e', ${JSON.stringify(
        `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`
      )}], { stdio: 'ignore' })\n` +
      `const timer = setInterval(() => {\n` +
      `  if (require('fs').existsSync(${JSON.stringify(marker)})) { clearInterval(timer); process.exit(0) }\n` +
      `}, 5)\n`,
    'utf8'
  )
  const tool = new ShellTool(workspace, 5_000, ['PATH'], () => ({}), undefined, true)

  const result = await tool.execute({ command: `node ${JSON.stringify(script)}` })
  expect(result.is_error).toBe(false)
  expect(result.content).not.toContain('process_group_termination_failed')
  // Witness: the grandchild ran and recorded its pid before the leader exited.
  const grandchildPid = Number(fs.readFileSync(marker, 'utf8'))
  expect(Number.isSafeInteger(grandchildPid) && grandchildPid > 0).toBe(true)
  // The leader exiting does not end the group; the tool resolves only after
  // the long-lived grandchild has been killed.
  expect(() => process.kill(grandchildPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
})
