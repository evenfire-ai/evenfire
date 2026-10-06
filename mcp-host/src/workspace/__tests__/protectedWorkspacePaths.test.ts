import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { FileReadTool } from '../../core/tools/fileRead'
import { FileWriteTool } from '../../core/tools/fileWrite'
import {
  MemorySearchTool,
  MemoryTreeTool,
  PersistentMemoryReadTool,
  PersistentMemoryWriteTool,
} from '../../core/tools/memory'
import { GfsDownloadPathError, WorkspaceService } from '../service'

describe('protected workspace paths', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-workspace-'))
    const downloadDir = path.join(root, '.gfs-downloads', 'input-1')
    fs.mkdirSync(downloadDir, { recursive: true })
    fs.writeFileSync(path.join(downloadDir, 'source.md'), 'xylophone quixotic zenith', 'utf-8')
    fs.writeFileSync(path.join(root, 'note.md'), 'public-token', 'utf-8')
    fs.symlinkSync(path.join(downloadDir, 'source.md'), path.join(root, 'alias.md'))
    const storeAccounting = path.join(root, '.gfs-download-store')
    fs.mkdirSync(storeAccounting, { recursive: true })
    for (const name of [
      'ledger-v1.json',
      'writer-v2.sqlite',
      'writer-v2.sqlite-journal',
      'writer.lock',
    ]) {
      fs.writeFileSync(path.join(storeAccounting, name), 'accounting-sentinel', 'utf-8')
    }
    fs.writeFileSync(path.join(storeAccounting, 'ledger-v1.json.tmp-1'), 'journal', 'utf-8')
    fs.symlinkSync(storeAccounting, path.join(root, 'store-alias'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('blocks direct and symlinked access through WorkspaceService', async () => {
    const workspace = new WorkspaceService(root)
    await expect(workspace.read('.gfs-downloads/input-1/source.md')).rejects.toBeInstanceOf(
      GfsDownloadPathError
    )
    await expect(workspace.read('alias.md')).rejects.toBeInstanceOf(GfsDownloadPathError)
    await expect(workspace.exists('.gfs-downloads/input-1/source.md')).resolves.toBe(false)
    await expect(workspace.list()).resolves.not.toContainEqual(
      expect.objectContaining({ name: '.gfs-downloads' })
    )
    await expect(workspace.search('xylophone quixotic zenith')).resolves.toEqual([])
    await expect(workspace.search('public-token')).resolves.toHaveLength(1)
  })

  it('blocks the whole GFS accounting namespace and all of its artifacts', async () => {
    const workspace = new WorkspaceService(root)
    const paths = [
      '.gfs-download-store/ledger-v1.json',
      '.gfs-download-store/writer-v2.sqlite',
      '.gfs-download-store/writer-v2.sqlite-journal',
      '.gfs-download-store/writer.lock',
      '.gfs-download-store/ledger-v1.json.tmp-1',
      'store-alias/ledger-v1.json',
    ]
    for (const relativePath of paths) {
      await expect(workspace.read(relativePath)).rejects.toBeInstanceOf(GfsDownloadPathError)
    }
    await expect(workspace.list()).resolves.not.toContainEqual(
      expect.objectContaining({ name: '.gfs-download-store' })
    )
    await expect(workspace.search('accounting-sentinel')).resolves.toEqual([])
  })

  it('rejects a workspace root that itself resolves into GFS accounting', async () => {
    const accountingRoot = path.join(root, '.gfs-download-store')
    fs.writeFileSync(path.join(accountingRoot, 'MEMORY.md'), 'accounting-sentinel', 'utf-8')
    const aliasedWorkspace = new WorkspaceService(accountingRoot)
    const memoryRead = new PersistentMemoryReadTool(aliasedWorkspace)
    const memoryWrite = new PersistentMemoryWriteTool(aliasedWorkspace)

    await expect(aliasedWorkspace.read('ledger-v1.json')).rejects.toBeInstanceOf(
      GfsDownloadPathError
    )
    await expect(aliasedWorkspace.list()).rejects.toBeInstanceOf(GfsDownloadPathError)
    await expect(aliasedWorkspace.search('accounting-sentinel')).resolves.toEqual([])
    await expect(memoryRead.execute({ path: 'MEMORY.md' })).resolves.toMatchObject({
      is_error: true,
      content: expect.stringContaining('governed GFS'),
    })
    await expect(
      memoryWrite.execute({ target: 'MEMORY.md', content: 'replacement' })
    ).resolves.toMatchObject({
      is_error: true,
      content: expect.stringContaining('governed GFS'),
    })
    expect(fs.readFileSync(path.join(accountingRoot, 'MEMORY.md'), 'utf-8')).toBe(
      'accounting-sentinel'
    )
  })

  it('blocks direct and symlinked access through file tools', async () => {
    const read = new FileReadTool(root)
    const direct = await read.execute({ path: '.gfs-downloads/input-1/source.md' })
    const aliased = await read.execute({ path: 'alias.md' })

    expect(direct.is_error).toBe(true)
    expect(direct.content).toContain('governed GFS download')
    expect(aliased.is_error).toBe(true)
    expect(aliased.content).toContain('Reserved workspace path')

    const write = new FileWriteTool(root)
    const blockedWrite = await write.execute({
      path: 'alias.md',
      content: 'replacement',
    })
    expect(blockedWrite.is_error).toBe(true)
    expect(
      fs.readFileSync(path.join(root, '.gfs-downloads', 'input-1', 'source.md'), 'utf-8')
    ).toBe('xylophone quixotic zenith')
  })

  it('blocks direct and symlinked access through memory tools without leaking search results', async () => {
    const workspace = new WorkspaceService(root)
    const read = new PersistentMemoryReadTool(workspace)
    const write = new PersistentMemoryWriteTool(workspace)
    const search = new MemorySearchTool(workspace)
    const tree = new MemoryTreeTool(workspace)

    await expect(read.execute({ path: 'alias.md' })).resolves.toMatchObject({
      is_error: true,
      content: expect.stringContaining('governed GFS download'),
    })
    await expect(
      write.execute({ target: '.gfs-downloads/input-1/source.md', content: 'x' })
    ).resolves.toMatchObject({
      is_error: true,
      content: expect.stringContaining('governed GFS download'),
    })
    await expect(search.execute({ query: 'xylophone quixotic zenith' })).resolves.toMatchObject({
      is_error: false,
      content: expect.stringContaining('"result_count":0'),
    })
    await expect(tree.execute({ path: '' })).resolves.toMatchObject({
      is_error: false,
      content: expect.not.stringContaining('.gfs-downloads'),
    })
  })
})
