import { type ElectronApplication, type Locator, type Page, expect, test } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { assertGfsFixtureCleaned } from '../../../tests/e2e/gfsFixtureCleanupAssertions'
import { uniqueGfsFixtureName } from '../../../tests/e2e/gfsFixtureCore'
import {
  cleanupGfsFixture,
  getGfsChildResourceSummary,
  seedGfsDirectoryFixture,
  seedGfsGrant,
} from '../../../tests/e2e/gfsResourceFixtures'
import { getE2EUserId } from '../../../tests/e2e/gfsUserTeamFixtures'
import {
  FIXTURE_RESPONSE_KIND,
  type FixtureProviderAttempt,
  IMAGE_CAPABILITY_FIXTURE_MODELS,
  type ImageCapabilitiesFixtureEnv,
  type ImageCapabilityEvidenceSnapshot,
  appendedAttempts,
  readImageCapabilityEvidence,
  requireImageCapabilitiesFixtureEnv,
  resolveImageCapabilitiesMode,
  sha256Hex,
} from './helpers/imageCapabilityEvidence'
import { encodePng } from './helpers/qaRecorderImageFixture'
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
 * E2E_GUARDIAN_IPC_FLOW: Desktop chat, the composer, the approval card and the
 * Files browser all travel over Electron IPC, so the renderer has no HTTP
 * request to await for any transition here. The visible oracles are the sent
 * bubble, the fixture's answer, the approval card and the Files rows; the
 * business oracles are the GFS rows, the files the Desktop downloads write to
 * disk, the generated files Desktop reads through the same bridge as its
 * artifact list (`ArtifactsBadge`), and the provider-boundary ledger.
 *
 * Every turn carries a fixed `GFS_FILES step=...` directive with quoted names
 * and ids, which stands in for the model's reading of a natural-language
 * request. The fixture runs the step's tool calls against the real Host: the
 * generators, the GFS write tools with their file sources, the kept-files
 * listing and delete, `file_write` and the partial edit. Only the external
 * provider peer is simulated; the Host, gfsc and storage are real. The journeys
 * run in order for one Desktop user, and journey 7 counts on the files the
 * earlier journeys left.
 */

const MODE = resolveImageCapabilitiesMode()

/** Host subject of this lane's Host (`mcp-host/chatllm`), as grants name it. */
const journeyHostSubjectId = '1st:mcp-host/chatllm'

/** The six formats of the generators, in the fixture's order. */
const GENERATED_EXTENSIONS = ['md', 'docx', 'xlsx', 'pptx', 'pdf', 'png'] as const

const SEEDED_FILES = 100

function composer(page: Page) {
  return page.getByRole('textbox', { name: 'Agent message composer' })
}

function sendButton(page: Page) {
  return page.getByTestId('send-button')
}

function modelChip(page: Page) {
  return page.getByTestId('selected-chat-model')
}

function sentMessageAttachments(page: Page) {
  return page.getByLabel('Message attachments').locator('.message-attachment-chip')
}

async function startBlankChat(page: Page) {
  await page.getByTestId('nav-new-chat').click()
  await expect(composer(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-chat-message-id]')).toHaveCount(0, { timeout: 20_000 })
  await expect(modelChip(page)).toBeVisible({ timeout: 30_000 })
  await modelChip(page).click()
  await expect(page.getByRole('menu', { name: 'Select model' })).toBeVisible({ timeout: 20_000 })
  const row = page.getByTestId(`model-option-${IMAGE_CAPABILITY_FIXTURE_MODELS.supported}`)
  await expect(row).toHaveCount(1)
  await row.click()
  await expect(modelChip(page)).toHaveAttribute(
    'data-model-id',
    IMAGE_CAPABILITY_FIXTURE_MODELS.supported
  )
}

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

/** The real sign-in form; the authenticated shell must not be mounted before it. */
async function signIn(page: Page) {
  await expect(page.locator('.boot-overlay')).toBeHidden({ timeout: 30_000 })
  const emailInput = page.locator('#email-input')
  const settingsMenu = page.getByTestId('nav-settings-menu')
  await expect(emailInput.or(settingsMenu)).toBeVisible({ timeout: 30_000 })
  if (await settingsMenu.isVisible()) {
    if ((await settingsMenu.getAttribute('aria-expanded')) !== 'true') await settingsMenu.click()
    await expect(settingsMenu).toHaveAttribute('aria-expanded', 'true')
    await page.getByTestId('logout-btn').click()
  }
  await expect(emailInput).toBeVisible({ timeout: 20_000 })
  await expect(composer(page)).toHaveCount(0)
  await login(page, desktopCredentials())
  await expect(page.getByTestId('nav-chat')).toBeVisible({ timeout: 30_000 })
}

/** Attach a file the way a user does: Add context -> Upload Files -> native picker. */
async function attachFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const attachButton = page.getByRole('button', { name: 'Add context' })
  await expect(attachButton).toBeEnabled()
  await attachButton.click()
  const uploadItem = page.getByRole('menuitem', { name: 'Upload Files' })
  await expect(uploadItem).toBeEnabled({ timeout: 15_000 })
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15_000 }),
    uploadItem.click(),
  ])
  await fileChooser.setFiles(file)
  await expect(
    page.locator('.composer-attachment-chip').filter({ hasText: file.name })
  ).toBeVisible()
}

/**
 * Send one step and wait for its fixed answer. The answer is counted, so a
 * second identical answer in the same conversation is still a new answer.
 */
async function askStep(page: Page, step: string, params: Record<string, string>, verdict: string) {
  const quoted = Object.entries(params)
    .map(([key, value]) => ` ${key}="${value}"`)
    .join('')
  const answer = page.getByTestId('agent-response').filter({
    hasText: `GFS-FILES ${step} ${verdict}`,
  })
  const before = await answer.count()
  await composer(page).fill(`Please do this. GFS_FILES step=${step}${quoted}`)
  await sendButton(page).click()
  await expect(answer).toHaveCount(before + 1, { timeout: 150_000 })
}

/** Open Files and enter the named folder; its crumb is the current location. */
async function browseToFolder(page: Page, folderName: string): Promise<Locator> {
  /*
   * E2E_GUARDIAN_IPC_FLOW: Desktop GFS discovery is brokered through the
   * main-process `window.clerum.gfs.listAccessible` bridge, so the renderer has
   * no HTTP response to await. The Files heading, the browser region and the
   * seeded folder row are the visible signals.
   */
  const filesHeading = page.getByRole('heading', { name: 'Files', exact: true })
  const openFiles = async (timeout: number): Promise<void> => {
    await openResourcesNavItem(page, 'nav-files')
    await expect(filesHeading).toBeVisible({ timeout })
    await expect(page.getByRole('region', { name: 'EvenDrive browser' })).toBeVisible({ timeout })
  }
  try {
    await openFiles(15_000)
  } catch (firstNavigationError) {
    // The shell can restore Chat after its first data refresh; repeat the same
    // user action once, bounded by the Files heading.
    try {
      await openFiles(30_000)
    } catch {
      throw firstNavigationError
    }
  }
  const browser = page.getByRole('region', { name: 'EvenDrive browser' })
  await browser.getByRole('button', { name: folderName, exact: true }).click()
  await expect(
    browser
      .getByRole('navigation', { name: 'File location' })
      .getByRole('button', { name: folderName, exact: true })
  ).toHaveAttribute('aria-current', 'page', { timeout: 30_000 })
  return browser
}

/**
 * Download a GFS file from its Files row and return the bytes written to disk.
 * Electron's Save dialog cannot be driven; the window session's
 * `will-download` handler sets the path the user would choose.
 */
async function downloadFromFiles(
  app: ElectronApplication,
  page: Page,
  browser: Locator,
  filename: string,
  expectedBytes: number
): Promise<Buffer> {
  const savePath = test
    .info()
    .outputPath('downloads', `${randomBytes(3).toString('hex')}-${filename}`)
  mkdirSync(dirname(savePath), { recursive: true })
  await app.evaluate(({ BrowserWindow }, target) => {
    const [window] = BrowserWindow.getAllWindows()
    if (!window) throw new Error('no Desktop window to attach the download handler to')
    window.webContents.session.once('will-download', (_event, item) => {
      item.setSavePath(target)
    })
  }, savePath)
  const name = browser.getByRole('button', { name: filename, exact: true })
  await expect(name).toBeVisible({ timeout: 30_000 })
  await name.hover()
  await browser.getByRole('button', { name: `Download ${filename}`, exact: true }).click()
  await expect(page.getByText(`Downloaded ${filename}`, { exact: true })).toBeVisible({
    timeout: 120_000,
  })
  // The toast fires at the click: wait until the whole file is on disk.
  await expect
    .poll(() => (existsSync(savePath) ? statSync(savePath).size : -1), {
      timeout: 120_000,
      intervals: [100, 500, 1_000],
      message: `Desktop should write ${expectedBytes} bytes of ${filename} to ${savePath}`,
    })
    .toBe(expectedBytes)
  return readFileSync(savePath)
}

/**
 * The generated file as Desktop receives it: the bridge call the artifact
 * list's Download button makes (`ArtifactsBadge`, `rpc.downloadArtifact`).
 */
async function generatedFileDigest(page: Page, hostRef: string, filename: string) {
  return page.evaluate(
    async ([ref, name]) => {
      const bridge = (
        window as unknown as {
          clerum: {
            rpc: {
              downloadArtifact(host: string, file: string, refs: string[]): Promise<Uint8Array>
            }
          }
        }
      ).clerum
      const bytes = new Uint8Array(await bridge.rpc.downloadArtifact(ref, name, [ref]))
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      return {
        bytes: bytes.byteLength,
        sha256: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join(''),
      }
    },
    [hostRef, filename] as const
  )
}

/** The names of the artifact list Desktop shows for this Host (`rpc.listArtifacts`). */
async function desktopArtifactNames(page: Page, hostRef: string): Promise<string[]> {
  return page.evaluate(async ref => {
    const bridge = (
      window as unknown as {
        clerum: {
          rpc: {
            listArtifacts(host: string, refs: string[]): Promise<{ artifacts?: { name: string }[] }>
          }
        }
      }
    ).clerum
    const result = await bridge.rpc.listArtifacts(ref, [ref])
    return (result.artifacts ?? []).map(artifact => artifact.name)
  }, hostRef)
}

function stepAnswers(rows: FixtureProviderAttempt[], step: string) {
  return rows.filter(
    row => row.responseKind === FIXTURE_RESPONSE_KIND.gfsFilesAnswer && row.step === step
  )
}

function stepSaveArgs(rows: FixtureProviderAttempt[], step: string) {
  return rows
    .filter(
      row =>
        row.responseKind === FIXTURE_RESPONSE_KIND.gfsFilesToolRequested &&
        row.step === step &&
        row.saveArgs
    )
    .map(row => row.saveArgs!)
}

function noRejection(rows: FixtureProviderAttempt[]) {
  expect(rows.filter(row => row.responseKind === FIXTURE_RESPONSE_KIND.rejected)).toEqual([])
}

test.describe('generated-gfs-save fixture', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(
    MODE !== 'fixture',
    'Set IMAGE_CAPABILITIES_RUN_ID=image-capabilities-<12 hex> (the runner does) to run the ' +
      'derived-provider fixture journeys.'
  )

  let app: ElectronApplication | undefined
  let page!: Page
  let env!: ImageCapabilitiesFixtureEnv
  let folder!: ReturnType<typeof seedGfsDirectoryFixture>
  let fixtureName: string | undefined
  const run = randomBytes(3).toString('hex')
  const report = `report-${run}`

  const folderParams = () => ({ drive: 'main', folder: folder.name })
  const summary = (name: string) =>
    getGfsChildResourceSummary({ parentResourceId: folder.resourceId, name })
  const ledgerSince = (before: ImageCapabilityEvidenceSnapshot) =>
    appendedAttempts(before, readImageCapabilityEvidence(env))

  test.beforeAll(async ({}, testInfo) => {
    env = requireImageCapabilitiesFixtureEnv()
    await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', env.externalRestApiBaseUrl)
    await assertAllowedTarget('RPC_PROXY_BASE_URL', env.rpcProxyBaseUrl)
    const baseline = readImageCapabilityEvidence(env)
    expect(baseline.runId).toBe(env.runId)
    expect(baseline.profile).toBe(env.profile)

    fixtureName = uniqueGfsFixtureName('e2e-gfs-generated')
    folder = seedGfsDirectoryFixture(fixtureName)
    for (const [subjectType, subjectId, permissions] of [
      ['user', getE2EUserId(), ['read']],
      ['host', journeyHostSubjectId, ['read', 'write']],
    ] as const) {
      seedGfsGrant({
        resourceId: folder.resourceId,
        subjectType,
        subjectId,
        permissions: [...permissions],
        inherit: true,
        grantedBy: 'e2e:generated-gfs-save',
      })
    }

    // One launch and one sign-in: the password admission limit is five
    // attempts per identity in fifteen minutes.
    const launched = await launchDesktopApp(
      testInfo,
      `generated-gfs-save-minikube${new URL(EXTERNAL_REST_API_BASE_URL).port}`
    )
    app = launched.app
    page = launched.page
    await signIn(page)
    await openConfiguredAgentChat(page, env.hostRef)
  })

  test.afterAll(async () => {
    await finalizeRecording(app, page)
    if (fixtureName) {
      cleanupGfsFixture(fixtureName)
      assertGfsFixtureCleaned(fixtureName)
    }
  })

  test('generated-gfs-save fixture: saves six generated formats by name and Save id, byte for byte', async () => {
    const before = readImageCapabilityEvidence(env)
    await test.step('generate the six formats and save each', async () => {
      await startBlankChat(page)
      await askStep(page, 'generate-and-save', { ...folderParams(), name: report }, 'saved')
    })
    await test.step('ledger: six saves by name and Save id, no file content', async () => {
      const rows = ledgerSince(before)
      noRejection(rows)
      const saves = stepSaveArgs(rows, 'generate-and-save')
      expect(saves.map(args => args.name)).toEqual(
        GENERATED_EXTENSIONS.map(extension => `${report}.${extension}`)
      )
      for (const args of saves) {
        expect(Object.keys(args).sort()).toEqual(
          ['drive', 'generatedFile', 'generatedFileId', 'name', 'parentResourceId'].sort()
        )
        expect(args.generatedFileId).toMatch(/^[0-9a-f]{12}$/)
      }
      const [answer] = stepAnswers(rows, 'generate-and-save')
      const outcome = answer!.outcome as { saves: { source: string; scan: string }[] }
      expect(outcome.saves.map(save => save.source)).toEqual(
        GENERATED_EXTENSIONS.map(() => 'generated_file')
      )
      // Text and Office formats are scanned; pdf and png are binary formats.
      expect(outcome.saves.map(save => save.scan)).toEqual([
        'scanned',
        'scanned',
        'scanned',
        'scanned',
        'not_scanned',
        'not_scanned',
      ])
    })
    await test.step('business signal: GFS holds the bytes Desktop received', async () => {
      const browser = await browseToFolder(page, folder.name)
      for (const extension of GENERATED_EXTENSIONS) {
        const name = `${report}.${extension}`
        const received = await generatedFileDigest(page, env.hostRef, name)
        expect(summary(name)).toMatchObject({ kind: 'file', bytes: received.bytes, deleted: false })
        const saved = await downloadFromFiles(app!, page, browser, name, received.bytes)
        expect({ bytes: saved.length, sha256: sha256Hex(saved) }).toEqual(received)
      }
    })
  })

  test('generated-gfs-save fixture: replaces a saved docx with a second generation of the same name', async () => {
    const name = `${report}.docx`
    const current = summary(name)
    expect(current).toMatchObject({ kind: 'file', deleted: false })
    const before = readImageCapabilityEvidence(env)
    await page.getByTestId('nav-chat').click()
    await expect(composer(page)).toBeVisible({ timeout: 30_000 })
    await askStep(
      page,
      'replace-docx',
      {
        drive: 'main',
        file: name,
        body: `Second version ${run}`,
        resource: current!.resourceId,
        version: String(current!.version),
      },
      'saved'
    )
    const rows = ledgerSince(before)
    noRejection(rows)
    expect(stepSaveArgs(rows, 'replace-docx')).toEqual([
      expect.objectContaining({ resourceId: current!.resourceId, ifMatch: current!.version }),
    ])
    await expect.poll(() => summary(name)?.version).toBe(current!.version + 1)
    const received = await generatedFileDigest(page, env.hostRef, name)
    const browser = await browseToFolder(page, folder.name)
    const saved = await downloadFromFiles(app!, page, browser, name, received.bytes)
    expect({ bytes: saved.length, sha256: sha256Hex(saved) }).toEqual(received)
  })

  test('generated-gfs-save fixture: saves a file generated in an earlier conversation by its listed id', async () => {
    const generated = `${report}.md`
    const copy = `again-${report}.md`
    const before = readImageCapabilityEvidence(env)
    await startBlankChat(page)
    await askStep(page, 'list-and-save', { ...folderParams(), file: generated, as: copy }, 'saved')
    const rows = ledgerSince(before)
    noRejection(rows)
    const [answer] = stepAnswers(rows, 'list-and-save')
    expect(stepSaveArgs(rows, 'list-and-save')).toEqual([
      expect.objectContaining({
        name: copy,
        generatedFile: generated,
        generatedFileId: (answer!.outcome as { listedId: string }).listedId,
      }),
    ])
    const received = await generatedFileDigest(page, env.hostRef, generated)
    const browser = await browseToFolder(page, folder.name)
    const saved = await downloadFromFiles(app!, page, browser, copy, received.bytes)
    expect({ bytes: saved.length, sha256: sha256Hex(saved) }).toEqual(received)
  })

  test('generated-gfs-save fixture: keeps a file and an image attached in one conversation and saves them from another', async () => {
    const file = {
      name: `notes-${run}.bin`,
      mimeType: 'application/octet-stream',
      buffer: randomBytes(64 * 1024),
    }
    const image = {
      name: `logo-${run}.png`,
      mimeType: 'image/png',
      buffer: encodePng(16, 16, (x, y) => [x * 16, y * 16, 128]),
    }
    const before = readImageCapabilityEvidence(env)
    await test.step('attach both without asking to save', async () => {
      await startBlankChat(page)
      await attachFile(page, file)
      await attachFile(page, image)
      await askStep(page, 'acknowledge', {}, 'kept')
      await expect(sentMessageAttachments(page)).toHaveCount(2)
    })
    await test.step('save both from another conversation by their listed ids', async () => {
      await startBlankChat(page)
      await askStep(
        page,
        'save-uploads',
        { ...folderParams(), file: file.name, image: image.name, part: run },
        'saved'
      )
    })
    await test.step('GFS holds the bytes the user attached', async () => {
      const rows = ledgerSince(before)
      noRejection(rows)
      expect(
        stepSaveArgs(rows, 'save-uploads').map(args => [args.name, typeof args.uploadedFileId])
      ).toEqual([
        [file.name, 'string'],
        [image.name, 'string'],
      ])
      const browser = await browseToFolder(page, folder.name)
      for (const attached of [file, image]) {
        const saved = await downloadFromFiles(
          app!,
          page,
          browser,
          attached.name,
          attached.buffer.length
        )
        expect(sha256Hex(saved)).toBe(sha256Hex(attached.buffer))
      }
    })
  })

  test('generated-gfs-save fixture: edits one paragraph of a saved text file in place', async () => {
    const name = `edit-${run}.md`
    const before = readImageCapabilityEvidence(env)
    await startBlankChat(page)
    await askStep(page, 'edit-prepare', { ...folderParams(), file: name }, 'saved')
    const saved = summary(name)
    expect(saved).toMatchObject({ kind: 'file', deleted: false })
    expect(saved!.bytes).toBeGreaterThan(10_000)
    const original = (
      await downloadFromFiles(
        app!,
        page,
        await browseToFolder(page, folder.name),
        name,
        saved!.bytes
      )
    ).toString('utf8')
    const oldText = 'Paragraph 050 of the notes'
    const newText = `Paragraph 050, edited ${run},`
    // Witness: the paragraph is in the file exactly once before the edit.
    expect(original.split(oldText)).toHaveLength(2)
    await page.getByTestId('nav-chat').click()
    await expect(composer(page)).toBeVisible({ timeout: 30_000 })
    await askStep(
      page,
      'edit-apply',
      {
        drive: 'main',
        resource: saved!.resourceId,
        version: String(saved!.version),
        old: oldText,
        new: newText,
      },
      'edited'
    )
    const rows = ledgerSince(before)
    noRejection(rows)
    const [answer] = stepAnswers(rows, 'edit-apply')
    expect(answer!.outcome).toMatchObject({ version: saved!.version + 1, diffNamesEdit: true })
    const edited = await downloadFromFiles(
      app!,
      page,
      await browseToFolder(page, folder.name),
      name,
      Buffer.byteLength(original.replace(oldText, newText))
    )
    expect(edited.toString('utf8')).toBe(original.replace(oldText, newText))
  })

  test('generated-gfs-save fixture: saves a workspace file written without a shell by its path', async () => {
    const name = `workspace-${run}.txt`
    const text = `Workspace note ${run}`
    const before = readImageCapabilityEvidence(env)
    await startBlankChat(page)
    await askStep(
      page,
      'workspace-file',
      { ...folderParams(), path: `notes/${name}`, text, file: name },
      'saved'
    )
    const rows = ledgerSince(before)
    noRejection(rows)
    // The file_write call carries the text by design; the save call does not.
    expect(stepSaveArgs(rows, 'workspace-file')).toEqual([
      { drive: 'main', parentResourceId: folder.resourceId, name, sourcePath: `notes/${name}` },
    ])
    const [answer] = stepAnswers(rows, 'workspace-file')
    expect((answer!.outcome as { saves: { source: string }[] }).saves[0]!.source).toBe(
      'source_path'
    )
    const saved = await downloadFromFiles(
      app!,
      page,
      await browseToFolder(page, folder.name),
      name,
      Buffer.byteLength(text)
    )
    expect(saved.toString('utf8')).toBe(text)
  })

  test('generated-gfs-save fixture: lists 100 kept files whole, then only those whose name holds a part', async () => {
    const prefix = `seed-${run}`
    const seeded = Array.from(
      { length: SEEDED_FILES },
      (_, index) => `${prefix}-${String(index + 1).padStart(3, '0')}.md`
    )
    const before = readImageCapabilityEvidence(env)
    await startBlankChat(page)
    await askStep(page, 'seed', { prefix, count: String(SEEDED_FILES) }, 'seeded')
    await askStep(page, 'list', {}, 'listed')
    await askStep(page, 'list', { part: prefix }, 'listed')
    const rows = ledgerSince(before)
    noRejection(rows)
    const [whole, filtered] = stepAnswers(rows, 'list').map(
      row =>
        row.outcome as {
          count: number
          truncated: boolean
          spilled: boolean
          oldestFirst: boolean
          names: string[]
        }
    )
    // This Desktop user also holds the files of the earlier journeys, so more
    // than 100 match and the first listing is cut at 100, oldest first.
    expect(whole).toMatchObject({ count: 100, truncated: true, spilled: false, oldestFirst: true })
    expect(filtered).toMatchObject({
      count: 100,
      truncated: false,
      spilled: false,
      oldestFirst: true,
    })
    expect([...filtered!.names].sort()).toEqual(seeded)
  })

  test('generated-gfs-save fixture: deletes a kept file only after the approval card is approved', async () => {
    const name = `delete-${run}.md`
    // Each send can leave a card behind: count the approve buttons before it
    // and address the new card by index, so strict mode never sees two.
    const approveButtons = page.getByTestId('approval-approve-btn')
    const cardAfter = (count: number) =>
      page.getByTestId('progress-stepper').filter({ has: approveButtons }).nth(count)
    const listedNames = async (rowsBefore: ImageCapabilityEvidenceSnapshot) => {
      await askStep(page, 'list', { part: name }, 'listed')
      const lists = stepAnswers(ledgerSince(rowsBefore), 'list')
      return (lists[lists.length - 1]!.outcome as { names: string[] }).names
    }
    const before = readImageCapabilityEvidence(env)
    await startBlankChat(page)
    await askStep(page, 'generate-one', { file: name }, 'generated')

    await test.step('Deny: the card names the file, and the file stays', async () => {
      const stepper = cardAfter(await approveButtons.count())
      await composer(page).fill(`Please do this. GFS_FILES step=delete file="${name}"`)
      await sendButton(page).click()
      await expect(stepper).toBeVisible({ timeout: 120_000 })
      const preview = stepper.getByTestId('approval-input-preview')
      await expect(preview).toContainText('Delete these files permanently:')
      await expect(preview).toContainText(name)
      await stepper.getByTestId('approval-deny-btn').click()
      await expect(page.getByText(/was denied by the user/).last()).toBeVisible({ timeout: 60_000 })
      expect(await listedNames(before)).toEqual([name])
      expect(await desktopArtifactNames(page, env.hostRef)).toContain(name)
    })

    await test.step('Approve: the file is deleted once and is gone', async () => {
      const stepper = cardAfter(await approveButtons.count())
      await composer(page).fill(`Please do this. GFS_FILES step=delete file="${name}"`)
      await sendButton(page).click()
      await expect(stepper).toBeVisible({ timeout: 120_000 })
      await stepper.getByTestId('approval-approve-btn').click()
      await expect(
        page.getByTestId('agent-response').filter({ hasText: 'GFS-FILES delete deleted' })
      ).toHaveCount(1, { timeout: 120_000 })
      expect(await listedNames(before)).toEqual([])
      expect(await desktopArtifactNames(page, env.hostRef)).not.toContain(name)
    })

    const rows = ledgerSince(before)
    noRejection(rows)
    const deleteCalls = rows.filter(
      row =>
        row.responseKind === FIXTURE_RESPONSE_KIND.gfsFilesToolRequested &&
        row.tool === 'clerum__kept_files_delete'
    )
    // Both asks reached the card; only the approved one ran.
    expect(deleteCalls).toHaveLength(2)
    expect(stepAnswers(rows, 'delete').map(row => row.outcome)).toEqual([
      expect.objectContaining({ results: ['deleted'] }),
    ])
  })
})
