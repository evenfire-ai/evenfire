import { type ElectronApplication, type Locator, type Page, expect, test } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { assertGfsFixtureCleaned } from '../../../tests/e2e/gfsFixtureCleanupAssertions'
import { uniqueGfsFixtureName } from '../../../tests/e2e/gfsFixtureCore'
import {
  cleanupGfsFixture,
  countGfsLiveChildrenByName,
  getGfsChildResourceSummary,
  seedGfsDirectoryFixture,
  seedGfsGrant,
} from '../../../tests/e2e/gfsResourceFixtures'
import { getE2EUserId } from '../../../tests/e2e/gfsUserTeamFixtures'
import {
  COMPOSER_MAX_FILE_BYTES,
  COMPOSER_MAX_IMAGE_BYTES,
} from '../../ui/src/constants/attachments'
import {
  FIXTURE_RESPONSE_KIND,
  IMAGE_CAPABILITY_FIXTURE_MODELS,
  type ImageCapabilitiesFixtureEnv,
  appendedAttempts,
  readImageCapabilityEvidence,
  requireImageCapabilitiesFixtureEnv,
  resolveImageCapabilitiesMode,
  sha256Hex,
} from './helpers/imageCapabilityEvidence'
import { buildImageFixture, encodePng } from './helpers/qaRecorderImageFixture'
import { openResourcesNavItem } from './navigationHelpers'
import {
  EXTERNAL_REST_API_BASE_URL,
  assertAllowedTarget,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
} from './qa-recorder-helpers'

/*
 * E2E_GUARDIAN_IPC_FLOW: Desktop chat, the model catalog, the agent list, the
 * composer and the Files browser all travel over Electron IPC, so the renderer
 * has no HTTP request to await for any transition in this journey. The visible
 * oracles are the composer chips, the sent bubble, the progress stepper and the
 * Files rows; the business oracles are the GFS child rows, the Desktop download
 * bytes, and the provider-boundary ledger of the derived fixture.
 *
 * An image and a binary file attached to the current chat message are saved by
 * the agent into a seeded EvenDrive folder, named by the folder name the user
 * sees. The fixture discovers the folder through the real
 * `clerum__gfs_accessible` tool, saves through `clerum__gfs_save_attachment`,
 * and answers with a fixed marker. Only the external provider peer is
 * simulated; the Host, gfsc and storage are real. The fixed directive in the
 * prompt stands in for the model's reading of a natural-language request and
 * carries only the folder name.
 */

const MODE = resolveImageCapabilitiesMode()

/** Fixed answers of the fixture, without underscores so Markdown keeps them whole. */
const SAVE_ANSWER_SUCCESS = 'SAVE-ANSWER success'
const SAVE_ANSWER_FAILURE = 'SAVE-ANSWER failure'
const SAVE_TOOL_ABSENT = 'SAVE-TOOL-ABSENT'

/** Host subject of this lane's Host (`mcp-host/chatllm`), as grants name it. */
const journeyHostSubjectId = '1st:mcp-host/chatllm'

function composer(page: Page) {
  return page.getByRole('textbox', { name: 'Agent message composer' })
}

function sendButton(page: Page) {
  return page.getByTestId('send-button')
}

function modelChip(page: Page) {
  return page.getByTestId('selected-chat-model')
}

function fileChips(page: Page) {
  return page.getByTestId('composer-file-chip')
}

/**
 * The attachment items a sent message renders (`MessageAttachmentList`). The
 * items are counted, not the list container, so a second file in one list fails.
 */
function sentMessageAttachments(page: Page) {
  return page.getByLabel('Message attachments').locator('.message-attachment-chip')
}

/** Start a blank chat and prove the thread is empty before anything is sent. */
async function startBlankChat(page: Page) {
  await page.getByTestId('nav-new-chat').click()
  await expect(composer(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-chat-message-id]')).toHaveCount(0, { timeout: 20_000 })
}

/**
 * Land on the exact configured agent through the visible Switch chat agent
 * menu, and trust the composer only once the switch control reports it.
 */
async function openConfiguredAgentChat(page: Page, hostRef: string) {
  const escaped = hostRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await page.getByTestId('nav-chat').click()
  const switchAgent = page.getByRole('button', { name: 'Switch chat agent' })
  await expect(switchAgent).toBeVisible({ timeout: 30_000 })
  await switchAgent.click()
  const agentMenuItem = page.getByRole('menuitem', { name: new RegExp(`^${escaped}$`, 'i') })
  await expect(agentMenuItem).toHaveCount(1)
  await agentMenuItem.click()
  await expect(switchAgent).toContainText(new RegExp(escaped, 'i'))
}

/** Selects the model through the visible popover and asserts the chip reports it. */
async function selectSupportedModel(page: Page, model: string) {
  await expect(modelChip(page)).toBeVisible({ timeout: 30_000 })
  await modelChip(page).click()
  const menu = page.getByRole('menu', { name: 'Select model' })
  await expect(menu).toBeVisible({ timeout: 20_000 })
  const row = page.getByTestId(`model-option-${model}`)
  await expect(row).toHaveCount(1)
  await row.click()
  await expect(modelChip(page)).toHaveAttribute('data-model-id', model)
}

/**
 * Reach the authenticated shell through the real form. While the form is still
 * unsent, the authenticated surface must not be mounted, otherwise the journey
 * could pass without a real sign-in.
 */
async function signIn(page: Page) {
  await expect(page.locator('.boot-overlay')).toBeHidden({ timeout: 30_000 })

  const emailInput = page.locator('#email-input')
  const settingsMenu = page.getByTestId('nav-settings-menu')
  await expect(emailInput.or(settingsMenu)).toBeVisible({ timeout: 30_000 })
  if (await settingsMenu.isVisible()) {
    if ((await settingsMenu.getAttribute('aria-expanded')) !== 'true') {
      await settingsMenu.click()
    }
    await expect(settingsMenu).toHaveAttribute('aria-expanded', 'true')
    await page.getByTestId('logout-btn').click()
  }

  await expect(emailInput).toBeVisible({ timeout: 20_000 })
  await expect(composer(page)).toHaveCount(0)
  await expect(sendButton(page)).toHaveCount(0)
  await expect(page.getByTestId('nav-chat')).toHaveCount(0)

  await login(page, desktopCredentials())
  await expect(page.getByTestId('nav-chat')).toBeVisible({ timeout: 30_000 })
}

/** Attach a document the way a user does: Add context -> Upload Files -> native picker. */
async function attachDocument(
  page: Page,
  document: { fileName: string; mimeType: string; buffer: Buffer }
) {
  const attachButton = page.getByRole('button', { name: 'Add context' })
  await expect(attachButton).toBeEnabled()
  await attachButton.click()
  const uploadItem = page.getByRole('menuitem', { name: 'Upload Files' })
  await expect(uploadItem).toBeEnabled({ timeout: 15_000 })

  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15_000 }),
    uploadItem.click(),
  ])
  await fileChooser.setFiles({
    name: document.fileName,
    mimeType: document.mimeType,
    buffer: document.buffer,
  })
}

/*
 * The stepper is asserted only for `gfs_save_attachment`. The Host's progress
 * reporter does not replay tool events to a subscriber that arrives after them
 * (`mcp-host/src/progress/sseProgressReporter.ts` replays terminal and suspended
 * only), and Desktop subscribes after the send returns the task id. The fixture
 * answers in milliseconds, so the discovery call can finish before the stream
 * opens and never reach the stepper. Discovery is proven by the ledger instead:
 * the fixture requests the save only after it parsed a successful
 * `clerum__gfs_accessible` result.
 */
/** Side of the large PNG: 1000x1000 random RGB pixels, about 2.86 MiB once encoded. */
const LARGE_PNG_SIDE = 1000
/** Size of the large binary attachment, well over a single chunk of any hop. */
const LARGE_BINARY_BYTES = 6 * 1024 * 1024

/**
 * A PNG of random pixels. Deflate cannot shrink random data, so the file stays
 * close to its raw size and lands just under the general per-image composer cap
 * that GLM-5.3-Flash uses, the model this lane runs on.
 */
function buildLargePng(): Buffer {
  const pixels = randomBytes(LARGE_PNG_SIDE * LARGE_PNG_SIDE * 3)
  const png = encodePng(LARGE_PNG_SIDE, LARGE_PNG_SIDE, (x, y) => {
    const offset = (y * LARGE_PNG_SIDE + x) * 3
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2]]
  })
  if (png.length <= 2 * 1024 * 1024 || png.length >= COMPOSER_MAX_IMAGE_BYTES) {
    throw new Error(
      `large PNG fixture is ${png.length} bytes; it must be over 2 MiB and under ` +
        `the ${COMPOSER_MAX_IMAGE_BYTES}-byte composer image cap`
    )
  }
  return png
}

const SENSITIVE_OUTPUT =
  /\/data\/gfs|\/mnt\/|\.generations|blob_key|blobKey|\bSQL\b|internal (?:path|error)|stack trace/i

function toolRow(stepper: Locator, name: string): Locator {
  return stepper.locator('.stepper-step').filter({ hasText: name }).last()
}

async function expectToolSuccess(stepper: Locator, name: string): Promise<void> {
  const row = toolRow(stepper, name)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.locator('.stepper-step-fn')).toContainText(name)
  await expect(row.locator('.stepper-step-duration.state-error')).toHaveCount(0)
}

async function expectToolForbidden(stepper: Locator, name: string): Promise<void> {
  const row = toolRow(stepper, name)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.locator('.stepper-step-fn')).toContainText(name)
  await expect(row.locator('.stepper-step-duration.state-error')).toContainText(
    /gfsc 403.*forbidden/i
  )
  await expect(row).not.toContainText(/gfsc 503|not_mounted/i)
  await expect(stepper).not.toContainText(SENSITIVE_OUTPUT)
}

/**
 * Open Files and enter the named folder. Navigation only: the folder's own
 * listing is the signal; no manage dialog is opened.
 */
async function browseToFolder(page: Page, folderName: string): Promise<{ browser: Locator }> {
  /*
   * E2E_GUARDIAN_IPC_FLOW: Desktop GFS discovery is brokered through the
   * main-process `window.clerum.gfs.listAccessible` bridge, so the renderer
   * has no HTTP response to await for this transition. The Files heading,
   * browser region, and seeded folder row are the visible/business signals.
   */
  const filesHeading = page.getByRole('heading', { name: 'Files', exact: true })
  const openFilesAttempt = async (timeout: number): Promise<void> => {
    await openResourcesNavItem(page, 'nav-files')
    await expect(filesHeading).toBeVisible({ timeout })
    await expect(page.getByRole('region', { name: 'EvenDrive browser' })).toBeVisible({
      timeout,
    })
  }

  try {
    await openFilesAttempt(15_000)
  } catch (firstNavigationError) {
    // The authenticated Desktop shell can finish its initial data refresh just
    // after the first visible menu click and restore Chat. Retry the same user
    // action once, bounded by the Files heading and its GFS request, instead of
    // hiding the race behind a fixed sleep or navigating directly to a terminal
    // route.
    try {
      await openFilesAttempt(30_000)
    } catch {
      throw firstNavigationError
    }
  }
  const browser = page.getByRole('region', { name: 'EvenDrive browser' })
  await expect(browser.getByRole('button', { name: folderName, exact: true })).toBeVisible({
    timeout: 60_000,
  })
  await browser.getByRole('button', { name: folderName, exact: true }).click()
  await expect(browser).toBeVisible({ timeout: 30_000 })
  // The active crumb stays enabled as a drop target and is marked as the
  // current location (desktop-app/ui/src/pages/FilesPage.tsx, 2e63a7604).
  await expect(
    browser
      .getByRole('navigation', { name: 'File location' })
      .getByRole('button', { name: folderName, exact: true })
  ).toHaveAttribute('aria-current', 'page', { timeout: 30_000 })
  return { browser }
}

function fileResourceControls(browser: Locator, resourceName: string) {
  return {
    name: browser.getByRole('button', { name: resourceName, exact: true }),
    options: browser.getByRole('button', {
      name: `Options for ${resourceName}`,
      exact: true,
    }),
    download: browser.getByRole('button', {
      name: `Download ${resourceName}`,
      exact: true,
    }),
  }
}

async function installGfsDownloadCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    type CapturedGfsDownload = {
      filename: string
      blob: Blob
    }
    const win = window as Window & {
      __clerumE2eGfsDownloads?: CapturedGfsDownload[]
      __clerumE2eGfsDownloadCaptureInstalled?: boolean
    }
    if (win.__clerumE2eGfsDownloadCaptureInstalled) return
    win.__clerumE2eGfsDownloadCaptureInstalled = true
    win.__clerumE2eGfsDownloads = []

    // Observe the Blob produced from the real preload/IPC response while
    // preserving both production APIs. This does not replace or mock GFS.
    const blobByUrl = new Map<string, Blob>()
    const originalCreateObjectURL = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = originalCreateObjectURL(object)
      if (object instanceof Blob) blobByUrl.set(url, object)
      return url
    }

    const originalAnchorClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      const filename = this.download
      const blob = blobByUrl.get(this.href)
      if (filename && blob) win.__clerumE2eGfsDownloads?.push({ filename, blob })
      return originalAnchorClick.call(this)
    }
  })
}

async function hashCapturedGfsDownload(
  page: Page,
  filename: string,
  bytes: number
): Promise<string> {
  const hash = createHash('sha256')
  const chunkBytes = 8 * 1024 * 1024
  for (let offset = 0; offset < bytes; offset += chunkBytes) {
    const encoded = await page.evaluate(
      async ({ filenameToFind, start, end }) => {
        const downloads =
          (
            window as Window & {
              __clerumE2eGfsDownloads?: Array<{ filename: string; blob: Blob }>
            }
          ).__clerumE2eGfsDownloads ?? []
        const download = downloads.find(item => item.filename === filenameToFind)
        if (!download) throw new Error(`captured GFS download not found: ${filenameToFind}`)
        const chunk = new Uint8Array(await download.blob.slice(start, end).arrayBuffer())
        let binary = ''
        for (let index = 0; index < chunk.length; index += 0x8000) {
          binary += String.fromCharCode(...chunk.subarray(index, index + 0x8000))
        }
        return btoa(binary)
      },
      { filenameToFind: filename, start: offset, end: Math.min(bytes, offset + chunkBytes) }
    )
    hash.update(Buffer.from(encoded, 'base64'))
  }
  return hash.digest('hex')
}

async function expectGfsDownload(
  page: Page,
  controls: ReturnType<typeof fileResourceControls>,
  filename: string,
  expected: { bytes: number; sha256: string }
): Promise<void> {
  await installGfsDownloadCapture(page)
  // Row actions stay hidden and ignore the pointer until the row is hovered
  // (`.da-gfs-drive__grid .da-gfs-list__actions` in styles.css), as for a user.
  await controls.name.hover()
  await controls.download.click()
  await expect(page.getByText(`Downloaded ${filename}`, { exact: true })).toBeVisible({
    timeout: 300_000,
  })
  await expect
    .poll(
      () =>
        page.evaluate(filenameToFind => {
          const downloads =
            (
              window as Window & {
                __clerumE2eGfsDownloads?: Array<{
                  filename: string
                  blob: Blob
                }>
              }
            ).__clerumE2eGfsDownloads ?? []
          const download = downloads.find(item => item.filename === filenameToFind)
          return download ? { filename: download.filename, bytes: download.blob.size } : null
        }, filename),
      {
        timeout: 300_000,
        intervals: [100, 500, 1_000],
        message: `Desktop should expose the real GFS IPC bytes for ${filename}`,
      }
    )
    .toEqual({ filename, bytes: expected.bytes })
  expect(await hashCapturedGfsDownload(page, filename, expected.bytes)).toBe(expected.sha256)
}

test.describe('attachment-gfs-save fixture', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(
    MODE !== 'fixture',
    'Set IMAGE_CAPABILITIES_RUN_ID=image-capabilities-<12 hex> (the runner does) to run the ' +
      'derived-provider fixture journey.'
  )

  let app: ElectronApplication | undefined
  let page!: Page
  let env!: ImageCapabilitiesFixtureEnv
  let fixtureName: string | undefined

  test.beforeAll(async ({}, testInfo) => {
    env = requireImageCapabilitiesFixtureEnv()
    await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', env.externalRestApiBaseUrl)
    await assertAllowedTarget('RPC_PROXY_BASE_URL', env.rpcProxyBaseUrl)

    // Precondition read before anything is sent: the derived fixture must be
    // live in the deployment that serves this host, for this run and profile.
    const baseline = readImageCapabilityEvidence(env)
    expect(baseline.runId).toBe(env.runId)
    expect(baseline.profile).toBe(env.profile)

    // One launch and one sign-in for the whole lane: the password admission
    // limit is five attempts per identity in fifteen minutes.
    const launched = await launchDesktopApp(
      testInfo,
      `attachment-gfs-save-minikube${new URL(EXTERNAL_REST_API_BASE_URL).port}`
    )
    app = launched.app
    page = launched.page
    await signIn(page)
    await openConfiguredAgentChat(page, env.hostRef)
  })

  test.afterAll(async () => {
    await finalizeRecording(app, page)
  })

  test.afterEach(() => {
    if (!fixtureName) return
    const name = fixtureName
    fixtureName = undefined
    cleanupGfsFixture(name)
    assertGfsFixtureCleaned(name)
  })

  test('attachment-gfs-save fixture: saves an attached PNG byte for byte', async () => {
    const png = buildLargePng()
    const fileName = `logo-${randomBytes(3).toString('hex')}.png`
    fixtureName = uniqueGfsFixtureName('e2e-gfs-save-png')
    const folder = seedGfsDirectoryFixture(fixtureName)
    seedGfsGrant({
      resourceId: folder.resourceId,
      subjectType: 'user',
      subjectId: getE2EUserId(),
      permissions: ['read'],
      inherit: true,
      grantedBy: 'e2e:attachment-gfs-save',
    })
    seedGfsGrant({
      resourceId: folder.resourceId,
      subjectType: 'host',
      subjectId: journeyHostSubjectId,
      permissions: ['read', 'write'],
      inherit: true,
      grantedBy: 'e2e:attachment-gfs-save',
    })
    expect(
      countGfsLiveChildrenByName({ parentResourceId: folder.resourceId, name: fileName })
    ).toBe(0)
    const before = readImageCapabilityEvidence(env)

    await test.step('the destination folder is visible without the file', async () => {
      const { browser } = await browseToFolder(page, folder.name)
      // Witness: the listing loaded (the seeded child is there) before the absence is read.
      await expect(fileResourceControls(browser, folder.childName).name).toBeVisible()
      await expect(fileResourceControls(browser, fileName).name).toHaveCount(0)
    })
    await test.step('attach the image through the composer picker', async () => {
      await startBlankChat(page)
      await selectSupportedModel(page, IMAGE_CAPABILITY_FIXTURE_MODELS.supported)
      await attachDocument(page, { fileName, mimeType: 'image/png', buffer: png })
      await expect(
        page.locator('.composer-attachment-chip').filter({ hasText: fileName })
      ).toBeVisible()
    })
    const progressIndex = await page.getByTestId('progress-expand-btn').count()
    await test.step('ask the agent to save it by folder name', async () => {
      await composer(page).fill(
        `Save this image to EvenDrive. EVENDRIVE_SAVE folder="${folder.name}" drive=main`
      )
      await sendButton(page).click()
      await expect(sentMessageAttachments(page).filter({ hasText: fileName })).toBeVisible()
      await expect(page.getByText(SAVE_ANSWER_SUCCESS)).toBeVisible({ timeout: 60_000 })
    })
    await test.step('the save ran without error', async () => {
      const expand = page.getByTestId('progress-expand-btn').nth(progressIndex)
      await expand.click()
      await expectToolSuccess(expand.locator('..'), 'gfs_save_attachment')
    })
    await test.step('business signal: one file with the same length in GFS', async () => {
      await expect
        .poll(
          () => getGfsChildResourceSummary({ parentResourceId: folder.resourceId, name: fileName }),
          { timeout: 30_000 }
        )
        .toMatchObject({ kind: 'file', bytes: png.length, deleted: false })
      expect(
        countGfsLiveChildrenByName({ parentResourceId: folder.resourceId, name: fileName })
      ).toBe(1)
    })
    await test.step('business signal: Files shows it and downloads the same bytes', async () => {
      const { browser } = await browseToFolder(page, folder.name)
      const controls = fileResourceControls(browser, fileName)
      await expect(controls.name).toBeVisible()
      await expectGfsDownload(page, controls, fileName, {
        bytes: png.length,
        sha256: sha256Hex(png),
      })
    })
    await test.step('ledger: one discovery, one save, one successful answer, no rejection', async () => {
      const appended = appendedAttempts(before, readImageCapabilityEvidence(env))
      const kinds = appended.map(row => row.responseKind)
      expect(
        kinds.filter(k => k === FIXTURE_RESPONSE_KIND.attachmentSaveDiscoveryRequested)
      ).toHaveLength(1)
      expect(kinds.filter(k => k === FIXTURE_RESPONSE_KIND.attachmentSaveRequested)).toHaveLength(1)
      const answers = appended.filter(
        row => row.responseKind === FIXTURE_RESPONSE_KIND.attachmentSaveAnswer
      )
      expect(answers.map(row => row.saveOutcome)).toEqual(['success'])
      expect(kinds.filter(k => k === FIXTURE_RESPONSE_KIND.rejected)).toHaveLength(0)
    })
  })

  test('attachment-gfs-save fixture: saves an attached binary byte for byte', async () => {
    expect(LARGE_BINARY_BYTES).toBeLessThan(COMPOSER_MAX_FILE_BYTES)
    const blob = randomBytes(LARGE_BINARY_BYTES)
    const fileName = `blob-${randomBytes(3).toString('hex')}.bin`
    fixtureName = uniqueGfsFixtureName('e2e-gfs-save-bin')
    const folder = seedGfsDirectoryFixture(fixtureName)
    seedGfsGrant({
      resourceId: folder.resourceId,
      subjectType: 'user',
      subjectId: getE2EUserId(),
      permissions: ['read'],
      inherit: true,
      grantedBy: 'e2e:attachment-gfs-save',
    })
    seedGfsGrant({
      resourceId: folder.resourceId,
      subjectType: 'host',
      subjectId: journeyHostSubjectId,
      permissions: ['read', 'write'],
      inherit: true,
      grantedBy: 'e2e:attachment-gfs-save',
    })
    expect(
      countGfsLiveChildrenByName({ parentResourceId: folder.resourceId, name: fileName })
    ).toBe(0)
    const before = readImageCapabilityEvidence(env)

    await test.step('the destination folder is visible without the file', async () => {
      const { browser } = await browseToFolder(page, folder.name)
      // Witness: the listing loaded (the seeded child is there) before the absence is read.
      await expect(fileResourceControls(browser, folder.childName).name).toBeVisible()
      await expect(fileResourceControls(browser, fileName).name).toHaveCount(0)
    })
    await test.step('attach the binary through the composer picker', async () => {
      await startBlankChat(page)
      await selectSupportedModel(page, IMAGE_CAPABILITY_FIXTURE_MODELS.supported)
      await attachDocument(page, { fileName, mimeType: 'application/octet-stream', buffer: blob })
      const chip = fileChips(page).filter({ hasText: fileName })
      await expect(chip).toHaveCount(1, { timeout: 20_000 })
      await expect(chip).toHaveAttribute('data-file-status', 'ready', { timeout: 20_000 })
    })
    const progressIndex = await page.getByTestId('progress-expand-btn').count()
    await test.step('ask the agent to save it by folder name', async () => {
      await composer(page).fill(
        `Save this file to EvenDrive. EVENDRIVE_SAVE folder="${folder.name}" drive=main`
      )
      await sendButton(page).click()
      await expect(sentMessageAttachments(page).filter({ hasText: fileName })).toBeVisible()
      await expect(page.getByText(SAVE_ANSWER_SUCCESS)).toBeVisible({ timeout: 60_000 })
    })
    await test.step('the save ran without error', async () => {
      const expand = page.getByTestId('progress-expand-btn').nth(progressIndex)
      await expand.click()
      await expectToolSuccess(expand.locator('..'), 'gfs_save_attachment')
    })
    await test.step('business signal: one file with the same length in GFS', async () => {
      await expect
        .poll(
          () => getGfsChildResourceSummary({ parentResourceId: folder.resourceId, name: fileName }),
          { timeout: 30_000 }
        )
        .toMatchObject({ kind: 'file', bytes: blob.length, deleted: false })
      expect(
        countGfsLiveChildrenByName({ parentResourceId: folder.resourceId, name: fileName })
      ).toBe(1)
    })
    await test.step('business signal: Files shows it and downloads the same bytes', async () => {
      const { browser } = await browseToFolder(page, folder.name)
      const controls = fileResourceControls(browser, fileName)
      await expect(controls.name).toBeVisible()
      await expectGfsDownload(page, controls, fileName, {
        bytes: blob.length,
        sha256: sha256Hex(blob),
      })
    })
    await test.step('ledger: one discovery, one save, one successful answer, no rejection', async () => {
      const appended = appendedAttempts(before, readImageCapabilityEvidence(env))
      const kinds = appended.map(row => row.responseKind)
      expect(
        kinds.filter(k => k === FIXTURE_RESPONSE_KIND.attachmentSaveDiscoveryRequested)
      ).toHaveLength(1)
      expect(kinds.filter(k => k === FIXTURE_RESPONSE_KIND.attachmentSaveRequested)).toHaveLength(1)
      const answers = appended.filter(
        row => row.responseKind === FIXTURE_RESPONSE_KIND.attachmentSaveAnswer
      )
      expect(answers.map(row => row.saveOutcome)).toEqual(['success'])
      expect(kinds.filter(k => k === FIXTURE_RESPONSE_KIND.rejected)).toHaveLength(0)
    })

    // N2: a second turn in the same chat, without an attachment, must not be
    // offered the save tool and must leave the saved file untouched.
    const savedBefore = getGfsChildResourceSummary({
      parentResourceId: folder.resourceId,
      name: fileName,
    })
    expect(savedBefore).toMatchObject({ kind: 'file', bytes: blob.length, deleted: false })
    const beforeTurnTwo = readImageCapabilityEvidence(env)
    let progressBefore = 0
    await test.step('a second turn without an attachment is not offered the save tool', async () => {
      await page.getByTestId('nav-chat').click()
      await expect(composer(page)).toBeVisible({ timeout: 30_000 })
      progressBefore = await page.getByTestId('progress-expand-btn').count()
      // Witness: this turn carries no attachment.
      await expect(fileChips(page)).toHaveCount(0)
      await composer(page).fill(
        `Save it again to EvenDrive. EVENDRIVE_SAVE folder="${folder.name}" drive=main`
      )
      await sendButton(page).click()
      // Witness: the turn ran, with the write tools registered but no save tool.
      await expect(page.getByText(SAVE_TOOL_ABSENT)).toBeVisible({ timeout: 60_000 })
    })
    await test.step('the second turn ran no tool and left the saved file untouched', async () => {
      // A turn without tools draws no stepper, so the count must not move.
      await expect(page.getByTestId('progress-expand-btn')).toHaveCount(progressBefore)
      const appended = appendedAttempts(beforeTurnTwo, readImageCapabilityEvidence(env))
      const kinds = appended.map(row => row.responseKind)
      expect(kinds.filter(k => k === FIXTURE_RESPONSE_KIND.attachmentSaveToolAbsent)).toHaveLength(
        1
      )
      expect(
        kinds.filter(k => k === FIXTURE_RESPONSE_KIND.attachmentSaveDiscoveryRequested)
      ).toHaveLength(0)
      expect(kinds.filter(k => k === FIXTURE_RESPONSE_KIND.attachmentSaveRequested)).toHaveLength(0)
      expect(kinds.filter(k => k === FIXTURE_RESPONSE_KIND.rejected)).toHaveLength(0)
      expect(
        countGfsLiveChildrenByName({ parentResourceId: folder.resourceId, name: fileName })
      ).toBe(1)
      expect(
        getGfsChildResourceSummary({ parentResourceId: folder.resourceId, name: fileName })
      ).toMatchObject({
        kind: 'file',
        bytes: savedBefore!.bytes,
        version: savedBefore!.version,
        deleted: false,
      })
    })
  })

  test('attachment-gfs-save fixture: refuses the save without host write permission', async () => {
    const png = buildImageFixture().png
    const fileName = `logo-${randomBytes(3).toString('hex')}.png`
    fixtureName = uniqueGfsFixtureName('e2e-gfs-save-denied')
    const folder = seedGfsDirectoryFixture(fixtureName)
    seedGfsGrant({
      resourceId: folder.resourceId,
      subjectType: 'user',
      subjectId: getE2EUserId(),
      permissions: ['read'],
      inherit: true,
      grantedBy: 'e2e:attachment-gfs-save',
    })
    seedGfsGrant({
      resourceId: folder.resourceId,
      subjectType: 'host',
      subjectId: journeyHostSubjectId,
      permissions: ['read'],
      inherit: true,
      grantedBy: 'e2e:attachment-gfs-save',
    })
    expect(
      countGfsLiveChildrenByName({ parentResourceId: folder.resourceId, name: fileName })
    ).toBe(0)
    const before = readImageCapabilityEvidence(env)

    await test.step('the destination folder is visible without the file', async () => {
      const { browser } = await browseToFolder(page, folder.name)
      // Witness: the listing loaded (the seeded child is there) before the absence is read.
      await expect(fileResourceControls(browser, folder.childName).name).toBeVisible()
      await expect(fileResourceControls(browser, fileName).name).toHaveCount(0)
    })
    await test.step('attach the image through the composer picker', async () => {
      await startBlankChat(page)
      await selectSupportedModel(page, IMAGE_CAPABILITY_FIXTURE_MODELS.supported)
      await attachDocument(page, { fileName, mimeType: 'image/png', buffer: png })
      await expect(
        page.locator('.composer-attachment-chip').filter({ hasText: fileName })
      ).toBeVisible()
    })
    const progressIndex = await page.getByTestId('progress-expand-btn').count()
    await test.step('ask the agent to save it by folder name', async () => {
      await composer(page).fill(
        `Save this image to EvenDrive. EVENDRIVE_SAVE folder="${folder.name}" drive=main`
      )
      await sendButton(page).click()
      await expect(sentMessageAttachments(page).filter({ hasText: fileName })).toBeVisible()
      await expect(page.getByText(SAVE_ANSWER_FAILURE)).toBeVisible({ timeout: 60_000 })
    })
    await test.step('the save was forbidden', async () => {
      const expand = page.getByTestId('progress-expand-btn').nth(progressIndex)
      await expand.click()
      await expectToolForbidden(expand.locator('..'), 'gfs_save_attachment')
    })
    await test.step('business signal: no file was written', async () => {
      expect(
        countGfsLiveChildrenByName({ parentResourceId: folder.resourceId, name: fileName })
      ).toBe(0)
    })
    await test.step('ledger: one discovery, one save, one forbidden answer, no rejection', async () => {
      const appended = appendedAttempts(before, readImageCapabilityEvidence(env))
      const kinds = appended.map(row => row.responseKind)
      expect(
        kinds.filter(k => k === FIXTURE_RESPONSE_KIND.attachmentSaveDiscoveryRequested)
      ).toHaveLength(1)
      // Witness: the fixture requests the save only after a successful discovery
      // result, so discovery reached gfsc and the denial is the save's own 403.
      expect(kinds.filter(k => k === FIXTURE_RESPONSE_KIND.attachmentSaveRequested)).toHaveLength(1)
      const answers = appended.filter(
        row => row.responseKind === FIXTURE_RESPONSE_KIND.attachmentSaveAnswer
      )
      expect(answers.map(row => row.saveOutcome)).toEqual([
        'GFS mutation failed (gfsc 403: forbidden)',
      ])
      expect(kinds.filter(k => k === FIXTURE_RESPONSE_KIND.rejected)).toHaveLength(0)
    })
  })
})
