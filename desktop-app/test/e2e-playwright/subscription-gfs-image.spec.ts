/**
 * E2E_GUARDIAN_IPC_FLOW: visible login -> Files -> actual preview tabs -> owned
 * Host/model -> EvenDrive chooser -> attach refs -> Send -> real version-pinned
 * gfs_read results -> ordered pixel answer -> one durable two-message task.
 * Main seeds only two isolated QA files and grants. No business API writes,
 * browser state mutation or injected core response advances this journey.
 */
import { randomUUID } from 'node:crypto'
import { openResourcesNavItem } from './navigationHelpers.js'
import { decodeTileChallenge } from './subscriptionImageChallenge.js'
import { expect, subscriptionImageRun as run, sha256, test } from './subscriptionImageFixtures.js'
import { preparedPixelCode, readRemainingFixture } from './subscriptionRemainingJourneyData.js'
import {
  assertPixelVendorEvidence,
  observeDurableTurn,
  openOwnedChat,
  outputPattern,
  settledVisibleAnswer,
  showCompletedTools,
  submitVisibly,
} from './subscriptionRemainingJourneyUi.js'
import {
  type GfsFixture,
  requireRemainingJourney,
} from './subscriptionRemainingJourneysContract.js'

const input = requireRemainingJourney('gfs-image', run)
let fixtures: Record<string, GfsFixture>
test.beforeAll(() => {
  fixtures = readRemainingFixture(input, run).fixtures as Record<string, GfsFixture>
})

for (const binding of run.bindings) {
  test(`${binding.provider} Files preview and attached GFS image preserve source and ordered pixels`, async ({
    appPage,
  }, testInfo) => {
    const fixture = fixtures[binding.provider]!
    const codes = await Promise.all(fixture.files.map(file => preparedPixelCode(run, file)))
    expect(new Set(codes).size).toBe(2)
    for (const code of codes) {
      expect(
        JSON.stringify(
          fixture.files.map(({ name, drive, resourceId, version, gfsUri }) => ({
            name,
            drive,
            resourceId,
            version,
            gfsUri,
          }))
        )
      ).not.toContain(code)
    }
    await test.step('open both prepared images through Files and decode the visible preview', async () => {
      for (const [index, file] of fixture.files.entries()) {
        await openResourcesNavItem(appPage, 'nav-files')
        const browser = appPage.getByRole('region', { name: 'EvenDrive browser', exact: true })
        await expect(browser).toBeVisible()
        const root = browser
          .getByRole('navigation', { name: 'File location', exact: true })
          .getByRole('button', { name: 'Shared with me', exact: true })
        // A read-only snapshot chooses the current breadcrumb state; visible assertions retry.
        if (await root.isEnabled()) await root.click()
        for (const folder of fixture.folderNames) {
          const entry = browser.getByRole('button', { name: `Open ${folder}`, exact: true })
          await expect(entry).toBeVisible()
          await entry.click()
          await expect(
            browser.getByRole('navigation', { name: 'File location', exact: true })
          ).toContainText(folder)
        }
        const entry = browser.getByRole('button', { name: `Open ${file.name}`, exact: true })
        await expect(entry).toBeVisible()
        await entry.click()
        await expect(
          appPage.getByRole('heading', { name: file.name, level: 2, exact: true })
        ).toBeVisible()
        const preview = appPage.getByRole('img', { name: `Preview of ${file.name}`, exact: true })
        await expect(preview).toBeVisible()
        await expect
          .poll(() =>
            preview.evaluate(async element => {
              const image = element as HTMLImageElement
              try {
                await image.decode()
                return { width: image.naturalWidth, height: image.naturalHeight }
              } catch {
                return null
              }
            })
          )
          .toEqual({ width: file.width, height: file.height })
        if (run.mode === 'fixture') {
          // Read only the image already displayed by the real preview. This
          // detects a stale/wrong source behind a correct filename and size.
          const displayedPixels = await preview.evaluate(element => {
            const image = element as HTMLImageElement
            const canvas = document.createElement('canvas')
            canvas.width = image.naturalWidth
            canvas.height = image.naturalHeight
            const context = canvas.getContext('2d')
            if (!context) throw new Error('Visible preview pixels cannot be read')
            context.drawImage(image, 0, 0)
            return canvas.toDataURL('image/png').split(',')[1]!
          })
          expect(await decodeTileChallenge(Buffer.from(displayedPixels, 'base64'))).toBe(
            codes[index]
          )
        }
      }
    })
    await openOwnedChat(appPage, binding)
    await test.step('choose the same GFS files visibly in their intended message order', async () => {
      await appPage.getByRole('button', { name: 'Add context', exact: true }).click()
      const evenDrive = appPage.getByRole('menuitem', { name: 'EvenDrive', exact: true })
      await expect(evenDrive).toBeVisible()
      await evenDrive.click()
      const picker = appPage.getByRole('dialog', {
        name: 'Choose files for this message',
        exact: true,
      })
      await expect(picker).toBeVisible()
      for (const folder of fixture.folderNames) {
        const directory = picker.getByRole('button').filter({
          hasText: new RegExp(`^${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*Folder$`),
        })
        await expect(directory).toBeVisible()
        await directory.click()
        await expect(
          picker.getByRole('navigation', { name: 'Global file path', exact: true })
        ).toContainText(folder)
      }
      for (const file of fixture.files) {
        const checkbox = picker.getByRole('checkbox', {
          name: new RegExp(`^${file.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`),
        })
        await expect(checkbox).toBeVisible()
        await checkbox.check()
        await expect(checkbox).toBeChecked()
      }
      await picker.getByRole('button', { name: 'Attach 2', exact: true }).click()
      await expect(picker).toHaveCount(0)
      for (const file of fixture.files)
        await expect(
          appPage.getByRole('button', { name: `Remove ${file.name}`, exact: true })
        ).toBeVisible()
      const labels = await appPage.locator('.composer-attachment-chip strong').allTextContents()
      expect(labels).toEqual(fixture.files.map(file => file.name))
    })
    const receiptId = randomUUID()
    const targets = fixture.files.map(({ drive, resourceId, version }) => ({
      drive,
      resourceId,
      version,
    }))
    const prompt = [
      'Journey: gfs-image',
      `GFS targets: ${JSON.stringify(targets)}`,
      'Use clerum__gfs_read for each attached image in this order, with the exact expectedVersion shown above.',
      'Read the hexadecimal challenge from the returned image pixels. Reply only with one code per line in file order.',
      'Do not infer pixels from file names or source metadata. Do not use OCR or other tools.',
      `Receipt: ${receiptId}`,
    ].join('\n')
    for (const code of codes) expect(prompt).not.toContain(code)
    await submitVisibly(appPage, binding, prompt)
    for (const file of fixture.files)
      await expect(
        appPage.getByTestId('message-list').getByText(file.name, { exact: true })
      ).toBeVisible()
    const expected = outputPattern(codes)
    await settledVisibleAnswer(appPage, binding, expected)
    await showCompletedTools(appPage, ['gfs_read', 'gfs_read'])
    const turn = await observeDurableTurn(appPage, binding, {
      status: 'completed',
      response: expected,
    })
    expect(turn.userAttachments).toEqual(
      fixture.files.map(file => ({
        id: `global-file:${file.drive}:${file.pickerResourceId}`,
        type: 'global_file',
        label: file.name,
      }))
    )
    expect(turn.toolSteps).toEqual([
      { toolName: 'clerum__gfs_read', state: 'completed' },
      { toolName: 'clerum__gfs_read', state: 'completed' },
    ])
    await assertPixelVendorEvidence(
      run,
      binding,
      receiptId,
      {
        journey: 'gfs-image',
        stages: ['read', 'pixels'],
        imageSha256: fixture.files.map(file => file.imageSha256),
        mimeTypes: fixture.files.map(file => file.mimeType),
        output: codes.join('\n'),
        calls: fixture.files.map(file => ({
          name: 'clerum__gfs_read',
          argumentsSha256: sha256(
            JSON.stringify({
              drive: file.drive,
              resourceId: file.resourceId,
              expectedVersion: file.version,
            })
          ),
        })),
        sources: fixture.files.map(({ drive, resourceId, version, gfsUri }) => ({
          kind: 'gfs',
          drive,
          resourceId,
          version,
          gfsUri,
        })),
        referencedFiles: fixture.files.map(({ drive, resourceId, version, sizeBytes }) => ({
          referenceId: `gfs:${drive}:${resourceId}@v${version}`,
          drive,
          resourceId,
          version,
          availability: 'available',
          byteLength: sizeBytes,
        })),
      },
      turn,
      testInfo
    )
    await testInfo.attach('gfs-image-source-identity', {
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify({
          runId: run.runId,
          hostRef: fixture.hostRef,
          podUid: fixture.podUid,
          imageId: fixture.imageId,
          taskId: turn.taskId,
          files: fixture.files.map(
            ({ drive, resourceId, gfsUri, version, sizeBytes, imageSha256 }) => ({
              drive,
              resourceId,
              gfsUri,
              version,
              sizeBytes,
              imageSha256,
            })
          ),
        })
      ),
    })
  })
}
