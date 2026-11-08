import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import type { GfsSaveStage } from '../gfs/saveOwner.js'

const windowsNativeInspector =
  process.platform === 'win32'
    ? (require('../../native/build/Release/evenfire_gfs_save_bridge.node') as {
        inspectFinal(session: unknown): string
      })
    : undefined

afterEach(cleanupNativeCommitTestHarness)

describe('R26 S147 registered GFS save IPC finalization', () => {
  it.each(['S144', 'S145'] as const)(
    '%s freezes actual file identities before queued logout and ignores late duplicate work',
    async outcome => {
      const { service, ipcHandlers, saveDialog, ipcListeners } =
        await createNativeCommitTestHarness()
      const principal = {
        id: 's147-user',
        email: 's147-user@example.test',
        teamId: 'team-s147',
      }
      service.authClient = {
        googleLogin: vi.fn().mockResolvedValue({ token: 's147-session', me: principal }),
      } as never
      await service.googleLogin('synthetic-s147-login')

      const uri = 'gfs://main/2123456789abcdef0123456789abcdef'
      const bytes = new TextEncoder().encode(`s147-${outcome}-body`).buffer
      const app = service as unknown as {
        gfsClient: { downloadWithReceipt: ReturnType<typeof vi.fn> }
        tokenStore: { clearSessionToken: ReturnType<typeof vi.fn> }
        getSessionGeneration(): number
        logout(): Promise<number>
      }
      app.gfsClient.downloadWithReceipt = vi.fn(async () => ({
        uri,
        version: 31,
        filename: 's147.bin',
        bytes,
      }))

      const configuredRoot = process.env.EVENFIRE_GFS_SAVE_TEST_ROOT
      const root = configuredRoot ?? os.tmpdir()
      const directory = await fs.mkdtemp(path.join(root, `r26-s147-${outcome}-`))
      const filePath = path.join(directory, 's147.bin')
      saveDialog.mockResolvedValue({ canceled: false, filePath })
      const reconciliationStarted = deferred<GfsSaveStage>()
      const releaseReconciliation = deferred<void>()
      const attempts: string[] = []
      const order: string[] = []
      let receiptJson: string | undefined
      const originalClear = app.tokenStore.clearSessionToken
      app.tokenStore.clearSessionToken = vi.fn(async (...args: unknown[]) => {
        order.push('logout-commit')
        await originalClear(...args)
      })

      const { registerIpcHandlers, setIpcGfsSaveReadbackTestHook } = await import('../ipc.js')
      setIpcGfsSaveReadbackTestHook(async (stage, attempt) => {
        attempts.push(attempt)
        if (attempt === 'primary') throw new Error('injected primary read failure')
        reconciliationStarted.resolve(stage)
        await releaseReconciliation.promise
        if (outcome === 'S145') throw new Error('injected inconclusive reconciliation')
        return undefined
      })

      let caller: Promise<unknown> | undefined
      let logout: Promise<number> | undefined
      try {
        registerIpcHandlers(service as never, async () => 0)
        const handler = ipcHandlers.get('gfs:saveToDisk') as
          | ((event: unknown, payload: unknown) => Promise<unknown>)
          | undefined
        expect(handler).toBeTypeOf('function')
        const payload = {
          uri,
          expectedSessionGeneration: app.getSessionGeneration(),
          requestId: `r26-s147-${outcome.toLowerCase()}`,
        }
        caller = handler!(
          { senderFrame: { url: 'file:///app/index.html' }, sender: {} },
          payload
        ).then(receipt => {
          receiptJson = JSON.stringify(receipt)
          order.push('save-caller-settled')
          return receipt
        })

        const stage = await reconciliationStarted.promise
        const finalBefore = await fs.stat(filePath)
        const identity = (stats: Awaited<ReturnType<typeof fs.stat>>) => `${stats.dev}:${stats.ino}`
        const retainedIdentity =
          process.platform === 'win32'
            ? windowsNativeInspector!.inspectFinal(stage.nativeSession)
            : identity(finalBefore)
        expect(retainedIdentity).toBe(stage.fileIdentity)
        const stageBefore =
          process.platform === 'win32' ? undefined : await fs.stat(stage.stagePath)
        if (stageBefore) expect(identity(stageBefore)).toBe(stage.fileIdentity)
        else await expect(fs.stat(stage.stagePath)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await fs.readFile(filePath)).toEqual(Buffer.from(bytes))
        expect(attempts).toEqual(['primary', 'reconciliation'])
        expect(order).toEqual([])

        logout = service.logout().then(value => {
          order.push('logout-resolved')
          return value
        })
        await Promise.resolve()
        expect(order).toEqual([])

        releaseReconciliation.resolve()
        const receipt = (await caller) as Record<string, unknown>
        await logout
        expect(order).toEqual(['save-caller-settled', 'logout-commit', 'logout-resolved'])
        expect(receipt).toMatchObject({
          status: outcome === 'S144' ? 'saved_access_verified' : 'published_access_unverified',
          uri,
          version: 31,
          filePath,
        })
        if (outcome === 'S145') {
          expect(receipt).toMatchObject({
            publication: 'confirmed_by_native_return',
            identity: 'unverified',
            access: 'unverified',
          })
        }
        expect(attempts).toEqual(['primary', 'reconciliation'])

        const finalAfter = await fs.stat(filePath)
        expect(identity(finalAfter)).toBe(identity(finalBefore))
        expect(await fs.readFile(filePath)).toEqual(Buffer.from(bytes))
        if (outcome === 'S144' || process.platform === 'win32') {
          await expect(fs.stat(stage.stagePath)).rejects.toMatchObject({ code: 'ENOENT' })
          expect(receipt.stageCleanup).toBe('complete')
        } else {
          if (!stageBefore) throw new Error('POSIX stage identity was not captured before cleanup')
          const stageAfter = await fs.stat(stage.stagePath)
          expect(identity(stageAfter)).toBe(identity(stageBefore))
          expect(receipt).toMatchObject({
            stageCleanup: 'retained',
            residualStagePath: stage.stagePath,
            residualStageIdentity: stage.fileIdentity,
          })
        }

        const duplicate = await handler!(
          { senderFrame: { url: 'file:///app/index.html' }, sender: {} },
          payload
        )
        expect(duplicate).toEqual(receipt)
        ipcListeners.get('gfs:abort')?.({}, { requestId: payload.requestId })
        await new Promise(resolve => setImmediate(resolve))
        expect(JSON.stringify(receipt)).toBe(receiptJson)
        expect(attempts).toEqual(['primary', 'reconciliation'])
        expect(order).toEqual(['save-caller-settled', 'logout-commit', 'logout-resolved'])
        expect(identity(await fs.stat(filePath))).toBe(identity(finalBefore))
        expect(await fs.readFile(filePath)).toEqual(Buffer.from(bytes))
      } finally {
        releaseReconciliation.resolve()
        setIpcGfsSaveReadbackTestHook(undefined)
        await caller?.catch(() => undefined)
        await logout?.catch(() => undefined)
        await fs.rm(directory, { recursive: true, force: true })
      }
    }
  )
})
