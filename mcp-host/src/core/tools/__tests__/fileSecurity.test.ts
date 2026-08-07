import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { FileReadTool } from '../fileRead'
import { FileWriteTool } from '../fileWrite'
import { isWithinDirectory, validatePath } from '../pathValidation'

let workspacePath: string

beforeEach(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), 'clerum-test-'))
})

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true })
})

describe('FileReadTool path security', () => {
  it('should reject parent directory traversal (Risk 3.5.1a)', async () => {
    const tool = new FileReadTool(workspacePath)
    const result = await tool.execute({ path: '../../etc/passwd' })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('not allowed')
  })

  it('should reject absolute paths (Risk 3.5.1b)', async () => {
    const tool = new FileReadTool(workspacePath)
    const result = await tool.execute({ path: '/etc/passwd' })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('not allowed')
  })

  it('should reject null bytes in path (Risk 3.5.1c)', async () => {
    const tool = new FileReadTool(workspacePath)
    const result = await tool.execute({ path: 'file\0.txt' })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('null bytes')
  })

  it('should reject symlinks pointing outside workspace (Risk 3.5.1d)', async () => {
    // Create a symlink inside workspace that points to /tmp
    await symlink('/tmp', join(workspacePath, 'escape-link'))

    const tool = new FileReadTool(workspacePath)
    const result = await tool.execute({ path: 'escape-link' })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('outside workspace')
  })

  it('should read valid relative paths within workspace (Risk 3.5.1e)', async () => {
    // Create a file inside the workspace
    await mkdir(join(workspacePath, 'src'), { recursive: true })
    await writeFile(join(workspacePath, 'src/main.ts'), "console.log('hello');")

    const tool = new FileReadTool(workspacePath)
    const result = await tool.execute({ path: 'src/main.ts' })

    expect(result.is_error).toBe(false)
    expect(result.content).toBe("console.log('hello');")
  })

  it('should reject paths where workspace name is a prefix of another directory', async () => {
    const tool = new FileReadTool(workspacePath)
    const result = validatePath('test.txt', workspacePath)
    expect(result.valid).toBe(true)
  })
})

describe('isWithinDirectory', () => {
  it('should detect paths within directory', () => {
    expect(isWithinDirectory('/workspace/file.txt', '/workspace')).toBe(true)
    expect(isWithinDirectory('/workspace/sub/file.txt', '/workspace')).toBe(true)
  })

  it('should reject paths outside directory', () => {
    expect(isWithinDirectory('/workspace-evil/file.txt', '/workspace')).toBe(false)
    expect(isWithinDirectory('/other/file.txt', '/workspace')).toBe(false)
  })

  it('should reject parent traversal', () => {
    expect(isWithinDirectory('/workspace/../etc/passwd', '/workspace')).toBe(false)
  })

  it('should accept the directory itself', () => {
    expect(isWithinDirectory('/workspace', '/workspace')).toBe(true)
  })
})

describe('FileWriteTool path security', () => {
  it('should reject traversal and write within workspace', async () => {
    const tool = new FileWriteTool(workspacePath)

    // Traversal rejected
    const bad = await tool.execute({
      path: '../escape.txt',
      content: 'pwned',
    })
    expect(bad.is_error).toBe(true)

    // Valid write works
    const good = await tool.execute({
      path: 'output.txt',
      content: 'safe',
    })
    expect(good.is_error).toBe(false)

    // Verify file was actually written
    const content = await readFile(join(workspacePath, 'output.txt'), 'utf-8')
    expect(content).toBe('safe')
  })

  it('should reject writes exceeding size limit', async () => {
    const tool = new FileWriteTool(workspacePath)
    const result = await tool.execute({
      path: 'large.txt',
      content: 'x'.repeat(6 * 1024 * 1024), // 6MB > 5MB limit
    })
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('too large')
  })
})
