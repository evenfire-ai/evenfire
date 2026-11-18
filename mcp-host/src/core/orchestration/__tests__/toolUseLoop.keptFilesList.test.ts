// The kept-files listing reaches the model whole: its output never goes to
// spillover storage, so no file name of one user rests in the Host's shared
// spillover folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { CALLER_OUTPUTS_DIR } from '../../../workspace/callerOutputs'
import { resolveCallerRootBinding } from '../../../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../../../workspace/scopedWorkspace'
import type { Tool } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import { DefaultToolOutputProcessor } from '../../safety/toolOutputProcessor'
import { SpilloverStorage } from '../../spillover'
import { NativeToolRegistry } from '../../tools/nativeToolRegistry'
import type { ToolOutput } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import { executeSingleTool } from '../toolUseLoop'

const ACCESS_ENV = `MCP_HOST_GFS_${String.fromCharCode(84, 79, 75, 69, 78)}`
const previousAccess = process.env[ACCESS_ENV]
const THRESHOLD = 8_192

let hostBase: string
let callerRoot: string
let storage: SpilloverStorage

beforeEach(() => {
  hostBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-kept-list-spill-')))
  const binding = resolveCallerRootBinding(new ScopedWorkspaceProvider(hostBase), {
    sender: 'user-a',
    channelType: 'rpc',
  })
  callerRoot = binding.root!
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ scopes: ['gfs.read', 'gfs.write'] })).toString(
    'base64url'
  )
  process.env[ACCESS_ENV] = `${header}.${body}.sig`
  storage = new SpilloverStorage({
    workspacePath: hostBase,
    thresholdBytes: THRESHOLD,
    ttlMs: 60_000,
    gcIntervalMs: 0,
  })
})

afterEach(() => {
  storage.stopGc()
  if (previousAccess === undefined) delete process.env[ACCESS_ENV]
  else process.env[ACCESS_ENV] = previousAccess
  fs.rmSync(hostBase, { recursive: true, force: true })
})

function registry(): NativeToolRegistry {
  return new NativeToolRegistry(
    {
      workspacePath: hostBase,
      shellTimeout: 5000,
      toolTimeout: 60000,
      toolProgressInterval: 30000,
      httpAllowlist: [],
      envAllowlist: ['PATH'],
      memoryMaxSize: 1048576,
    },
    'conv-spill',
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
    { root: callerRoot, room: async () => Number.MAX_SAFE_INTEGER }
  )
}

function loopConfig(tools: Pick<NativeToolRegistry, 'get' | 'listDefinitions' | 'register'>) {
  const safety = new BasicSafety()
  return {
    toolRegistry: tools,
    toolOutputProcessor: new DefaultToolOutputProcessor(safety),
    safety,
    events: new SimpleEventEmitter(),
    toolTimeout: 10_000,
    progressReporter: undefined,
    toolProgressInterval: 0,
    spilloverStorage: storage,
    taskId: 'task-list',
  }
}

describe('clerum__kept_files_list and spillover', () => {
  it('declares itself exempt, and the write tools and generators do not', () => {
    const tools = registry()
    expect(tools.get('clerum__kept_files_list')!.spilloverExempt?.()).toBe(true)
    expect(tools.get('clerum__gfs_write')!.spilloverExempt?.()).toBe(false)
    expect(tools.get('clerum__generate_markdown')!.spilloverExempt?.()).toBe(false)
  })

  it('ships a listing of 100 files inline while the same payload from another tool spills', async () => {
    const out = path.join(callerRoot, CALLER_OUTPUTS_DIR)
    fs.mkdirSync(out, { mode: 0o700 })
    for (let n = 0; n < 100; n++) {
      fs.writeFileSync(
        path.join(out, `quarterly-revenue-report-region-${String(n).padStart(3, '0')}.md`),
        `# ${n}\n`
      )
    }
    const tools = registry()
    const direct = await tools.get('clerum__kept_files_list')!.execute({})
    expect(Buffer.byteLength(direct.content)).toBeGreaterThan(THRESHOLD)

    const result = await executeSingleTool(
      { id: 'call-list', name: 'clerum__kept_files_list', arguments: {} },
      loopConfig(tools)
    )
    expect(result.spillover_ref).toBeUndefined()
    const listed = JSON.parse(result.content) as { files: unknown[]; truncated: boolean }
    expect(listed.files).toHaveLength(100)
    expect(listed.truncated).toBe(false)
    expect(fs.existsSync(path.join(hostBase, 'spillover', 'task-list', 'call-list.json'))).toBe(
      false
    )

    // Witness: the same payload from a tool without the declaration is spilled.
    const plain: Tool = {
      name: () => 'clerum__other_internal',
      description: () => 'other',
      parametersSchema: () => ({ type: 'object', properties: {} }),
      requiresSanitization: () => false,
      requiresApproval: () => false,
      execute: vi.fn(async (): Promise<ToolOutput> => ({ ...direct })),
    }
    const control = await executeSingleTool(
      { id: 'call-other', name: 'clerum__other_internal', arguments: {} },
      loopConfig({
        get: name => (name === 'clerum__other_internal' ? plain : null),
        listDefinitions: () => [],
        register: vi.fn(),
      })
    )
    expect(control.spillover_ref).toBe('spillover://task-list/call-other.json')
    expect(fs.existsSync(path.join(hostBase, 'spillover', 'task-list', 'call-other.json'))).toBe(
      true
    )
  })
})
