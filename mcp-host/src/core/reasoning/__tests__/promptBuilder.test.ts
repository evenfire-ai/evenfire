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

  it('places named notes under memory/ and team knowledge in the collective memory (D77, D79, D92)', () => {
    expect(MEMORY_GUIDANCE_TEXT).toContain('must live under memory/')
    expect(MEMORY_GUIDANCE_TEXT).toContain('memory/preferences.md')
    expect(MEMORY_GUIDANCE_TEXT).toContain('goes to the collective memory')
    expect(MEMORY_GUIDANCE_TEXT).toContain('are not memory')
    expect(MEMORY_GUIDANCE_TEXT).toContain('size cap (8 KB)')
    expect(MEMORY_GUIDANCE_TEXT).not.toContain('team-conventions')
    expect(MEMORY_GUIDANCE_TEXT).not.toContain('ledger.md')
    expect(MEMORY_GUIDANCE_TEXT).not.toMatch(/keep[^.]*ledger/i)
  })

  it('says memory is in one place and is read only through the memory tools (D83, D91)', () => {
    expect(MEMORY_GUIDANCE_TEXT).toContain('Memory is in one place')
    expect(MEMORY_GUIDANCE_TEXT).toContain(
      'never by browsing other workspace files with file_read or the shell'
    )
    expect(MEMORY_GUIDANCE_TEXT).toContain('a workspace file is not memory')
    for (const place of ['MEMORY.md', 'memories/', 'daily/', 'memory/']) {
      expect(MEMORY_GUIDANCE_TEXT).toContain(place)
    }
  })

  it('tells how a private MEMORY.md and a shared note name a kept file (V2-L7)', () => {
    expect(MEMORY_GUIDANCE_TEXT).toContain('their private MEMORY.md names a file to keep')
    expect(MEMORY_GUIDANCE_TEXT).toContain('A shared note names no memory/ path')
  })
})

describe('DefaultPromptBuilder — governed GFS workspace files', () => {
  it('includes the guidance when the explicit download tool is registered', () => {
    const builder = new DefaultPromptBuilder({ nativeToolPresentation: 'direct' })
    const msg = builder.buildSystemPrompt([tool('clerum__gfs_download')])
    expect(msg.content).toContain(GFS_WORKSPACE_FILE_GUIDANCE_TEXT)
    expect(msg.content).toContain('never invent a resourceId')
    expect(msg.content).toContain('call `clerum__gfs_download` and use the exact `path`')
    expect(msg.content).toContain('never guess a `.gfs-downloads/<filename>` path')
    expect(msg.content).toContain('copy the complete parsed header array verbatim')
    expect(msg.content).toContain('write outputs outside `.gfs-downloads`')
  })

  it('omits the guidance when workspace download is unavailable', () => {
    const builder = new DefaultPromptBuilder({ nativeToolPresentation: 'direct' })
    const msg = builder.buildSystemPrompt([tool('clerum__gfs_read')])
    expect(msg.content).not.toContain(GFS_WORKSPACE_FILE_GUIDANCE_TEXT)
  })
})
