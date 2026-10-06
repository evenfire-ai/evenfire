import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_TOOL_NAMES } from '../../../capabilities/toolCatalogTools'
import { logger } from '../../../logger'
import type { LoopController } from '../../interfaces'
import type { ToolDefinition } from '../../types'
import { NativeToolPresentationController } from '../nativeToolPresentationController'

const tool = (name: string, size = 10): ToolDefinition => ({
  name,
  description: 'd'.repeat(size),
  parameters: { type: 'object' },
})
const BRIDGE = [...BRIDGE_TOOL_NAMES].map(name => tool(name))
const BIG = tool('clerum__generate_pptx', 3000)
const SMALL = tool('shell_exec')
const MCP_BIG = tool('alpha__huge', 5000)
const nativeNames = new Set([BIG.name, SMALL.name, ...BRIDGE.map(t => t.name)])

function delegateReturning(list: ToolDefinition[]) {
  const refreshTools = vi.fn(async () => list)
  const delegate: LoopController = {
    shouldAccept: vi.fn(() => true),
    onTextRejected: vi.fn(() => null),
    beforeTool: vi.fn(() => 'proceed' as const),
    onExhaustion: vi.fn(() => 'exhausted'),
    refreshTools,
  }
  return { delegate, refreshTools }
}

afterEach(() => vi.restoreAllMocks())

describe('NativeToolPresentationController', () => {
  it('direct is identity: returns the upstream list object unchanged', async () => {
    const upstream = [BIG, SMALL, MCP_BIG]
    const { delegate, refreshTools } = delegateReturning(upstream)
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const controller = new NativeToolPresentationController(delegate, nativeNames, {
      mode: 'direct',
      discoveryBytes: 2048,
    })
    expect(await controller.refreshTools([SMALL])).toBe(upstream)
    // Witness: the delegate decided the list from the caller's input.
    expect(refreshTools).toHaveBeenCalledWith([SMALL])
    expect(info).not.toHaveBeenCalled()
  })

  it('auto hides only oversized natives and never touches MCP tools', async () => {
    const { delegate } = delegateReturning([BIG, SMALL, MCP_BIG, ...BRIDGE])
    vi.spyOn(logger, 'info').mockImplementation(() => {})
    const controller = new NativeToolPresentationController(delegate, nativeNames, {
      mode: 'auto',
      discoveryBytes: 2048,
    })
    expect((await controller.refreshTools([])).map(t => t.name)).toEqual([
      SMALL.name,
      MCP_BIG.name,
      ...BRIDGE.map(t => t.name),
    ])
  })

  it('auto throws instead of hiding a native while a bridge tool is missing', async () => {
    for (const missing of BRIDGE_TOOL_NAMES) {
      const { delegate } = delegateReturning([
        BIG,
        SMALL,
        ...BRIDGE.filter(t => t.name !== missing),
      ])
      const controller = new NativeToolPresentationController(delegate, nativeNames, {
        mode: 'auto',
        discoveryBytes: 2048,
      })
      await expect(controller.refreshTools([])).rejects.toThrow(
        `Native tool discovery cannot hide clerum__generate_pptx: bridge tools ${missing} are not presented`
      )
    }
    // Witness: the same list with every bridge tool hides the generator.
    vi.spyOn(logger, 'info').mockImplementation(() => {})
    const { delegate } = delegateReturning([BIG, SMALL, ...BRIDGE])
    const controller = new NativeToolPresentationController(delegate, nativeNames, {
      mode: 'auto',
      discoveryBytes: 2048,
    })
    expect((await controller.refreshTools([])).map(t => t.name)).not.toContain(BIG.name)
  })

  it('auto without anything to hide does not need the bridge', async () => {
    const { delegate } = delegateReturning([SMALL, MCP_BIG])
    vi.spyOn(logger, 'info').mockImplementation(() => {})
    const controller = new NativeToolPresentationController(delegate, nativeNames, {
      mode: 'auto',
      discoveryBytes: 2048,
    })
    expect((await controller.refreshTools([])).map(t => t.name)).toEqual([SMALL.name, MCP_BIG.name])
  })

  it('logs the native presentation once per change', async () => {
    const list = [BIG, SMALL, ...BRIDGE]
    const { delegate, refreshTools } = delegateReturning(list)
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const controller = new NativeToolPresentationController(delegate, nativeNames, {
      mode: 'auto',
      discoveryBytes: 2048,
    })
    await controller.refreshTools([])
    await controller.refreshTools([])
    refreshTools.mockResolvedValueOnce([SMALL, ...BRIDGE])
    await controller.refreshTools([])
    expect(refreshTools).toHaveBeenCalledTimes(3)
    expect(info.mock.calls.map(call => call[0])).toEqual([
      {
        component: 'native-tool-presentation',
        mode: 'auto',
        budget: 2048,
        hiddenNames: [BIG.name],
        presentedCount: list.length - 1,
      },
      {
        component: 'native-tool-presentation',
        mode: 'auto',
        budget: 2048,
        hiddenNames: [],
        presentedCount: 1 + BRIDGE.length,
      },
    ])
  })

  it('passes every other hook through to the delegate', () => {
    const { delegate } = delegateReturning([])
    const controller = new NativeToolPresentationController(delegate, nativeNames, {
      mode: 'auto',
      discoveryBytes: 2048,
    })
    expect(controller.shouldAccept('text', 1)).toBe(true)
    expect(controller.onTextRejected('text', 1)).toBeNull()
    expect(controller.beforeTool('shell_exec', { command: 'ls' })).toBe('proceed')
    expect(controller.onExhaustion(3)).toBe('exhausted')
    expect(delegate.shouldAccept).toHaveBeenCalledWith('text', 1)
    expect(delegate.onTextRejected).toHaveBeenCalledWith('text', 1)
    expect(delegate.beforeTool).toHaveBeenCalledWith('shell_exec', { command: 'ls' })
    expect(delegate.onExhaustion).toHaveBeenCalledWith(3)
  })
})
