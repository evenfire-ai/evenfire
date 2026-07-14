import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createFileRuntimeTokenProvider } from '../../src/runtime-token-provider/provider'

describe('RuntimeTokenProvider', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
  })

  async function tokenFile(value: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-token-provider-'))
    tempDirs.push(dir)
    const file = path.join(dir, 'token')
    await fs.writeFile(file, value, 'utf8')
    return file
  }

  it('rereads a token file after it changes', async () => {
    const file = await tokenFile('jwt-a')
    const provider = createFileRuntimeTokenProvider({ wrcTokenFile: file })

    await expect(provider.getWrcToken?.()).resolves.toBe('jwt-a')
    await fs.writeFile(file, 'jwt-b', 'utf8')
    await expect(provider.getWrcToken?.()).resolves.toBe('jwt-b')
  })

  it('fails closed for missing and empty token files', async () => {
    const missingProvider = createFileRuntimeTokenProvider({ wrcTokenFile: '/missing/token' })
    await expect(missingProvider.getWrcToken?.()).rejects.toThrow('WRC_TOKEN_FILE file unreadable')

    const empty = await tokenFile('')
    const emptyProvider = createFileRuntimeTokenProvider({ mcpHostTokenFile: empty })
    await expect(emptyProvider.getMcpHostToken?.()).rejects.toThrow(
      'MCP_HOST_TOKEN_FILE file empty'
    )
  })
})
