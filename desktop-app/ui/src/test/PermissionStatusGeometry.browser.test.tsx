// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import {
  accessibleResource,
  affordancesFailureMessage,
  childView,
  listAccessiblePage,
  listChildrenPage,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
} from '../gfs/__fixtures__/gfsProducerFixtures'
import {
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '../gfs/__fixtures__/permissionProducerFixtures'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/evenfire-renderer-test', isPackaged: false, isReady: () => false },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
}))

type Rect = { x: number; y: number; width: number; height: number }
type RectSet = Record<string, Rect>

function assertStable(before: RectSet, actual: RectSet, label: string) {
  for (const [selector, beforeRect] of Object.entries(before)) {
    const afterRect = actual[selector]
    expect(afterRect, `${label}: ${selector} disappeared`).toBeTruthy()
    for (const axis of ['x', 'y', 'width', 'height'] as const) {
      expect(
        Math.abs(beforeRect[axis] - afterRect![axis]),
        `${label}: ${selector}.${axis}`
      ).toBeLessThanOrEqual(1)
    }
  }
}

async function assertReservedSlot(page: import('playwright').Page, selector: string) {
  const slot = page.locator(selector).first()
  const rect = await slot.boundingBox()
  expect(rect, `${selector} is mounted`).toBeTruthy()
  expect(rect!.width, `${selector} reserves horizontal space`).toBeGreaterThanOrEqual(18)
  expect(rect!.height, `${selector} reserves vertical space`).toBeGreaterThanOrEqual(18)
}

const measureRects = (selectors: string[]) =>
  Object.fromEntries(
    selectors.flatMap(selector => {
      const element = document.querySelector(selector)
      if (!element) return []
      const rect = element.getBoundingClientRect()
      return [[selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }]]
    })
  ) as RectSet

describe('EvenDrive permission status Chromium geometry and accessibility', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps real Files and Preview components within 1px at desktop and narrow widths', async () => {
    const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
    const uiRoot = path.join(desktopRoot, 'ui')
    const vite = await createServer({
      configFile: path.join(uiRoot, 'vite.config.ts'),
      server: { host: '127.0.0.1', port: 5183, strictPort: true },
    })
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      await vite.listen()
      const address = vite.httpServer?.address()
      if (!address || typeof address === 'string') throw new Error('Vite test server did not bind')
      const folder = await resolveResource(
        resolvedDirectory('folder-active', 'Reports', {
          gfsUri: 'gfs://main/folder-active',
          parentResourceId: 'source-parent',
        })
      )
      const sourceParent = await resolveResource(
        resolvedDirectory('source-parent', 'Shared folder', {
          gfsUri: 'gfs://main/source-parent',
        })
      )
      const preview = await resolveResource(
        resolvedFile('preview-file', 'diagram.png', {
          gfsUri: 'gfs://main/preview-file',
          parentResourceId: 'preview-parent',
        })
      )
      const previewParent = await resolveResource(
        resolvedDirectory('preview-parent', 'Preview folder', {
          gfsUri: 'gfs://main/preview-parent',
        })
      )
      const currentFileId = '0123456789abcdef0123456789abcdef'
      const currentFile = await resolveResource(
        resolvedFile(currentFileId, 'Current report.txt', {
          gfsUri: `gfs://main/${currentFileId}`,
          parentResourceId: 'source-parent',
        })
      )
      const rootPage = await listAccessiblePage([
        accessibleResource('folder-active', 'Reports', 'directory', {
          gfsUri: 'gfs://main/folder-active',
          parentResourceId: 'source-parent',
          permissions: ['read', 'write', 'delete', 'manage_acl', 'share'],
        }),
        accessibleResource('root-file', 'Shared notes.txt', 'file', { permissions: ['read'] }),
      ])
      const childrenPage = await listChildrenPage([
        childView('child-report', 'report.txt', 'file', { parentResourceId: 'folder-active' }),
      ])
      const produceAffordance = appServiceAffordanceProducer(async () =>
        heldPermissionResponse(['read', 'write', 'delete', 'manage_acl', 'share'])
      )
      const successfulAffordances: Record<string, unknown> = {}
      for (const id of [
        'folder-active',
        'source-parent',
        'child-report',
        'preview-file',
        'preview-parent',
        currentFileId,
      ]) {
        successfulAffordances[id] = await produceAffordance(id, 'main')
      }
      const errorMessages: Record<string, string> = {}
      for (const id of Object.keys(successfulAffordances)) {
        if (id === currentFileId) continue
        errorMessages[id] = await affordancesFailureMessage(
          id === 'folder-active' ? 429 : 503,
          id === 'folder-active'
            ? { code: 'rate_limited', message: 'Too Many Requests' }
            : { code: 'unavailable', message: 'permission service temporarily unavailable' },
          id
        )
      }

      browser = await chromium.launch({ headless: true })
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
      page.setDefaultTimeout(10_000)
      page.setDefaultNavigationTimeout(30_000)
      await page.addInitScript(
        ({
          folder,
          sourceParent,
          preview,
          previewParent,
          currentFile,
          rootPage,
          childrenPage,
          successfulAffordances,
          errorMessages,
        }) => {
          const modes: Record<string, 'success' | 'pending' | 'error'> = {}
          const pending = new Map<
            string,
            { resolve: (value: unknown) => void; reject: (error: Error) => void }
          >()
          let accessibleMode: 'success' | 'pending' | 'error' = 'success'
          let accessiblePending:
            | { resolve: (value: unknown) => void; reject: (error: Error) => void }
            | undefined
          const pass = <T,>(value: T): T => structuredClone(value)
          const respond = (id: string, success: unknown) => {
            const mode = modes[id] ?? 'success'
            if (mode === 'pending') {
              return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
            }
            if (mode === 'error') throw new Error(errorMessages[id])
            return pass(success)
          }
          window.__permissionStatusFixtures = {
            setPermissionMode: (id: string, mode: 'success' | 'pending' | 'error') => {
              modes[id] = mode
            },
            setAccessibleMode: (mode: 'success' | 'pending' | 'error') => {
              accessibleMode = mode
            },
            settlePermission: (id: string, result: 'success' | 'error') => {
              const request = pending.get(id)
              if (!request) throw new Error(`No pending permission request for ${id}`)
              pending.delete(id)
              modes[id] = result
              if (result === 'success') request.resolve(pass(successfulAffordances[id]))
              else request.reject(new Error(errorMessages[id]))
            },
            settleAccessible: (result: 'success' | 'error') => {
              if (!accessiblePending) throw new Error('No pending accessible-list request')
              const request = accessiblePending
              accessiblePending = undefined
              accessibleMode = result
              if (result === 'success') request.resolve(pass(rootPage))
              else request.reject(new Error('accessible-list fixture failure'))
            },
          }
          window.clerum = {
            auth: { getSessionGeneration: async () => 0 },
            gfs: {
              listAccessible: async () => {
                if (accessibleMode === 'pending') {
                  return new Promise((resolve, reject) => {
                    accessiblePending = { resolve, reject }
                  })
                }
                if (accessibleMode === 'error') throw new Error('accessible-list fixture failure')
                return pass(rootPage)
              },
              resolve: async (uri: string) => {
                if (uri === folder.gfsUri) return pass(folder)
                if (uri === sourceParent.gfsUri) return pass(sourceParent)
                if (uri === preview.gfsUri) return pass(preview)
                if (uri === previewParent.gfsUri) return pass(previewParent)
                if (uri === currentFile.gfsUri) return pass(currentFile)
                throw new Error(`Unexpected fixture resolve: ${uri}`)
              },
              listChildren: async (id: string) => {
                if (id !== 'folder-active') throw new Error(`Unexpected folder: ${id}`)
                return pass(childrenPage)
              },
              affordances: async (id: string) => {
                if (!successfulAffordances[id]) throw new Error(`Unexpected authority: ${id}`)
                return respond(id, successfulAffordances[id])
              },
              downloadPreview: async () => ({
                resource: pass(preview),
                bytes: new Uint8Array([1]).buffer,
              }),
            },
          } as unknown as Window['clerum']
        },
        {
          folder,
          sourceParent,
          preview,
          previewParent,
          currentFile,
          rootPage,
          childrenPage,
          successfulAffordances,
          errorMessages,
        }
      )
      await page.goto(`http://127.0.0.1:${address.port}/permission-status-geometry.html`, {
        waitUntil: 'domcontentloaded',
      })

      await page.getByRole('button', { name: 'Reports', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Shared notes.txt', exact: true }).waitFor()
      const rootRows = page.locator('.da-gfs-drive__grid .da-grid__row')
      expect(await rootRows.count()).toBe(2)
      expect(
        await page.locator('.da-gfs-drive__grid .da-permission-status-indicator').count()
      ).toBe(0)
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 })
        const rootBefore = await rootRows.evaluateAll(rows =>
          rows.map(row => {
            const rect = row.getBoundingClientRect()
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          })
        )
        const started = await page.evaluate(() => {
          window.__permissionStatusGeometry?.setAccessibleMode('pending')
          return window.__permissionStatusGeometry?.startAccessibleRefetch()
        })
        expect(started).toBe(true)
        await page.waitForFunction(
          () =>
            [
              ...(window.__permissionStatusGeometry?.filesClient.getQueryCache().getAll() ?? []),
            ].some(
              query =>
                query.queryKey.includes('accessible') && query.state.fetchStatus === 'fetching'
            ),
          undefined,
          { timeout: 5000 }
        )
        expect(
          await page.locator('.da-gfs-drive__grid .da-permission-status-indicator').count()
        ).toBe(0)
        expect(
          await rootRows.evaluateAll(rows =>
            rows.map(row => {
              const rect = row.getBoundingClientRect()
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            })
          )
        ).toEqual(rootBefore)
        await page.evaluate(() => window.__permissionStatusGeometry?.settleAccessible('success'))
      }
      await page.evaluate(() => {
        window.__permissionStatusGeometry?.setAccessibleMode('error')
        window.__permissionStatusGeometry?.startAccessibleRefetch()
      })
      await page.getByText('accessible-list fixture failure').waitFor()
      expect(await page.getByRole('alertdialog').count()).toBe(0)
      expect(
        await page.locator('.da-gfs-drive__grid .da-permission-status-indicator').count()
      ).toBe(0)

      await page.goto(
        `http://127.0.0.1:${address.port}/permission-status-geometry.html?gfsUri=${encodeURIComponent('gfs://main/folder-active')}`
      )
      await page.getByRole('button', { name: 'report.txt', exact: true }).waitFor()
      const breadcrumbOrder = await page.locator('.da-gfs-drive__title-row').evaluate(row => {
        const children = Array.from(row.children)
        const menu = children.findIndex(child =>
          child.querySelector('.da-gfs-resource-menu__trigger')
        )
        const spinner = children.findIndex(child => child.matches('.da-permission-status-slot'))
        return { menu, spinner }
      })
      expect(breadcrumbOrder.menu).toBeGreaterThanOrEqual(0)
      expect(breadcrumbOrder.spinner).toBeGreaterThan(breadcrumbOrder.menu)
      const fileSelectors = [
        '.da-gfs-drive__title-row',
        '.da-gfs-drive__breadcrumbs',
        '.da-gfs-drive__title-row > .da-permission-status-slot',
        '.da-gfs-resource-menu__trigger',
        '.da-gfs-drive__grid .da-grid__row',
        '.da-gfs-drive__grid .da-gfs-list__identity',
        '.da-gfs-drive__grid .da-gfs-list__actions',
      ]
      const measureFiles = () => page.evaluate(measureRects, fileSelectors)
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 })
        await assertReservedSlot(page, '.da-gfs-drive__title-row > .da-permission-status-slot')
        const rowStatusSlotCount = await page
          .locator('.da-gfs-drive__grid .da-gfs-list__name > .da-permission-status-slot')
          .count()
        const folderBefore = await measureFiles()
        await page.evaluate(() => {
          window.__permissionStatusGeometry?.setPermissionMode('folder-active', 'pending')
          window.__permissionStatusGeometry?.startAffordanceRefetch('files', 'folder-active')
        })
        await page.getByRole('status', { name: 'Checking permissions for Reports' }).waitFor()
        assertStable(folderBefore, await measureFiles(), `Files current folder ${width}px`)
        await page.evaluate(() =>
          window.__permissionStatusGeometry?.settlePermission('folder-active', 'success')
        )
        await page.waitForFunction(
          () => !document.querySelector('.da-gfs-drive__title-row .da-permission-status-indicator')
        )
        assertStable(folderBefore, await measureFiles(), `Files current folder settled ${width}px`)

        const folderOptions = page.getByRole('button', { name: 'Options for Reports' })
        await folderOptions.focus()
        const folderBeforeError = await measureFiles()
        await page.evaluate(() => {
          window.__permissionStatusGeometry?.setPermissionMode('folder-active', 'error')
          window.__permissionStatusGeometry?.startAffordanceRefetch('files', 'folder-active')
        })
        const folderDialog = page.getByRole('alertdialog', {
          name: 'Could not verify EvenDrive permissions',
        })
        await folderDialog.waitFor()
        expect(await page.getByRole('alertdialog').count()).toBe(1)
        expect(await folderDialog.getAttribute('aria-modal')).toBe('true')
        const folderDialogRect = await folderDialog.boundingBox()
        expect(folderDialogRect).toBeTruthy()
        expect(
          Math.abs(folderDialogRect!.x + folderDialogRect!.width / 2 - width / 2)
        ).toBeLessThanOrEqual(1)
        expect(
          Math.abs(folderDialogRect!.y + folderDialogRect!.height / 2 - 450)
        ).toBeLessThanOrEqual(1)
        assertStable(
          folderBeforeError,
          await measureFiles(),
          `Files folder error overlay ${width}px`
        )
        expect(
          await page
            .getByRole('button', { name: 'Close' })
            .evaluate(button => button === document.activeElement)
        ).toBe(true)
        await page.keyboard.press('Escape')
        await folderDialog.waitFor({ state: 'detached' })
        expect(
          await page.evaluate(() =>
            (document.activeElement as HTMLElement | null)?.getAttribute('aria-label')
          )
        ).toBe('Options for Reports')
        assertStable(
          folderBeforeError,
          await measureFiles(),
          `Files folder error dismissed ${width}px`
        )

        const rowBefore = await measureFiles()
        await page.evaluate(() => {
          window.__permissionStatusGeometry?.setPermissionMode('child-report', 'pending')
          window.__permissionStatusGeometry?.startAffordanceRefetch('files', 'child-report')
        })
        await page.waitForFunction(
          () =>
            window.__permissionStatusGeometry?.filesClient
              .getQueryCache()
              .getAll()
              .some(
                query =>
                  query.queryKey.includes('child-report') && query.state.fetchStatus === 'fetching'
              ),
          undefined,
          { timeout: 5000 }
        )
        const activeRowIndicatorCount = await page
          .locator('.da-gfs-drive__grid .da-gfs-list__name .da-permission-status-indicator')
          .count()
        expect({ rowStatusSlotCount, activeRowIndicatorCount }).toEqual({
          rowStatusSlotCount: 0,
          activeRowIndicatorCount: 0,
        })
        assertStable(rowBefore, await measureFiles(), `Files child row ${width}px`)
        await page.evaluate(() =>
          window.__permissionStatusGeometry?.settlePermission('child-report', 'success')
        )
        await page.waitForFunction(
          () => !document.querySelector('.da-gfs-drive__grid .da-permission-status-indicator')
        )
        expect(
          await page
            .locator('.da-gfs-drive__grid .da-gfs-list__name > .da-permission-status-slot')
            .count()
        ).toBe(0)
        assertStable(rowBefore, await measureFiles(), `Files child row settled ${width}px`)
      }

      const rowOptions = page.getByRole('button', { name: 'Options for report.txt' })
      await rowOptions.focus()
      await rowOptions.press('Enter')
      await page.getByRole('menu', { name: 'Actions for report.txt' }).waitFor()
      const rowBeforeError = await measureFiles()
      await page.evaluate(() => {
        window.__permissionStatusGeometry?.setPermissionMode('child-report', 'error')
        window.__permissionStatusGeometry?.startAffordanceRefetch('files', 'child-report')
      })
      const filesDialog = page.getByRole('alertdialog', {
        name: 'Could not verify EvenDrive permissions',
      })
      await filesDialog.waitFor()
      expect(await page.getByRole('alertdialog').count()).toBe(1)
      expect(
        await page.locator('.da-gfs-drive__grid .da-permission-status-indicator').count()
      ).toBe(0)
      expect(await page.locator('.da-gfs-drive__grid .da-permission-status-slot').count()).toBe(0)
      expect(await filesDialog.getAttribute('aria-modal')).toBe('true')
      const filesDialogRect = await filesDialog.boundingBox()
      expect(filesDialogRect).toBeTruthy()
      expect(Math.abs(filesDialogRect!.x + filesDialogRect!.width / 2 - 195)).toBeLessThanOrEqual(1)
      expect(Math.abs(filesDialogRect!.y + filesDialogRect!.height / 2 - 450)).toBeLessThanOrEqual(
        1
      )
      assertStable(rowBeforeError, await measureFiles(), 'Files row error overlay')
      await page.keyboard.press('Shift+Tab')
      expect(
        await page.evaluate(() => document.activeElement?.closest('[role="alertdialog"]') !== null)
      ).toBe(true)
      await page.keyboard.press('Escape')
      await filesDialog.waitFor({ state: 'detached' })
      await page.getByRole('button', { name: 'Options for report.txt' }).waitFor()
      expect(
        await page.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.getAttribute('aria-label')
        )
      ).toBe('Options for report.txt')
      assertStable(rowBeforeError, await measureFiles(), 'Files row error dismissed')

      await page.goto(
        `http://127.0.0.1:${address.port}/permission-status-geometry.html?deepLink=1&gfsUri=${encodeURIComponent(currentFile.gfsUri)}`
      )
      await page
        .getByRole('heading', { name: 'Current report.txt' })
        .waitFor({ timeout: 5000 })
        .catch(async () => {
          throw new Error(
            `Current-file fixture did not open: ${await page.locator('body').innerText()}`
          )
        })
      const currentTitle = page.locator('.da-gfs-current-file__title-row')
      const currentOrder = () =>
        currentTitle.evaluate(row =>
          Array.from(row.children).map(child => {
            if (child.matches('h3')) return 'filename'
            if (child.querySelector('.da-gfs-resource-menu__trigger')) return 'menu'
            if (child.matches('.da-permission-status-slot')) return 'spinner'
            return 'other'
          })
        )
      const currentSelectors = [
        '.da-gfs-current-file__title-row',
        '.da-gfs-current-file__title-row > .da-permission-status-slot',
        '.da-gfs-current-file__title-row .da-gfs-resource-menu__trigger',
      ]
      const measureCurrent = () => page.evaluate(measureRects, currentSelectors)
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 })
        await assertReservedSlot(
          page,
          '.da-gfs-current-file__title-row > .da-permission-status-slot'
        )
        expect(await currentOrder()).toEqual(['filename', 'menu', 'spinner'])
        const before = await measureCurrent()
        await page.evaluate(id => {
          window.__permissionStatusGeometry?.setPermissionMode(id, 'pending')
          window.__permissionStatusGeometry?.startAffordanceRefetch('files', id)
        }, currentFileId)
        await page
          .getByRole('status', { name: 'Checking permissions for Current report.txt' })
          .waitFor()
        expect(await currentOrder()).toEqual(['filename', 'menu', 'spinner'])
        assertStable(before, await measureCurrent(), `Files current file ${width}px`)
        await page.evaluate(
          id => window.__permissionStatusGeometry?.settlePermission(id, 'success'),
          currentFileId
        )
        await page.waitForFunction(
          () =>
            !document.querySelector(
              '.da-gfs-current-file__title-row .da-permission-status-indicator'
            )
        )
        expect(await currentOrder()).toEqual(['filename', 'menu', 'spinner'])
        assertStable(before, await measureCurrent(), `Files current file settled ${width}px`)
      }

      await page.evaluate(() => window.__permissionStatusGeometry?.setSurface('preview'))
      await page.getByRole('heading', { name: 'diagram.png' }).waitFor()
      const previewOptions = page.getByRole('button', { name: 'Options for diagram.png' })
      const previewSelectors = [
        '.da-gfs-preview-title-row',
        '.da-gfs-preview-title-row > .da-permission-status-slot',
        '.da-gfs-preview-title',
        '.da-gfs-resource-menu__trigger',
        '.da-gfs-image-preview-dialog__body',
      ]
      const measurePreview = () => page.evaluate(measureRects, previewSelectors)
      const previewOrder = await page.locator('.da-gfs-preview-title-row').evaluate(row =>
        Array.from(row.children).map(child => {
          if (child.matches('.da-gfs-preview-title')) return 'filename'
          if (child.querySelector('.da-gfs-resource-menu__trigger')) return 'menu'
          if (child.matches('.da-permission-status-slot')) return 'spinner'
          return 'other'
        })
      )
      expect(previewOrder).toEqual(['filename', 'menu', 'spinner'])
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 })
        await assertReservedSlot(page, '.da-gfs-preview-title-row > .da-permission-status-slot')
        const before = await measurePreview()
        await page.evaluate(() => {
          window.__permissionStatusGeometry?.setPermissionMode('preview-file', 'pending')
          window.__permissionStatusGeometry?.setPermissionMode('preview-parent', 'pending')
          window.__permissionStatusGeometry?.startAffordanceRefetch('preview', 'preview-file')
          window.__permissionStatusGeometry?.startAffordanceRefetch('preview', 'preview-parent')
        })
        await page.getByRole('status', { name: 'Checking file and move permissions' }).waitFor()
        assertStable(before, await measurePreview(), `Preview dual query ${width}px`)
        await page.evaluate(() =>
          window.__permissionStatusGeometry?.settlePermission('preview-file', 'success')
        )
        await page.getByRole('status', { name: 'Checking move permissions' }).waitFor()
        assertStable(before, await measurePreview(), `Preview partial settle ${width}px`)
        await page.evaluate(() =>
          window.__permissionStatusGeometry?.settlePermission('preview-parent', 'success')
        )
        await page.waitForFunction(
          () => !document.querySelector('.da-gfs-preview-title-row .da-permission-status-indicator')
        )
        assertStable(before, await measurePreview(), `Preview settled ${width}px`)

        await previewOptions.focus()
        const beforeError = await measurePreview()
        await page.evaluate(() => {
          window.__permissionStatusGeometry?.setPermissionMode('preview-file', 'error')
          window.__permissionStatusGeometry?.startAffordanceRefetch('preview', 'preview-file')
        })
        const previewDialog = page.getByRole('alertdialog', {
          name: 'Could not verify permissions',
        })
        await previewDialog.waitFor()
        expect(await page.getByRole('alertdialog').count()).toBe(1)
        const previewDialogRect = await previewDialog.boundingBox()
        expect(previewDialogRect).toBeTruthy()
        expect(
          Math.abs(previewDialogRect!.x + previewDialogRect!.width / 2 - width / 2)
        ).toBeLessThanOrEqual(1)
        expect(
          Math.abs(previewDialogRect!.y + previewDialogRect!.height / 2 - 450)
        ).toBeLessThanOrEqual(1)
        assertStable(beforeError, await measurePreview(), `Preview error overlay ${width}px`)
        await page.keyboard.press('Tab')
        expect(
          await page.evaluate(
            () => document.activeElement?.closest('[role="alertdialog"]') !== null
          )
        ).toBe(true)
        expect(
          await page
            .getByRole('button', { name: 'Retry permission check' })
            .evaluate(button => button === document.activeElement)
        ).toBe(true)
        await page.keyboard.press('Shift+Tab')
        expect(
          await page
            .getByRole('button', { name: 'Close' })
            .evaluate(button => button === document.activeElement)
        ).toBe(true)
        await page.keyboard.press('Escape')
        await previewDialog.waitFor({ state: 'detached' })
        expect(
          await page.evaluate(() =>
            (document.activeElement as HTMLElement | null)?.getAttribute('aria-label')
          )
        ).toBe('Options for diagram.png')
        assertStable(beforeError, await measurePreview(), `Preview error dismissed ${width}px`)
        await page.evaluate(() =>
          window.__permissionStatusGeometry?.setPermissionMode('preview-file', 'success')
        )
      }
      console.log('PASS: Chromium geometry stable within 1 CSS px at 1280px and 390px')
    } finally {
      await browser?.close()
      await vite.close()
    }
  }, 120_000)
})
