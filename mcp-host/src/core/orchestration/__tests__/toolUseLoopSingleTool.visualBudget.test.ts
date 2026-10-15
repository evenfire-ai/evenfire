import { describe, expect, it, vi } from 'vitest'
import type { Tool, ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import { DefaultToolOutputProcessor } from '../../safety/toolOutputProcessor'
import type { Attachment, ToolResult } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import type { LoopConfig } from '../loopConfig'
import { executeSingleTool } from '../toolUseLoopSingleTool'

const safety = new BasicSafety()

function imageAttachment(id: string, data: string): Attachment {
  return {
    id,
    kind: 'image',
    mimeType: 'image/png',
    encoding: 'base64',
    dataBase64: data,
    sourceTool: 'visual_fixture',
  }
}

function toolWithFinalizer(
  finalize: (result: ToolResult) => ToolResult,
  attachments: Attachment[]
): Tool {
  return {
    name: () => 'visual_fixture',
    description: () => 'Fixture for the final visual-budget charge',
    parametersSchema: () => ({ type: 'object', properties: {} }),
    requiresSanitization: () => false,
    requiresApproval: () => false,
    execute: async () => ({
      content: 'visual fixture',
      duration_ms: 1,
      is_error: false,
      attachments,
    }),
    finalizeResult: finalize,
  }
}

async function run(tool: Tool, callId: string, observeExternalImage: ReturnType<typeof vi.fn>) {
  const registry: ToolRegistry = {
    get: (name: string) => (name === tool.name() ? tool : null),
    listDefinitions: () => [],
    register: () => undefined,
  }
  const events = new SimpleEventEmitter()

  return executeSingleTool(
    { id: callId, name: tool.name(), arguments: {} },
    {
      toolRegistry: registry,
      toolOutputProcessor: new DefaultToolOutputProcessor(safety),
      safety,
      events,
      toolTimeout: 1_000,
      toolProgressInterval: 0,
      measureToolMessage: () => 1,
      visualInput: {
        budget: { observeExternalImage },
      } as unknown as LoopConfig['visualInput'],
    }
  )
}

describe('executeSingleTool visual-budget charge', () => {
  it('charges images that finalizeResult retains', async () => {
    const observeExternalImage = vi.fn()
    const image = imageAttachment('kept', 'kept-image')
    const tool = toolWithFinalizer(result => result, [image])

    const result = await run(tool, 'kept-call', observeExternalImage)

    expect(result.attachments).toEqual([image])
    expect(observeExternalImage).toHaveBeenCalledTimes(1)
    expect(observeExternalImage).toHaveBeenCalledWith('kept-image')
  })

  it('does not charge images that finalizeResult drops, with a retained image as witness', async () => {
    const observeExternalImage = vi.fn()
    const dropped = imageAttachment('dropped', 'dropped-image')
    const retained = imageAttachment('retained', 'retained-image')
    const tool = toolWithFinalizer(
      result => ({ ...result, attachments: [retained] }),
      [dropped, retained]
    )

    const result = await run(tool, 'fenced-call', observeExternalImage)

    expect(result.attachments).toEqual([retained])
    expect(observeExternalImage).toHaveBeenCalledTimes(1)
    expect(observeExternalImage).toHaveBeenCalledWith('retained-image')
    expect(observeExternalImage).not.toHaveBeenCalledWith('dropped-image')
  })
})
