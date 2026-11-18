import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { ToolDefinition } from '../../types'
import {
  DefaultPromptBuilder,
  MEMORY_GUIDANCE_TEXT,
  gfsWorkspaceFileGuidanceText,
} from '../promptBuilder'

// The workspace-file guidance as it was emitted before it followed the write
// tools: with the edit and save tools registered it must stay byte for byte.
const PREVIOUS_FULL_GUIDANCE = {
  length: 3198,
  sha256: 'e8bdb309daefbcd4115bfc2aab8f60bdc02d7ab2695bd91d4e2747aa114659ad',
}
const READ_ONLY = { editText: false, saveBySourcePath: false }
const WRITE_TOOL_NAMES = ['clerum__gfs_edit_text', 'clerum__gfs_write', 'clerum__gfs_create_file']

function tool(name: string): ToolDefinition {
  return { name, description: `mock ${name}`, parameters: {} }
}

describe('DefaultPromptBuilder — memory guidance (P.4)', () => {
  it('includes MEMORY_GUIDANCE_TEXT when a memory_* tool is registered', () => {
    const builder = new DefaultPromptBuilder({ nativeToolPresentation: 'direct' })
    const msg = builder.buildSystemPrompt([tool('memory_write'), tool('memory_search')])
    expect(msg.content).toContain(MEMORY_GUIDANCE_TEXT)
    expect(msg.content).toContain('two scopes')
    expect(msg.content).toContain('size cap (8 KB)')
  })

  it('omits the guidance when no memory tools are present', () => {
    const builder = new DefaultPromptBuilder({ nativeToolPresentation: 'direct' })
    const msg = builder.buildSystemPrompt([tool('clerum__get_capabilities')])
    expect(msg.content).not.toContain(MEMORY_GUIDANCE_TEXT)
    expect(msg.content).not.toContain('two scopes')
  })

  it('emits the guidance block exactly once even with multiple memory tools', () => {
    const builder = new DefaultPromptBuilder({ nativeToolPresentation: 'direct' })
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
    const builder = new DefaultPromptBuilder({ nativeToolPresentation: 'direct' })
    const msg = builder.buildSystemPrompt([tool('clerum__gfs_download')])
    expect(msg.content).toContain(gfsWorkspaceFileGuidanceText(READ_ONLY))
    expect(msg.content).toContain('never invent a resourceId')
    expect(msg.content).toContain('call `clerum__gfs_download` and use the exact `path`')
    expect(msg.content).toContain('never guess a `.gfs-downloads/<filename>` path')
    expect(msg.content).toContain('copy the complete parsed header array verbatim')
    expect(msg.content).toContain('write outputs outside `.gfs-downloads`')
  })

  it('omits the guidance when workspace download is unavailable', () => {
    const builder = new DefaultPromptBuilder({ nativeToolPresentation: 'direct' })
    const msg = builder.buildSystemPrompt([tool('clerum__gfs_read')])
    expect(msg.content).not.toContain('GFS WORKSPACE FILES')
  })

  it('names no write tool when the download is the only GFS tool', () => {
    const builder = new DefaultPromptBuilder({ nativeToolPresentation: 'direct' })
    const msg = builder.buildSystemPrompt([tool('clerum__gfs_download')])
    // Witness: the section itself is there.
    expect(msg.content).toContain('GFS WORKSPACE FILES')
    for (const name of [...WRITE_TOOL_NAMES, 'sourcePath']) expect(msg.content).not.toContain(name)
  })

  it('keeps the previous text byte for byte with the edit and save tools', () => {
    const builder = new DefaultPromptBuilder({ nativeToolPresentation: 'direct' })
    const msg = builder.buildSystemPrompt([
      tool('clerum__gfs_download'),
      ...WRITE_TOOL_NAMES.map(tool),
    ])
    const full = gfsWorkspaceFileGuidanceText({ editText: true, saveBySourcePath: true })
    expect(msg.content).toContain(full)
    expect(full).toHaveLength(PREVIOUS_FULL_GUIDANCE.length)
    expect(createHash('sha256').update(full, 'utf8').digest('hex')).toBe(
      PREVIOUS_FULL_GUIDANCE.sha256
    )
  })

  it('adds the edit sentence only with the edit tool and the save sentences only with the save tool', () => {
    const builder = new DefaultPromptBuilder({ nativeToolPresentation: 'direct' })
    const saveOnly = builder.buildSystemPrompt([
      tool('clerum__gfs_download'),
      tool('clerum__gfs_write'),
      tool('clerum__gfs_create_file'),
    ]).content
    expect(saveOnly).toContain('clerum__gfs_write with sourcePath')
    expect(saveOnly).not.toContain('clerum__gfs_edit_text')
    const editOnly = builder.buildSystemPrompt([
      tool('clerum__gfs_download'),
      tool('clerum__gfs_edit_text'),
    ]).content
    expect(editOnly).toContain('use clerum__gfs_edit_text')
    expect(editOnly).not.toContain('sourcePath')
  })
})
