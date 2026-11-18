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
      server: { host: '127.0.0.1', port: 0, strictPort: false },
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
        childView('child-folder', 'Financial', 'directory', { parentResourceId: 'folder-active' }),
      ])
      const nestedPage = await listChildrenPage([
        childView('nested-folder', 'Quarterly', 'directory', { parentResourceId: 'child-folder' }),
      ])
      const emptyPage = await listChildrenPage([])
      const produceAffordance = appServiceAffordanceProducer(async () =>
        heldPermissionResponse(['read', 'write', 'delete', 'manage_acl', 'share'])
      )
      const successfulAffordances: Record<string, unknown> = {}
      for (const id of [
        'folder-active',
        'source-parent',
        'child-report',
        'child-folder',
        'nested-folder',
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
          nestedPage,
          emptyPage,
          successfulAffordances,
          errorMessages,
        }) => {
          const holdOnLoad = new URLSearchParams(window.location.search).get('holdOnLoad')
          const fixtureResourceIds = new Set(Object.keys(successfulAffordances))
          const modes = new Map<string, 'success' | 'pending' | 'error'>()
          if (holdOnLoad !== null && fixtureResourceIds.has(holdOnLoad)) {
            modes.set(holdOnLoad, 'pending')
          }
          const requireFixtureResource = (id: string) => {
            if (!fixtureResourceIds.has(id)) throw new Error(`Unknown permission fixture: ${id}`)
          }
          const pending = new Map<
            string,
            { resolve: (value: unknown) => void; reject: (error: Error) => void }
          >()
          const pass = <T,>(value: T): T => structuredClone(value)
          const respond = (id: string, success: unknown) => {
            const mode = modes.get(id) ?? 'success'
            if (mode === 'pending') {
              return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
            }
            if (mode === 'error') throw new Error(errorMessages[id])
            return pass(success)
          }
          window.__permissionStatusFixtures = {
            setPermissionMode: (id: string, mode: 'success' | 'pending' | 'error') => {
              requireFixtureResource(id)
              modes.set(id, mode)
            },
            settlePermission: (id: string, result: 'success' | 'error') => {
              requireFixtureResource(id)
              const request = pending.get(id)
              if (!request) throw new Error(`No pending permission request for ${id}`)
              pending.delete(id)
              modes.set(id, result)
              if (result === 'success') request.resolve(pass(successfulAffordances[id]))
              else request.reject(new Error(errorMessages[id]))
            },
          }
          window.clerum = {
            auth: { getSessionGeneration: async () => 0 },
            gfs: {
              listAccessible: async () => pass(rootPage),
              resolve: async (uri: string) => {
                if (uri === folder.gfsUri) return pass(folder)
                if (uri === sourceParent.gfsUri) return pass(sourceParent)
                if (uri === preview.gfsUri) return pass(preview)
                if (uri === previewParent.gfsUri) return pass(previewParent)
                if (uri === currentFile.gfsUri) return pass(currentFile)
                throw new Error(`Unexpected fixture resolve: ${uri}`)
              },
              listChildren: async (id: string) => {
                if (id === 'folder-active') return pass(childrenPage)
                if (id === 'child-folder') return pass(nestedPage)
                if (id === 'nested-folder') return pass(emptyPage)
                throw new Error(`Unexpected folder: ${id}`)
              },
              affordances: async (id: string) => {
                requireFixtureResource(id)
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
          nestedPage,
          emptyPage,
          successfulAffordances,
          errorMessages,
        }
      )
      await page.goto(`http://127.0.0.1:${address.port}/permission-status-geometry.html`, {
        waitUntil: 'domcontentloaded',
      })

      const url = `http://127.0.0.1:${address.port}/permission-status-geometry.html`
      const prototypeKeys = await page.evaluate(() => Object.getOwnPropertyNames(Object.prototype))
      for (const unknown of ['unknown-fixture', '__proto__', 'constructor', 'prototype']) {
        const params = new URLSearchParams({ holdOnLoad: unknown, gfsUri: folder.gfsUri })
        await page.goto(`${url}?${params}`)
        await page.getByRole('button', { name: 'report.txt', exact: true }).waitFor()
        expect(await page.evaluate(() => Object.getOwnPropertyNames(Object.prototype))).toEqual(
          prototypeKeys
        )
        const result = await page.evaluate(async id => {
          const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype)
          let rejected = false
          try {
            window.__permissionStatusFixtures!.setPermissionMode(id, 'pending')
          } catch {
            rejected = true
          }
          const ready = await window.clerum.gfs.affordances('folder-active', 'main')
          const prototypeAfter = Object.getOwnPropertyDescriptors(Object.prototype)
          const keys = Reflect.ownKeys(prototypeBefore)
          return {
            rejected,
            ready: ready.held.includes('read'),
            prototypeUnchanged:
              Reflect.ownKeys(prototypeAfter).length === keys.length &&
              keys.every(key => {
                const before = Reflect.get(prototypeBefore, key)
                const after = Reflect.get(prototypeAfter, key)
                return (
                  after &&
                  before.value === after.value &&
                  before.get === after.get &&
                  before.set === after.set &&
                  before.writable === after.writable &&
                  before.enumerable === after.enumerable &&
                  before.configurable === after.configurable
                )
              }),
          }
        }, unknown)
        expect(result, `rejects unknown fixture mode ID ${unknown}`).toEqual({
          rejected: true,
          ready: true,
          prototypeUnchanged: true,
        })
        expect(
          await page.getByRole('status', { name: 'Checking permissions for Reports' }).count()
        ).toBe(0)
      }

      await page.goto(`${url}?holdOnLoad=folder-active&gfsUri=${encodeURIComponent(folder.gfsUri)}`)
      await page.getByRole('button', { name: 'report.txt', exact: true }).waitFor()
      const coldFolderProgress = page
        .locator('.da-gfs-drive__title-row .da-permission-status-slot')
        .getByRole('status')
      await coldFolderProgress.waitFor()
      expect(
        await coldFolderProgress.getAttribute('aria-label'),
        'permission operation label'
      ).toBe('Checking permissions for Reports')
      expect(
        await page.getByText('Checking permissions for Reports…', { exact: true }).count(),
        'duplicate inline permission progress'
      ).toBe(0)
      await page.evaluate(() =>
        window.__permissionStatusGeometry?.settlePermission('folder-active', 'success')
      )
      await coldFolderProgress.waitFor({ state: 'detached' })
      for (const [surface, resource, title, row, label] of [
        [
          'files',
          'folder-active',
          'Reports',
          '.da-gfs-drive__title-row',
          'Checking permissions for Reports',
        ],
        [
          'preview',
          'preview-file',
          'diagram.png',
          '.da-gfs-preview-title-row',
          'Checking file permissions',
        ],
      ] as const) {
        if (surface === 'preview') {
          await page.goto(`${url}?surface=preview&holdOnLoad=preview-file`)
          const coldPreviewProgress = page
            .locator('.da-gfs-preview-title-row .da-permission-status-slot')
            .getByRole('status')
          await coldPreviewProgress.waitFor()
          expect(
            await coldPreviewProgress.getAttribute('aria-label'),
            'permission operation label'
          ).toBe('Checking file permissions')
          expect(await page.getByText('Checking file permissions…', { exact: true }).count()).toBe(
            0
          )
          await page.evaluate(() =>
            window.__permissionStatusGeometry?.settlePermission('preview-file', 'success')
          )
          await coldPreviewProgress.waitFor({ state: 'detached' })
        }
        const menu = page.getByRole('button', { name: `Options for ${title}` })
        await menu.waitFor()
        const slotSelector = `${row} > .da-permission-status-slot`
        const slot = page.locator(slotSelector)
        const progress = page.getByRole('status', { name: label })
        const selectors = [
          row,
          slotSelector,
          `${row} .da-gfs-resource-menu__trigger`,
          surface === 'files'
            ? '.da-gfs-drive__breadcrumb[aria-current="page"]'
            : '.da-gfs-preview-title',
          surface === 'files' ? '.da-gfs-drive__header' : '.da-gfs-image-preview-dialog__body',
          surface === 'files' ? '.da-gfs-drive__grid' : '.da-gfs-preview-content',
          ...(surface === 'files'
            ? [
                '.da-gfs-drive__grid .da-grid__body .da-grid__row:nth-child(1)',
                '.da-gfs-drive__grid .da-grid__body .da-grid__row:nth-child(2)',
              ]
            : []),
        ]
        const start = async (id: string) => {
          expect(
            await page.evaluate(
              ({ surface, id }) => {
                window.__permissionStatusGeometry?.setPermissionMode(id, 'pending')
                return window.__permissionStatusGeometry?.startAffordanceRefetch(surface, id)
              },
              { surface, id }
            )
          ).toBe(true)
          await page.waitForFunction(
            ({ surface, id }) =>
              (surface === 'files'
                ? window.__permissionStatusGeometry?.filesClient
                : window.__permissionStatusGeometry?.previewClient
              )
                ?.getQueryCache()
                .getAll()
                .some(
                  query => query.queryKey.includes(id) && query.state.fetchStatus === 'fetching'
                ),
            { surface, id }
          )
        }
        const settle = (id: string, result: 'success' | 'error' = 'success') =>
          page.evaluate(
            ({ id, result }) => window.__permissionStatusGeometry?.settlePermission(id, result),
            { id, result }
          )
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 900 })
          await assertReservedSlot(page, slotSelector)
          await progress.waitFor({ state: 'detached' })
          await menu.focus()
          const before = await page.evaluate(measureRects, selectors)
          expect(Object.keys(before)).toHaveLength(selectors.length)
          const liveRegions = page.locator(
            '[role="status"], [aria-live="polite"], [aria-live="assertive"]'
          )
          const baselineRegions = await liveRegions.count()
          await start(resource)
          await slot.getByRole('status').waitFor()
          expect(
            await slot.getByRole('status').getAttribute('aria-label'),
            'permission operation label'
          ).toBe(label)
          expect(await slot.getByRole('status').textContent()).toBe(label)
          const inlinePending =
            surface === 'files' ? 'Checking permissions for Reports…' : 'Checking file permissions…'
          expect(
            await page.getByText(inlinePending, { exact: true }).count(),
            'duplicate inline permission progress'
          ).toBe(0)
          expect(
            await page
              .getByRole('status', { name: /Checking .*permissions|Checking permissions/ })
              .count()
          ).toBe(1)
          expect(await liveRegions.count(), 'single added permission live region').toBe(
            baselineRegions + 1
          )
          expect(
            await slot.evaluate(el => !!el.previousElementSibling?.matches('.da-gfs-resource-menu'))
          ).toBe(true)
          const bounds = await progress.boundingBox()
          expect(bounds).not.toBeNull()
          await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
          expect(await slot.getAttribute('title'), 'native indicator tooltip on slot').toBeNull()
          expect(await slot.locator('[title]').count(), 'native indicator tooltip').toBe(0)
          expect(
            await slot.locator('[role="tooltip"], .da-permission-status-tooltip').count(),
            'custom indicator tooltip'
          ).toBe(0)
          expect(await slot.getAttribute('tabindex'), 'indicator tab stop on slot').toBeNull()
          expect(await slot.locator('[tabindex]').count(), 'indicator tab stop').toBe(0)
          await page.keyboard.press('Tab')
          expect(await slot.evaluate(element => element.contains(document.activeElement))).toBe(
            false
          )
          await menu.focus()
          expect(await menu.evaluate(el => el === document.activeElement)).toBe(true)
          assertStable(
            before,
            await page.evaluate(measureRects, selectors),
            `${surface} active ${width}px`
          )
          await page.emulateMedia({ reducedMotion: 'reduce' })
          const spinner = progress.locator('.da-permission-status-spinner')
          expect(
            await spinner.evaluate(el => getComputedStyle(el).animationName),
            'reduced motion disables the spinner'
          ).toBe('none')
          await page.emulateMedia({ reducedMotion: 'no-preference' })
          expect(await spinner.evaluate(el => getComputedStyle(el).animationName)).toBe(
            'da-permission-status-spin'
          )
          await settle(resource)
          await progress.waitFor({ state: 'detached' })
          expect(await slot.evaluate(el => el.childNodes.length), 'empty inactive indicator').toBe(
            0
          )
          expect(await slot.getAttribute('title'), 'inactive slot tooltip').toBeNull()
          expect(await slot.getAttribute('tabindex'), 'inactive slot tab stop').toBeNull()
          expect(await liveRegions.count()).toBe(baselineRegions)
          expect(await menu.evaluate(el => el === document.activeElement)).toBe(true)
          assertStable(
            before,
            await page.evaluate(measureRects, selectors),
            `${surface} settled ${width}px`
          )
          if (surface === 'files') {
            await start('child-report')
            expect(
              await page.locator('.da-gfs-drive__grid .da-permission-status-slot').count()
            ).toBe(0)
            expect(
              await page.getByText('Checking permissions for report.txt…', { exact: true }).count(),
              'row pending notice'
            ).toBe(0)
            assertStable(
              before,
              await page.evaluate(measureRects, selectors),
              `row pending ${width}px`
            )
            await settle('child-report', 'error')
            const rowError = page.getByText(/Could not verify permissions for report\.txt:/)
            await rowError.waitFor()
            await start('child-report')
            await rowError.waitFor({ state: 'detached' })
            expect(
              await page.getByText('Checking permissions for report.txt…', { exact: true }).count()
            ).toBe(0)
            assertStable(
              before,
              await page.evaluate(measureRects, selectors),
              `row error refetch ${width}px`
            )
            await settle('child-report', width === 390 ? 'success' : 'error')
            if (width === 1280) {
              await rowError.waitFor()
              await start('child-report')
              await settle('child-report')
              await rowError.waitFor({ state: 'detached' })
            }
          } else {
            await start('preview-parent')
            const parentProgress = page.getByRole('status', { name: 'Checking move permissions' })
            await parentProgress.waitFor()
            expect(
              await page.getByText('Checking move permissions…', { exact: true }).count()
            ).toBe(0)
            assertStable(
              before,
              await page.evaluate(measureRects, selectors),
              `parent pending ${width}px`
            )
            await settle('preview-parent')
            await parentProgress.waitFor({ state: 'detached' })
            if (width === 390) {
              await page.clock.setFixedTime(new Date(Date.now() + 16_000))
              await page.evaluate(id => {
                window.__permissionStatusGeometry?.setPermissionMode(id, 'pending')
                window.__permissionStatusGeometry?.setPermissionMode('preview-parent', 'pending')
                window.dispatchEvent(new Event('blur'))
                window.dispatchEvent(new Event('focus'))
              }, resource)
              await page.waitForFunction(
                id =>
                  window.__permissionStatusGeometry?.previewClient
                    .getQueryCache()
                    .getAll()
                    .filter(
                      query =>
                        query.queryKey.includes('affordances') &&
                        (query.queryKey.includes(id) ||
                          query.queryKey.includes('preview-parent')) &&
                        query.state.fetchStatus === 'fetching'
                    ).length === 2,
                resource
              )
              await progress.waitFor()
              expect(await parentProgress.count()).toBe(0)
              await settle(resource, 'error')
              await parentProgress.waitFor()
              const retry = page.getByRole('button', { name: 'Retry permission check' })
              await retry.waitFor()
              expect(await page.getByText(/Could not verify file permissions:/).count()).toBe(1)
              await settle('preview-parent')
              await parentProgress.waitFor({ state: 'detached' })
              expect(await retry.count()).toBe(1)
            }
          }
        }
      }
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
        '.da-gfs-current-file__title-row h3',
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
      await page.goto(`${url}?gfsUri=${encodeURIComponent(folder.gfsUri)}`)
      const rootOptions = page.getByRole('button', { name: 'Options for Reports' })
      const crumbEditor = page
        .getByRole('navigation', { name: 'File location' })
        .getByRole('textbox', { name: 'New name' })
      const titleSlot = '.da-gfs-drive__title-row > .da-permission-status-slot'
      const assertRenameGeometry = async (id: string, title: string) => {
        const anchorSelectors = [
          '.da-gfs-drive__breadcrumbs input',
          '.da-gfs-drive__header',
          '.da-gfs-drive__title-row',
          titleSlot,
          ...(id === 'nested-folder'
            ? [
                '.da-gfs-drive__breadcrumbs [aria-current="page"]',
                '.da-gfs-drive__title-row .da-gfs-resource-menu__trigger',
              ]
            : []),
        ]
        await crumbEditor.waitFor()
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 900 })
          await crumbEditor.focus()
          const before = await page.evaluate(measureRects, anchorSelectors)
          expect(Object.keys(before)).toHaveLength(anchorSelectors.length)
          await page.evaluate(id => {
            window.__permissionStatusGeometry?.setPermissionMode(id, 'pending')
            window.__permissionStatusGeometry?.startAffordanceRefetch('files', id)
          }, id)
          const status = page.getByRole('status', { name: `Checking permissions for ${title}` })
          await status.waitFor()
          expect(await page.locator(titleSlot).getByRole('status').count()).toBe(1)
          expect(await crumbEditor.evaluate(el => el === document.activeElement)).toBe(true)
          assertStable(
            before,
            await page.evaluate(measureRects, anchorSelectors),
            `Rename ${title} ${width}px`
          )
          await page.evaluate(
            id => window.__permissionStatusGeometry?.settlePermission(id, 'success'),
            id
          )
          await status.waitFor({ state: 'detached' })
          expect(await crumbEditor.evaluate(el => el === document.activeElement)).toBe(true)
          assertStable(
            before,
            await page.evaluate(measureRects, anchorSelectors),
            `Rename settled ${title} ${width}px`
          )
        }
      }
      await rootOptions.press('Enter')
      await page.getByRole('menuitem', { name: 'Rename' }).press('Enter')
      await assertRenameGeometry('folder-active', 'Reports')
      await crumbEditor.press('Escape')
      const rowOptions = page.getByRole('button', { name: 'Options for Financial' })
      await rowOptions.press('Enter')
      await page.getByRole('menuitem', { name: 'Rename' }).press('Enter')
      await page.getByRole('textbox', { name: 'New name' }).waitFor()
      await rowOptions.press('Enter')
      await page.getByRole('menuitem', { name: 'Open folder' }).press('Enter')
      await page.getByRole('button', { name: 'Quarterly', exact: true }).press('Enter')
      await page.getByRole('button', { name: 'Options for Quarterly' }).waitFor()
      expect(
        await page
          .locator(titleSlot)
          .evaluate(el => !!el.previousElementSibling?.matches('.da-gfs-resource-menu'))
      ).toBe(true)
      await assertRenameGeometry('nested-folder', 'Quarterly')
    } finally {
      await browser?.close()
      await vite.close()
    }
  }, 120_000)
})
