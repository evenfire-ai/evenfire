import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { saveGfsReceiptToPath } from '../gfs/saveOwner.js'

const directories: string[] = []

function makeDirectory(): string {
  const configuredRoot = process.env.EVENFIRE_GFS_SAVE_TEST_ROOT
  const root = configuredRoot ?? os.tmpdir()
  if (!path.isAbsolute(root) || !existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error('GFS save test root must be an existing absolute directory')
  }
  const directory = mkdtempSync(path.join(root, 'evenfire-gfs-save-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('trusted GFS save owner', () => {
  it('publishes exact bytes with the intended final mode after private staging', async () => {
    const directory = makeDirectory()
    const filePath = path.join(directory, 'receipt.txt')
    const bytes = new TextEncoder().encode('admitted body').buffer
    const intendedMode = 0o666 & ~process.umask()
    let stageDirectory: string | undefined
    const receipt = await saveGfsReceiptToPath({
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      version: 7,
      filePath,
      bytes,
      publishFence: async publish => await publish(),
      onStageWriteChunk: (_written, stagePath) => {
        if (!stagePath) throw new Error('stage path missing from producer test seam')
        stageDirectory = path.dirname(stagePath)
      },
    })
    expect(receipt).toMatchObject({
      status: 'saved_access_verified',
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      version: 7,
      filePath,
    })
    expect(readFileSync(filePath, 'utf8')).toBe('admitted body')
    expect(readdirSync(directory)).toContain('receipt.txt')
    expect(stageDirectory).toBeTruthy()
    expect(readdirSync(directory)).toEqual(['receipt.txt'])
    if (process.platform !== 'win32') {
      expect(statSync(filePath).mode & 0o777).toBe(intendedMode)
    }
  })

  it('does not replace an existing destination', async () => {
    const directory = makeDirectory()
    const filePath = path.join(directory, 'existing.txt')
    writeFileSync(filePath, 'original')

    await expect(
      saveGfsReceiptToPath({
        uri: 'gfs://main/0123456789abcdef0123456789abcdef',
        version: 1,
        filePath,
        bytes: new TextEncoder().encode('replacement').buffer,
        publishFence: async publish => publish(),
      })
    ).rejects.toThrow()
    expect(readFileSync(filePath, 'utf8')).toBe('original')
    expect(readdirSync(directory)).toEqual(['existing.txt'])
  })

  it('keeps staging private until writer settlement before final permission application', async () => {
    if (process.platform === 'win32') return
    const directory = makeDirectory()
    const filePath = path.join(directory, 'residual.txt')
    let residualPath: string | undefined
    const receipt = await saveGfsReceiptToPath({
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      version: 9,
      filePath,
      bytes: new TextEncoder().encode('staged').buffer,
      publishFence: async publish => await publish(),
      onStageWriteChunk: (_written, stagePath) => {
        if (!stagePath) throw new Error('stage path missing from producer test seam')
        residualPath = stagePath
        expect(statSync(stagePath).mode & 0o777).toBe(0o600)
        expect(statSync(path.dirname(stagePath)).mode & 0o777).toBe(0o700)
      },
    })
    expect(receipt).toMatchObject({
      status: 'saved_access_verified',
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      version: 9,
      filePath,
      stageCleanup: 'complete',
    })
    expect(residualPath && existsSync(residualPath)).toBe(false)
    expect(readFileSync(filePath, 'utf8')).toBe('staged')
    expect(statSync(filePath).mode & 0o777).toBe(0o666 & ~process.umask())
  })

  it('removes the private stage alias before widening the published POSIX inode', async () => {
    if (process.platform === 'win32') return
    const directory = makeDirectory()
    const filePath = path.join(directory, 'alias-order.txt')
    let observed = false
    const receipt = await saveGfsReceiptToPath({
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      version: 10,
      filePath,
      bytes: new TextEncoder().encode('alias order').buffer,
      publishFence: async publish => await publish(),
      onStageWriteChunk: (_written, stagePath) => {
        if (!stagePath) throw new Error('stage path missing from producer test seam')
      },
      onPosixStageAliasRemoved: (stagePath, finalMode) => {
        observed = true
        expect(existsSync(stagePath)).toBe(false)
        expect(finalMode).toBe(0o600)
        expect(statSync(filePath).mode & 0o777).toBe(0o600)
      },
    })
    expect(observed).toBe(true)
    expect(receipt.status).toBe('saved_access_verified')
    expect(readFileSync(filePath, 'utf8')).toBe('alias order')
    expect(statSync(filePath).mode & 0o777).toBe(0o666 & ~process.umask())
  })

  it('settles cancellation before the final effect and cleans the stage', async () => {
    const directory = makeDirectory()
    const filePath = path.join(directory, 'cancelled.txt')
    const controller = new AbortController()

    await expect(
      saveGfsReceiptToPath({
        uri: 'gfs://main/0123456789abcdef0123456789abcdef',
        version: 1,
        filePath,
        bytes: new TextEncoder().encode('never publish').buffer,
        signal: controller.signal,
        publishFence: async publish => {
          controller.abort()
          return await publish()
        },
      })
    ).resolves.toEqual({
      status: 'cancelled_no_publication',
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      filePath: null,
    })
    expect(readdirSync(directory)).toEqual([])
  })

  it('reconciles a failed primary read once and keeps the published entry', async () => {
    if (process.platform === 'win32') return
    const directory = makeDirectory()
    const filePath = path.join(directory, 's144.txt')
    const readAttempts: string[] = []
    let publishedIdentity: string | undefined
    const receipt = await saveGfsReceiptToPath({
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      version: 11,
      filePath,
      bytes: new TextEncoder().encode('s144 bytes').buffer,
      publishFence: async finalize => finalize(),
      onStageWriteChunk: (_written, stagePath) => {
        if (!stagePath) throw new Error('stage path missing from producer test seam')
        const stat = statSync(stagePath)
        publishedIdentity = `${stat.dev}:${stat.ino}`
      },
      readPublishedIdentity: async (_stage, attempt) => {
        readAttempts.push(attempt)
        if (attempt === 'primary') throw new Error('injected primary read failure')
        return publishedIdentity ?? null
      },
    })

    expect(receipt).toMatchObject({
      status: 'saved_access_verified',
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      version: 11,
      filePath,
      stageCleanup: 'complete',
    })
    expect(readAttempts).toEqual(['primary', 'reconciliation'])
    expect(readFileSync(filePath, 'utf8')).toBe('s144 bytes')
    expect(readdirSync(directory)).toEqual(['s144.txt'])
  })

  it('freezes published access as unverified after one inconclusive reconciliation', async () => {
    if (process.platform === 'win32') return
    const directory = makeDirectory()
    const filePath = path.join(directory, 's145.txt')
    const readAttempts: string[] = []
    let residualStagePath: string | undefined
    const receipt = await saveGfsReceiptToPath({
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      version: 12,
      filePath,
      bytes: new TextEncoder().encode('s145 bytes').buffer,
      publishFence: async finalize => finalize(),
      onStageWriteChunk: (_written, stagePath) => {
        if (!stagePath) throw new Error('stage path missing from producer test seam')
        residualStagePath = stagePath
      },
      readPublishedIdentity: async (_stage, attempt) => {
        readAttempts.push(attempt)
        throw new Error(`${attempt} read failure`)
      },
    })

    expect(receipt).toMatchObject({
      status: 'published_access_unverified',
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      version: 12,
      filePath,
      publication: 'confirmed_by_native_return',
      identity: 'unverified',
      access: 'unverified',
      stageCleanup: 'retained',
      residualStagePath,
    })
    expect(readAttempts).toEqual(['primary', 'reconciliation'])
    expect(readFileSync(filePath, 'utf8')).toBe('s145 bytes')
    expect(residualStagePath && existsSync(residualStagePath)).toBe(true)
    expect(readdirSync(directory)).toContain('s145.txt')
  })

  it('keeps explicit cancellation monotonic after bytes settle and before publication', async () => {
    const directory = makeDirectory()
    const filePath = path.join(directory, 'explicitly-cancelled.txt')
    const cancellation = { requested: false }
    const bytes = new Uint8Array(192 * 1024).fill(0x63)

    await expect(
      saveGfsReceiptToPath({
        uri: 'gfs://main/0123456789abcdef0123456789abcdef',
        version: 4,
        filePath,
        bytes: bytes.buffer,
        cancelRequested: () => cancellation.requested,
        publishFence: async publish => {
          cancellation.requested = true
          return await publish()
        },
      })
    ).resolves.toEqual({
      status: 'cancelled_no_publication',
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      filePath: null,
    })
    expect(existsSync(filePath)).toBe(false)
    expect(readdirSync(directory)).toEqual([])
  })

  it('waits for a partial stage writer to settle before cleaning on cancellation', async () => {
    const directory = makeDirectory()
    const filePath = path.join(directory, 'partial-cancel.txt')
    const controller = new AbortController()
    let releaseWriter: (() => void) | undefined
    let markWriterStarted: (() => void) | undefined
    const writerStarted = new Promise<void>(resolve => {
      markWriterStarted = resolve
    })
    const blockedWriter = new Promise<void>(resolve => {
      releaseWriter = resolve
    })
    let writerSettled = false
    let writtenChunks = 0
    let publicationCalls = 0
    const body = new Uint8Array(192 * 1024).fill(0x5a)

    const pending = saveGfsReceiptToPath({
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      version: 3,
      filePath,
      bytes: body.buffer,
      signal: controller.signal,
      publishFence: async publish => {
        publicationCalls += 1
        publish()
      },
      onStageWriteChunk: async () => {
        writtenChunks += 1
        markWriterStarted?.()
        try {
          await blockedWriter
        } finally {
          writerSettled = true
        }
      },
    })

    await writerStarted
    if (process.platform !== 'win32') {
      const stageDirectories = readdirSync(directory).filter(name => name.endsWith('.partial'))
      expect(stageDirectories).toHaveLength(1)
      const stageDirectory = path.join(directory, stageDirectories[0]!)
      const stageDirectoryStat = statSync(stageDirectory)
      expect(stageDirectoryStat.isDirectory()).toBe(true)
      expect(stageDirectoryStat.mode & 0o777).toBe(0o700)
      expect(readdirSync(stageDirectory)).toEqual(['content'])
      expect(statSync(path.join(stageDirectory, 'content')).mode & 0o777).toBe(0o600)
    }
    controller.abort()
    await Promise.resolve()
    expect(publicationCalls).toBe(0)
    expect(writerSettled).toBe(false)
    expect(existsSync(filePath)).toBe(false)
    if (process.platform !== 'win32') {
      const stageDirectory = path.join(
        directory,
        readdirSync(directory).find(name => name.endsWith('.partial'))!
      )
      expect(readdirSync(stageDirectory)).toEqual(['content'])
      expect(statSync(stageDirectory).mode & 0o777).toBe(0o700)
      expect(statSync(path.join(stageDirectory, 'content')).mode & 0o777).toBe(0o600)
    }

    releaseWriter?.()
    await expect(pending).resolves.toEqual({
      status: 'cancelled_no_publication',
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      filePath: null,
    })
    expect(writerSettled).toBe(true)
    expect(writtenChunks).toBe(1)
    expect(publicationCalls).toBe(0)
    expect(readdirSync(directory)).toEqual([])
  })

  it('keeps Windows stage private until auth-fenced retained-handle publication', async () => {
    if (process.platform !== 'win32') return
    const directory = makeDirectory()
    const referencePath = path.join(directory, 'reference.txt')
    const savedPath = path.join(directory, 'saved.txt')
    writeFileSync(referencePath, 'reference')
    let restrictedObservation:
      | {
          ownerSid: string
          daclSddl: string
          daclProtected: boolean
          bytesWritten: number
          physicalLength: number
          hidden: boolean
          identity: string
        }
      | undefined
    let stagePath: string | undefined
    let releaseStage: (() => void) | undefined
    let markStageWritten: (() => void) | undefined
    const stageWritten = new Promise<void>(resolve => {
      markStageWritten = resolve
    })
    const waitForPublication = new Promise<void>(resolve => {
      releaseStage = resolve
    })
    const pending = saveGfsReceiptToPath({
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      version: 2,
      filePath: savedPath,
      bytes: new TextEncoder().encode('saved').buffer,
      publishFence: async publish => {
        await waitForPublication
        publish()
      },
      onWindowsRestrictedStage: observation => {
        restrictedObservation = observation
      },
      onStageWriteChunk: async (_bytesWritten, currentStagePath) => {
        stagePath = currentStagePath
        markStageWritten?.()
        await waitForPublication
      },
    })
    await stageWritten
    expect(stagePath).toBeTruthy()
    expect(restrictedObservation?.inspectStage()).toMatchObject({
      daclSddl: `D:P(A;;FA;;;${restrictedObservation?.ownerSid})(A;;FA;;;SY)`,
      bytesWritten: 5,
      physicalLength: 5,
      daclProtected: true,
    })
    releaseStage?.()
    const result = await pending
    expect(result.status).toBe('saved_access_verified')
    expect(restrictedObservation).toMatchObject({
      daclProtected: true,
      bytesWritten: 0,
      physicalLength: 5,
      hidden: false,
    })
    expect(restrictedObservation?.ownerSid).toMatch(/^S-1-[0-9-]+$/)
    expect(restrictedObservation?.daclSddl).toBe(
      `D:P(A;;FA;;;${restrictedObservation?.ownerSid})(A;;FA;;;SY)`
    )
    expect(restrictedObservation?.identity).toMatch(/^[0-9A-F]{16}:[0-9A-F]{32}$/i)

    const host =
      process.env.EVENFIRE_GFS_POWERSHELL_PATH ??
      path.win32.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      )
    const script = String.raw`
$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json
$result = @()
foreach ($path in $paths) {
  $item = Get-Item -LiteralPath $path -Force
  $result += [PSCustomObject]@{ Sddl = (Get-Acl -LiteralPath $path).Sddl; Attributes = [string]$item.Attributes }
}
$result | ConvertTo-Json -Compress
`
    const inspected = spawnSync(
      host,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { input: JSON.stringify([referencePath, savedPath]), encoding: 'utf8', shell: false }
    )
    expect(inspected.error).toBeUndefined()
    expect(inspected.status).toBe(0)
    const [reference, saved] = JSON.parse(inspected.stdout) as Array<{
      Sddl: string
      Attributes: string
    }>
    expect(saved?.Sddl).toBe(reference?.Sddl)
    expect(saved?.Attributes).not.toContain('Hidden')
  })

  it('S146 freezes access-unverified after one reconciliation and Q remains denied after close', async () => {
    if (process.platform !== 'win32') return
    const directory = makeDirectory()
    const controlPath = path.join(directory, 'q-readable-control.bin')
    writeFileSync(controlPath, 'Q token control')
    const powershell =
      process.env.EVENFIRE_GFS_POWERSHELL_PATH ??
      path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      )
    const qProbe = path.join(__dirname, '../../native/test-q-token-access.ps1')
    const probeQ = (filePath: string, grantRead = false) => {
      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        qProbe,
        '-Path',
        filePath,
      ]
      if (grantRead) args.push('-GrantRead')
      const result = spawnSync(powershell, args, {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      const match = result.stdout.match(/Q_EXIT=(\d+)/)
      expect(match?.[1]).toBeTruthy()
      return Number(match![1])
    }
    expect(probeQ(controlPath, true)).toBe(0)

    const filePath = path.join(directory, 's146-access-unknown.txt')
    const accessAttempts: string[] = []
    const receipt = await saveGfsReceiptToPath({
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      version: 146,
      filePath,
      bytes: new TextEncoder().encode('s146 published bytes').buffer,
      publishFence: async finish => finish(),
      readWindowsFinalAccess: attempt => {
        accessAttempts.push(attempt)
        expect(probeQ(filePath)).toBe(5)
        throw new Error(`injected ${attempt} access read failure`)
      },
    })

    expect(receipt).toMatchObject({
      status: 'published_access_unverified',
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      version: 146,
      filePath,
      publication: 'confirmed_by_native_return',
      identity: 'verified',
      access: 'unverified',
      stageCleanup: 'complete',
    })
    expect(accessAttempts).toEqual(['primary', 'reconciliation'])
    expect(readFileSync(filePath, 'utf8')).toBe('s146 published bytes')
    expect(probeQ(filePath)).toBe(5)
  })
})
