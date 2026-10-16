// A chat call to an internal tool passes the same schema check as a workflow
// step before it runs: a call the schema rejects is answered with the reason
// and creates no folder, file or attachment (SEC-002).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { workflowValidation } from '../../../workflow/__tests__/support/workflowRouter'
import { INTERNAL_TOOLS } from '../../../workflow/internalTools'
import { CALLER_OUTPUTS_DIR } from '../../../workspace/callerOutputs'
import { resolveCallerRootBinding } from '../../../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../../../workspace/scopedWorkspace'
import { NativeToolRegistry } from '../nativeToolRegistry'

// The volume reads as roomy, so the free-space floor never decides these cases.
vi.mock('fs', async original => {
  const actual = await original<typeof import('fs')>()
  return {
    ...actual,
    statfsSync: (target: string, options: { bigint: true }) => {
      const reading = actual.statfsSync(target, options)
      return { ...reading, blocks: reading.bavail, bfree: reading.bavail }
    },
  }
})

const SHEETS = [{ name: 'S', rows: [['a'], [1]] }]

describe('chat internal-tool arguments are checked before the tool runs', () => {
  let hostBase: string
  let provider: ScopedWorkspaceProvider
  let shared: string
  const originalOutputDir = process.env.CLERUM_OUTPUT_DIR

  beforeEach(() => {
    hostBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-chat-args-')))
    provider = new ScopedWorkspaceProvider(hostBase)
    // The host's shared folder; chat files never go there.
    shared = path.join(hostBase, 'outputs')
    fs.mkdirSync(shared)
    process.env.CLERUM_OUTPUT_DIR = shared
  })

  afterEach(() => {
    if (originalOutputDir === undefined) delete process.env.CLERUM_OUTPUT_DIR
    else process.env.CLERUM_OUTPUT_DIR = originalOutputDir
    fs.rmSync(hostBase, { recursive: true, force: true })
  })

  function callerRoot(): string {
    const binding = resolveCallerRootBinding(provider, { sender: 'user-a', channelType: 'rpc' })
    if (!binding.root) throw new Error(`no caller root: ${binding.failureCode}`)
    return binding.root
  }

  function chat(root: string, name: string, args: Record<string, unknown>) {
    const registry = new NativeToolRegistry(
      {
        workspacePath: hostBase,
        shellTimeout: 5000,
        toolTimeout: 60000,
        toolProgressInterval: 30000,
        httpAllowlist: [],
        envAllowlist: ['PATH'],
        memoryMaxSize: 1048576,
      },
      'conv-1',
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      { maxBytes: 52_428_800 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      root
    )
    return registry.get(name)!.execute(args)
  }

  const tool = (name: string) => INTERNAL_TOOLS.find(t => t.name === name)!

  it('rejects a filename that is not a string, as a workflow step does, and writes nothing', async () => {
    const root = callerRoot()
    const args = { filename: 123, sheets: SHEETS }
    const result = await chat(root, 'clerum__generate_xlsx', args)

    expect(result.is_error).toBe(true)
    expect(result.content).toBe('Error: Invalid arguments: data/filename must be string')
    expect(result.attachments).toBeUndefined()
    expect(fs.existsSync(path.join(root, CALLER_OUTPUTS_DIR))).toBe(false)
    expect(fs.readdirSync(shared)).toEqual([])
    // The same arguments, the same answer on the workflow path.
    expect(await workflowValidation(tool('clerum__generate_xlsx'), args)).toBe(
      'Invalid arguments: data/filename must be string'
    )
  })

  it('rejects a missing required field and a value outside an enum before running', async () => {
    const root = callerRoot()
    const missing = await chat(root, 'clerum__generate_xlsx', { filename: 'a.xlsx' })
    expect(missing.content).toBe(
      "Error: Invalid arguments: data must have required property 'sheets'"
    )
    const offEnum = await chat(root, 'clerum__generate_pdf', {
      filename: 'a.pdf',
      body: 'x',
      palette: 'neon',
    })
    expect(offEnum.is_error).toBe(true)
    expect(offEnum.content).toMatch(
      /^Error: Invalid arguments: data\/palette must be equal to one of the allowed values/
    )
    expect(fs.existsSync(path.join(root, CALLER_OUTPUTS_DIR))).toBe(false)
  })

  it('names a few problems of a call that breaks many fields, not all of them', async () => {
    const root = callerRoot()
    const sheets = Array.from({ length: 40 }, () => ({ name: 7, rows: 'none' }))
    const result = await chat(root, 'clerum__generate_xlsx', { filename: 'a.xlsx', sheets })
    expect(result.is_error).toBe(true)
    expect(result.content).toMatch(/; and \d+ more$/)
    expect(result.content.length).toBeLessThanOrEqual('Error: Invalid arguments: '.length + 1_001)
  })

  it('still makes and delivers the file of a valid call from the caller folder', async () => {
    const root = callerRoot()
    // A null for an unset optional argument is still read as unset.
    const result = await chat(root, 'clerum__generate_xlsx', {
      filename: 'ok.xlsx',
      sheets: SHEETS,
      branding: null,
    })
    expect(result.is_error, result.content).toBe(false)
    expect(fs.readdirSync(path.join(root, CALLER_OUTPUTS_DIR))).toEqual(['ok.xlsx'])
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments![0]).toMatchObject({ sourceTool: 'clerum__generate_xlsx' })
    expect(
      await workflowValidation(tool('clerum__generate_xlsx'), {
        filename: 'ok.xlsx',
        sheets: SHEETS,
      })
    ).toBe(true)
  })
})
