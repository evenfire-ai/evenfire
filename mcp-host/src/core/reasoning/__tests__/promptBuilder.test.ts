import { describe, expect, it } from 'vitest'
import { ToolDefinition } from '../../types'
import {
  DefaultPromptBuilder,
  GFS_WORKSPACE_FILE_GUIDANCE_TEXT,
  MEMORY_GUIDANCE_TEXT,
} from '../promptBuilder'

function tool(name: string): ToolDefinition {
  return { name, description: `mock ${name}`, parameters: {} }
}

describe('DefaultPromptBuilder — memory guidance (P.4)', () => {
  it('includes MEMORY_GUIDANCE_TEXT when a memory_* tool is registered', () => {
    const builder = new DefaultPromptBuilder()
    const msg = builder.buildSystemPrompt([tool('memory_write'), tool('memory_search')])
    expect(msg.content).toContain(MEMORY_GUIDANCE_TEXT)
    expect(msg.content).toContain('two scopes')
    expect(msg.content).toContain('size cap (8 KB)')
  })

  it('omits the guidance when no memory tools are present', () => {
    const builder = new DefaultPromptBuilder()
    const msg = builder.buildSystemPrompt([tool('clerum__get_capabilities')])
    expect(msg.content).not.toContain(MEMORY_GUIDANCE_TEXT)
    expect(msg.content).not.toContain('two scopes')
  })

  it('emits the guidance block exactly once even with multiple memory tools', () => {
    const builder = new DefaultPromptBuilder()
    const msg = builder.buildSystemPrompt([
      tool('memory_write'),
      tool('memory_read'),
      tool('memory_search'),
      tool('memory_tree'),
    ])
    const occurrences = msg.content.split(MEMORY_GUIDANCE_TEXT).length - 1
    expect(occurrences).toBe(1)
  })
})

describe('DefaultPromptBuilder — governed GFS workspace files', () => {
  it('includes the guidance when the explicit download tool is registered', () => {
    const builder = new DefaultPromptBuilder()
    const msg = builder.buildSystemPrompt([tool('clerum__gfs_download')])
    expect(msg.content).toContain(GFS_WORKSPACE_FILE_GUIDANCE_TEXT)
    expect(msg.content).toContain('never invent a resourceId')
    expect(msg.content).toContain('call `clerum__gfs_download` and use the exact `path`')
    expect(msg.content).toContain('never guess a `.gfs-downloads/<filename>` path')
    expect(msg.content).toContain('write outputs outside `.gfs-downloads`')
  })

  it('omits the guidance when workspace download is unavailable', () => {
    const builder = new DefaultPromptBuilder()
    const msg = builder.buildSystemPrompt([tool('clerum__gfs_read')])
    expect(msg.content).not.toContain(GFS_WORKSPACE_FILE_GUIDANCE_TEXT)
  })
})
