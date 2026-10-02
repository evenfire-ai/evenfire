import { expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { GfsProcessingLeaseProvider } from '../../../internalTools/gfsProcessingLease'
import type { ExecutionContext } from '../../interfaces'
import { ShellTool } from '../shell'

function executionContext(chunks: string[]): ExecutionContext {
  return {
    onOutput(chunk: string): void {
      chunks.push(chunk)
    },
  }
}

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

it('does not spawn when processing lease acquisition fails', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-lease-denied-'))
  const marker = path.join(workspace, 'started')
  const leases: GfsProcessingLeaseProvider = {
    acquireProcessingLease: async () => {
      throw new Error('download expired')
    },
    releaseProcessingLease: async () => undefined,
  }
  const tool = new ShellTool(workspace, 5_000, ['PATH'], () => ({}), undefined, leases)

  try {
    const result = await tool.execute({ command: `touch ${JSON.stringify(marker)}` })
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('download expired')
    expect(fs.existsSync(marker)).toBe(false)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

it('releases the processing lease after command completion', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-lease-release-'))
  const events: string[] = []
  const leases: GfsProcessingLeaseProvider = {
    acquireProcessingLease: async () => {
      events.push('acquire')
      return { leaseId: 'lease-1', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    },
    releaseProcessingLease: async () => {
      events.push('release')
    },
  }
  const tool = new ShellTool(workspace, 5_000, ['PATH'], () => ({}), undefined, leases)

  try {
    const result = await tool.execute({ command: 'printf done' })
    expect(result.is_error).toBe(false)
    expect(events).toEqual(['acquire', 'release'])
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

it('does not report success when processing lease release fails', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-lease-failed-release-'))
  const leases: GfsProcessingLeaseProvider = {
    acquireProcessingLease: async () => ({
      leaseId: 'lease-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    releaseProcessingLease: async () => {
      throw new Error('lease ledger locked')
    },
  }
  const tool = new ShellTool(workspace, 5_000, ['PATH'], () => ({}), undefined, leases)

  try {
    const result = await tool.execute({ command: 'printf done' })
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('processing_lease_release_failed')
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

it('releases the processing lease only after process-group termination', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-group-lease-'))
  const marker = path.join(workspace, 'group-settled')
  const script = path.join(workspace, 'spawn-group-child.js')
  const releaseSawSettledMarker: boolean[] = []
  fs.writeFileSync(
    script,
    `const cp = require('child_process')\n` +
      `cp.spawn(process.execPath, ['-e', ${JSON.stringify(
        `require('fs').writeFileSync(${JSON.stringify(marker)}, 'yes'); setInterval(() => {}, 1000)`
      )}], { stdio: 'ignore' })\n` +
      `const timer = setInterval(() => {\n` +
      `  if (require('fs').existsSync(${JSON.stringify(marker)})) { clearInterval(timer); process.exit(0) }\n` +
      `}, 5)\n`,
    'utf8'
  )
  const leases: GfsProcessingLeaseProvider = {
    acquireProcessingLease: async () => ({
      leaseId: 'lease-group',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    releaseProcessingLease: async () => {
      releaseSawSettledMarker.push(fs.existsSync(marker))
    },
  }
  const tool = new ShellTool(workspace, 5_000, ['PATH'], () => ({}), undefined, leases)

  try {
    const result = await tool.execute({ command: `node ${JSON.stringify(script)}` })
    expect(result.is_error).toBe(false)
    expect(result.content).not.toContain('process_group_termination_failed')
    expect(fs.readFileSync(marker, 'utf8')).toBe('yes')
    expect(releaseSawSettledMarker).toEqual([true])
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
