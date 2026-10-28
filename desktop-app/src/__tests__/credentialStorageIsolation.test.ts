import { describe, expect, it } from 'vitest'
import * as fsCallbacks from 'node:fs'
import {
  copyFile as namedCopyFile,
  readFile as namedReadFile,
  readdir as namedReaddir,
} from 'node:fs'
import fs from 'node:fs/promises'
import { readFile as namedPromiseReadFile, readdir as namedPromiseReaddir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import * as isolation from '../../test/setup/credentialStorageIsolation.js'

const takeCredentialStorageIsolationAttempts = isolation.takeCredentialStorageIsolationAttempts
const registerSyntheticRoot = (
  isolation as unknown as {
    registerSyntheticCredentialStorageRoot?: (root: string) => () => void
  }
).registerSyntheticCredentialStorageRoot

type ProtectedFixture = {
  scratch: string
  scratchAlias: string
  wildcardScratch?: string
  root: string
  source: string
  alias: string
  dereferenceSource: string
  refusal: string
  cleanup(): Promise<void>
}

async function createProtectedFixture(
  options: { includeWildcardAlias?: boolean } = {}
): Promise<ProtectedFixture> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-isolation-protected-'))
  const scratchAlias = `${scratch}-cwd-alias`
  let wildcardScratch: string | undefined
  try {
    const scratchRoot = path.join(scratch, 'credential-root')
    await fs.mkdir(scratchRoot)
    const scratchSource = path.join(scratchRoot, 'session-token.json')
    await fs.writeFile(scratchSource, 'synthetic-bearer-never-a-real-credential')
    const alias = path.join(scratch, 'credential-alias')
    await fs.symlink(scratchRoot, alias)
    const dereferenceSource = path.join(scratch, 'cp-dereference-source')
    await fs.mkdir(dereferenceSource)
    await fs.symlink(scratchRoot, path.join(dereferenceSource, 'credential-root'))
    await fs.symlink(scratch, scratchAlias)
    if (options.includeWildcardAlias) {
      wildcardScratch = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-glob-wildcard-link-'))
      const matchedDirectory = path.join(wildcardScratch, 'matched-directory')
      await fs.mkdir(matchedDirectory)
      await fs.symlink(scratchRoot, path.join(wildcardScratch, 'credential-alias'))
      await fs.symlink(scratchRoot, path.join(matchedDirectory, 'credential-alias'))
    }

    // Previous heads lack this hook, so their synthetic fixture reaches the unguarded API.
    const root = scratchRoot
    const unregister = registerSyntheticRoot?.(scratchRoot) ?? (() => {})
    return {
      scratch,
      scratchAlias,
      wildcardScratch,
      root,
      source: path.join(root, 'session-token.json'),
      alias,
      dereferenceSource,
      refusal: 'refused synthetic-credential-files',
      async cleanup() {
        unregister()
        await Promise.all([
          fs.rm(scratchAlias, { force: true }),
          fs.rm(scratch, { recursive: true, force: true }),
          ...(wildcardScratch ? [fs.rm(wildcardScratch, { recursive: true, force: true })] : []),
        ])
      },
    }
  } catch (error) {
    await Promise.all([
      fs.rm(scratchAlias, { force: true }),
      fs.rm(scratch, { recursive: true, force: true }),
      ...(wildcardScratch ? [fs.rm(wildcardScratch, { recursive: true, force: true })] : []),
    ])
    throw error
  }
}

function callbackResult<T>(
  operation: (callback: (error: Error | null, value?: T) => void) => unknown
): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      operation((error, value) => (error ? reject(error) : resolve(value as T)))
    } catch (error) {
      reject(error)
    }
  })
}

function captureGlobResult(
  pattern: string,
  options: { cwd: string; followSymlinks?: boolean }
): { error: unknown } | { matches: string[] } {
  try {
    return { matches: fsCallbacks.globSync(pattern, options) as string[] }
  } catch (error) {
    return { error }
  }
}

function expectGlobScopeRefusal(
  outcome: ReturnType<typeof captureGlobResult>,
  syntheticName: string
): void {
  const matchesDescription = 'matches' in outcome ? JSON.stringify(outcome.matches) : 'none'
  if ('matches' in outcome) {
    expect(
      outcome.matches.some(match => match.includes(syntheticName)),
      `glob did not reach ${syntheticName}; matches: ${matchesDescription}`
    ).toBe(true)
  }
  expect('error' in outcome, `unguarded glob results: ${matchesDescription}`).toBe(true)
  if ('error' in outcome) {
    expect(outcome.error).toHaveProperty(
      'message',
      expect.stringContaining('glob-credential-scope')
    )
  }
}

describe('unit-test credential storage boundary', () => {
  it('blocks Node-native Keytar before executing the installed backend', () => {
    const require = createRequire(import.meta.url)
    expect(() => require('keytar')).toThrow('refused native-keytar')
    expect(takeCredentialStorageIsolationAttempts()).toEqual(['native-keytar'])
  })

  it('blocks a registered synthetic credential path before reading it', async () => {
    const fixture = await createProtectedFixture()
    try {
      await expect(fs.readFile(fixture.source)).rejects.toThrow(fixture.refusal)
      expect(takeCredentialStorageIsolationAttempts()).toEqual(['synthetic-credential-files'])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('permits real owned temporary resources', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-isolation-guard-'))
    const file = path.join(directory, 'fixture.txt')
    try {
      await fs.writeFile(file, 'fixture-owned-data')
      expect(await fs.readFile(file, 'utf8')).toBe('fixture-owned-data')
      expect(takeCredentialStorageIsolationAttempts()).toEqual([])
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('blocks Buffer paths and symlink aliases before synthetic file dispatch', async () => {
    const fixture = await createProtectedFixture()
    try {
      await expect(fs.readFile(Buffer.from(fixture.source))).rejects.toThrow(fixture.refusal)
      await expect(fs.readFile(path.join(fixture.alias, 'session-token.json'))).rejects.toThrow(
        fixture.refusal
      )
      expect(takeCredentialStorageIsolationAttempts()).toEqual([
        'synthetic-credential-files',
        'synthetic-credential-files',
      ])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks and records copyFile and cp across callback, promise, sync, and named APIs', async () => {
    const fixture = await createProtectedFixture()
    const destination = path.join(fixture.root, 'copy.json')
    try {
      await expect(fs.copyFile(fixture.source, destination)).rejects.toThrow(fixture.refusal)
      await expect(
        callbackResult<void>(callback => namedCopyFile(fixture.source, destination, callback))
      ).rejects.toThrow(fixture.refusal)
      await expect(
        callbackResult<void>(callback =>
          fsCallbacks.copyFile(fixture.source, destination, callback)
        )
      ).rejects.toThrow(fixture.refusal)
      expect(() => fsCallbacks.copyFileSync(fixture.source, destination)).toThrow(fixture.refusal)
      await expect(fs.cp(fixture.source, destination)).rejects.toThrow(fixture.refusal)
      await expect(
        callbackResult<void>(callback => fsCallbacks.cp(fixture.source, destination, callback))
      ).rejects.toThrow(fixture.refusal)
      expect(() => fsCallbacks.cpSync(fixture.source, destination)).toThrow(fixture.refusal)
      expect(takeCredentialStorageIsolationAttempts()).toHaveLength(7)
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks and records promise disposable temporary-directory creation', async () => {
    const fixture = await createProtectedFixture()
    const prefix = path.join(fixture.root, 'disposable-')
    try {
      expect(typeof fs.mkdtempDisposable).toBe('function')
      await expect(fs.mkdtempDisposable(prefix)).rejects.toThrow(fixture.refusal)
      expect(takeCredentialStorageIsolationAttempts()).toEqual(['synthetic-credential-files'])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks and records sync disposable temporary-directory creation', async () => {
    const fixture = await createProtectedFixture()
    const prefix = path.join(fixture.root, 'disposable-')
    try {
      expect(typeof fsCallbacks.mkdtempDisposableSync).toBe('function')
      expect(() => fsCallbacks.mkdtempDisposableSync(prefix)).toThrow(fixture.refusal)
      expect(takeCredentialStorageIsolationAttempts()).toEqual(['synthetic-credential-files'])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks and records callback and named fs and fs/promises reads', async () => {
    const fixture = await createProtectedFixture()
    try {
      await expect(
        callbackResult<Buffer>(callback => fsCallbacks.readFile(fixture.source, callback))
      ).rejects.toThrow(fixture.refusal)
      await expect(
        callbackResult<Buffer>(callback => namedReadFile(fixture.source, callback))
      ).rejects.toThrow(fixture.refusal)
      await expect(fs.readFile(fixture.source)).rejects.toThrow(fixture.refusal)
      await expect(namedPromiseReadFile(fixture.source)).rejects.toThrow(fixture.refusal)
      expect(takeCredentialStorageIsolationAttempts()).toHaveLength(4)
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks and records callback, promise, and sync directory enumeration', async () => {
    const fixture = await createProtectedFixture()
    try {
      await expect(fs.readdir(fixture.root)).rejects.toThrow(fixture.refusal)
      expect(() => fsCallbacks.readdirSync(fixture.root)).toThrow(fixture.refusal)
      await expect(
        callbackResult<string[]>(callback => namedReaddir(fixture.root, callback))
      ).rejects.toThrow(fixture.refusal)
      await expect(
        callbackResult<string[]>(callback => fsCallbacks.readdir(fixture.root, callback))
      ).rejects.toThrow(fixture.refusal)
      await expect(namedPromiseReaddir(fixture.root)).rejects.toThrow(fixture.refusal)
      expect(takeCredentialStorageIsolationAttempts()).toHaveLength(5)
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks and records callback and promise opendir variants', async () => {
    const fixture = await createProtectedFixture()
    try {
      const promiseDirectory = fs.opendir(fixture.root).then(async directory => {
        await directory.close()
        return directory
      })
      await expect(promiseDirectory).rejects.toThrow(fixture.refusal)
      const callbackDirectory = callbackResult<import('node:fs').Dir>(callback =>
        fsCallbacks.opendir(fixture.root, callback)
      ).then(async directory => {
        await directory.close()
        return directory
      })
      await expect(callbackDirectory).rejects.toThrow(fixture.refusal)
      expect(takeCredentialStorageIsolationAttempts()).toHaveLength(2)
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks and records both native realpath variants', async () => {
    const fixture = await createProtectedFixture()
    try {
      expect(() => fsCallbacks.realpathSync.native(fixture.source)).toThrow(fixture.refusal)
      await expect(
        callbackResult<string>(callback => fsCallbacks.realpath.native(fixture.source, callback))
      ).rejects.toThrow(fixture.refusal)
      expect(takeCredentialStorageIsolationAttempts()).toHaveLength(2)
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks and records stream path dispatch before opening a credential file', async () => {
    const fixture = await createProtectedFixture()
    try {
      expect(() => {
        const stream = fsCallbacks.createReadStream(fixture.source)
        stream.on('error', () => {})
        stream.destroy()
      }).toThrow(fixture.refusal)
      expect(takeCredentialStorageIsolationAttempts()).toEqual(['synthetic-credential-files'])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks glob APIs rooted directly at a synthetic credential directory', async () => {
    const fixture = await createProtectedFixture()
    try {
      expectGlobScopeRefusal(captureGlobResult('**/*', { cwd: fixture.root }), 'session-token.json')
      await expect(async () => {
        for await (const _match of fs.glob('**/*', { cwd: fixture.root })) {
          // The synthetic match is consumed only when an unguarded implementation is exercised.
        }
      }).rejects.toThrow('glob-credential-scope')
      expect(takeCredentialStorageIsolationAttempts()).toHaveLength(2)
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks glob wildcards that reach a protected descendant from an ancestor cwd', async () => {
    const fixture = await createProtectedFixture()
    try {
      const pattern = `**/${path.basename(fixture.root)}/**`
      expect(() => fsCallbacks.globSync(pattern, { cwd: fixture.scratch })).toThrow(
        'glob-credential-scope'
      )
      expect(takeCredentialStorageIsolationAttempts()).toEqual(['glob-credential-scope'])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks glob traversal from a symlinked cwd into a protected descendant', async () => {
    const fixture = await createProtectedFixture()
    try {
      const pattern = `**/${path.basename(fixture.root)}/**`
      expect(() => fsCallbacks.globSync(pattern, { cwd: fixture.scratchAlias })).toThrow(
        'glob-credential-scope'
      )
      expect(takeCredentialStorageIsolationAttempts()).toEqual(['glob-credential-scope'])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks parent-segment glob traversal through a symlinked cwd', async () => {
    const fixture = await createProtectedFixture()
    try {
      const pattern = `../${path.basename(fixture.scratchAlias)}/${path.basename(fixture.root)}/**`
      expectGlobScopeRefusal(
        captureGlobResult(pattern, { cwd: fixture.scratchAlias }),
        'credential-root/session-token.json'
      )
      expect(takeCredentialStorageIsolationAttempts()).toEqual(['glob-credential-scope'])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks brace-expanded parent traversal through a symlinked cwd', async () => {
    const fixture = await createProtectedFixture()
    try {
      const pattern = `{../,./}${path.basename(fixture.scratchAlias)}/${path.basename(fixture.root)}/**`
      expectGlobScopeRefusal(
        captureGlobResult(pattern, { cwd: fixture.scratchAlias }),
        'credential-root/session-token.json'
      )
      expect(takeCredentialStorageIsolationAttempts()).toEqual(['glob-credential-scope'])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks relative glob patterns through a synthetic symlink prefix', async () => {
    const fixture = await createProtectedFixture()
    try {
      const pattern = path.join(path.basename(fixture.alias), 'session-token.json')
      expectGlobScopeRefusal(
        captureGlobResult(pattern, { cwd: fixture.scratch }),
        'session-token.json'
      )
      expect(takeCredentialStorageIsolationAttempts()).toEqual(['glob-credential-scope'])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks absolute glob patterns through a synthetic symlink prefix', async () => {
    const fixture = await createProtectedFixture()
    try {
      const pattern = path.join(fixture.alias, 'session-token.json')
      expectGlobScopeRefusal(
        captureGlobResult(pattern, { cwd: fixture.scratch }),
        'session-token.json'
      )
      expect(takeCredentialStorageIsolationAttempts()).toEqual(['glob-credential-scope'])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks a wildcard-selected symlink with later explicit glob segments', async () => {
    const fixture = await createProtectedFixture({ includeWildcardAlias: true })
    try {
      const traversalRoot = fixture.wildcardScratch
      expect(traversalRoot).toBeDefined()

      expectGlobScopeRefusal(
        captureGlobResult('*/credential-alias/session-token.json', { cwd: traversalRoot! }),
        'session-token.json'
      )
      expect(takeCredentialStorageIsolationAttempts()).toEqual(['glob-credential-scope'])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('allows a terminal glob pattern that Node does not follow through the alias', async () => {
    const fixture = await createProtectedFixture({ includeWildcardAlias: true })
    try {
      const traversalRoot = fixture.wildcardScratch
      expect(traversalRoot).toBeDefined()

      expect(captureGlobResult('*/session-token.json', { cwd: traversalRoot! })).toEqual({
        matches: [],
      })
      expect(takeCredentialStorageIsolationAttempts()).toEqual([])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('allows default globstar to leave symlink paths untraversed', async () => {
    const fixture = await createProtectedFixture({ includeWildcardAlias: true })
    try {
      const traversalRoot = fixture.wildcardScratch
      expect(traversalRoot).toBeDefined()

      expect(
        captureGlobResult('**/credential-alias/session-token.json', { cwd: traversalRoot! })
      ).toEqual({ matches: [] })
      expect(takeCredentialStorageIsolationAttempts()).toEqual([])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks array glob patterns that reach a protected descendant', async () => {
    const fixture = await createProtectedFixture()
    try {
      const patterns = [`**/${path.basename(fixture.root)}/**`, 'unrelated/**']
      await expect(async () => {
        for await (const _match of fs.glob(patterns, { cwd: fixture.scratch })) {
          // The synthetic match is consumed only when an unguarded implementation is exercised.
        }
      }).rejects.toThrow('glob-credential-scope')
      expect(takeCredentialStorageIsolationAttempts()).toEqual(['glob-credential-scope'])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks glob symlink traversal into a protected root when followSymlinks is enabled', async () => {
    const fixture = await createProtectedFixture()
    try {
      expectGlobScopeRefusal(
        captureGlobResult('**/*', {
          cwd: fixture.dereferenceSource,
          followSymlinks: true,
        }),
        'session-token.json'
      )
      expect(takeCredentialStorageIsolationAttempts()).toEqual(['glob-credential-scope'])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks recursive cp when its source contains a protected root', async () => {
    const fixture = await createProtectedFixture()
    const outsideCopyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-isolation-copy-out-'))
    const outsideCopy = path.join(outsideCopyRoot, 'copy-out')
    const destinationRoot = path.dirname(fixture.root)
    try {
      await expect(fs.cp(destinationRoot, outsideCopy, { recursive: true })).rejects.toThrow(
        'recursive-credential-filesystem-operation'
      )
      expect(takeCredentialStorageIsolationAttempts()).toEqual([
        'recursive-credential-filesystem-operation',
      ])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fs.rm(outsideCopyRoot, { recursive: true, force: true })
      await fixture.cleanup()
    }
  })

  it('blocks recursive cp whose destination contains a protected root', async () => {
    const fixture = await createProtectedFixture()
    const destinationTree = path.join(fixture.scratch, 'copy-destination-source')
    const destinationRoot = path.dirname(fixture.root)
    try {
      await fs.mkdir(path.join(destinationTree, path.basename(fixture.root)), { recursive: true })
      await fs.writeFile(
        path.join(destinationTree, path.basename(fixture.root), 'overwrite-sentinel'),
        'synthetic-only'
      )
      await expect(fs.cp(destinationTree, destinationRoot, { recursive: true })).rejects.toThrow(
        'recursive-credential-filesystem-operation'
      )
      expect(takeCredentialStorageIsolationAttempts()).toEqual([
        'recursive-credential-filesystem-operation',
      ])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fixture.cleanup()
    }
  })

  it('blocks recursive cp dereferencing a symlink into a protected root', async () => {
    const fixture = await createProtectedFixture()
    const outsideCopyRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'evenfire-isolation-copy-link-')
    )
    const outsideCopy = path.join(outsideCopyRoot, 'copy-out')
    try {
      await expect(
        fs.cp(fixture.dereferenceSource, outsideCopy, {
          recursive: true,
          dereference: true,
        })
      ).rejects.toThrow('recursive-credential-filesystem-operation')
      expect(takeCredentialStorageIsolationAttempts()).toEqual([
        'recursive-credential-filesystem-operation',
      ])
    } finally {
      takeCredentialStorageIsolationAttempts()
      await fs.rm(outsideCopyRoot, { recursive: true, force: true })
      await fixture.cleanup()
    }
  })

  it('permits recursive cp entirely within owned temporary roots', async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-isolation-owned-cp-'))
    const source = path.join(scratch, 'source')
    const destination = path.join(scratch, 'destination')
    try {
      await fs.mkdir(source)
      await fs.writeFile(path.join(source, 'fixture.txt'), 'fixture-owned-data')
      await fs.cp(source, destination, { recursive: true })
      await expect(fs.readFile(path.join(destination, 'fixture.txt'), 'utf8')).resolves.toBe(
        'fixture-owned-data'
      )
      expect(takeCredentialStorageIsolationAttempts()).toEqual([])
    } finally {
      await fs.rm(scratch, { recursive: true, force: true })
    }
  })
})
