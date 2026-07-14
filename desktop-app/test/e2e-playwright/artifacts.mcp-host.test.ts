import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupRuntimeArtifact,
  growRuntimeArtifactBeyondDownloadLimit,
  prepareRuntimeArtifact,
  prepareRuntimeBinaryArtifact,
  seedLocalArtifactChat,
} from './artifacts.mcp-host.runtime.js'
import {
  expectBrowserDownloadArtifact,
  expectBrowserDownloadArtifactBytes,
  openSeededArtifactPanel,
} from './artifacts.mcp-host.ui.js'
import { E2E_EMAIL, launchAndLogin, loginAs } from './workflowUi'

test('downloads a mcp-host runtime artifact from Desktop App through external-rest-api issued rpc-proxy credentials', async () => {
  const artifactName = `e2e-pr91-desktop-${Date.now()}.txt`
  const artifactBody = `desktop mcp-host artifact payload ${artifactName}\n`
  const downloadPath = path.join(os.homedir(), 'Downloads', artifactName)
  fs.rmSync(downloadPath, { force: true })
  prepareRuntimeArtifact(artifactName, artifactBody)
  const { userId } = await loginAs(E2E_EMAIL)
  const seededChat = seedLocalArtifactChat(userId, artifactName)
  const { app, page } = await launchAndLogin(E2E_EMAIL)

  try {
    const artifactsPanel = await openSeededArtifactPanel(page, seededChat.title, artifactName)

    await expectBrowserDownloadArtifact(
      page,
      artifactsPanel.getByRole('button', { name: `Download ${artifactName}` }),
      artifactName,
      artifactBody
    )
  } finally {
    await app.close().catch(() => undefined)
    fs.rmSync(downloadPath, { force: true })
    seededChat.restore()
    cleanupRuntimeArtifact(artifactName)
  }
})

test('downloads a binary mcp-host artifact from Desktop App without redaction corruption', async () => {
  const artifactName = `e2e-pr91-desktop-binary-${Date.now()}.pdf`
  const secretValue = `desktop-secret-${Date.now()}`
  const artifactBody = Buffer.concat([
    Buffer.from('%PDF-1.7\n', 'utf-8'),
    Buffer.from([0x00, 0xff, 0x80]),
    Buffer.from(`${secretValue}\n%%EOF`, 'utf-8'),
  ])
  const downloadPath = path.join(os.homedir(), 'Downloads', artifactName)
  fs.rmSync(downloadPath, { force: true })
  prepareRuntimeBinaryArtifact(artifactName, artifactBody)
  const { userId } = await loginAs(E2E_EMAIL)
  const seededChat = seedLocalArtifactChat(userId, artifactName)
  const { app, page } = await launchAndLogin(E2E_EMAIL)

  try {
    const artifactsPanel = await openSeededArtifactPanel(page, seededChat.title, artifactName)

    await expectBrowserDownloadArtifactBytes(
      page,
      artifactsPanel.getByRole('button', { name: `Download ${artifactName}` }),
      artifactName,
      artifactBody
    )
  } finally {
    await app.close().catch(() => undefined)
    fs.rmSync(downloadPath, { force: true })
    seededChat.restore()
    cleanupRuntimeArtifact(artifactName)
  }
})

test('downloads pptx and png mcp-host runtime artifacts from Desktop App through existing artifact actions', async () => {
  const suffix = Date.now()
  const pptxName = `e2e-internal-generated-${suffix}.pptx`
  const pngName = `e2e-internal-generated-${suffix}.png`
  const pptxBody = Buffer.from('PK pptx fixture bytes from e2e\n')
  const pngBody = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ])
  const pptxDownloadPath = path.join(os.homedir(), 'Downloads', pptxName)
  const pngDownloadPath = path.join(os.homedir(), 'Downloads', pngName)
  let seededChat: ReturnType<typeof seedLocalArtifactChat> | null = null
  let app: Awaited<ReturnType<typeof launchAndLogin>>['app'] | null = null

  try {
    await test.step('setup bounded runtime artifacts and an existing chat precondition', async () => {
      fs.rmSync(pptxDownloadPath, { force: true })
      fs.rmSync(pngDownloadPath, { force: true })
      prepareRuntimeBinaryArtifact(pptxName, pptxBody)
      prepareRuntimeBinaryArtifact(pngName, pngBody)
      const { userId } = await loginAs(E2E_EMAIL)
      seededChat = seedLocalArtifactChat(userId, [pptxName, pngName])
    })

    const launched = await test.step('launch Desktop and authenticate through the app flow', () =>
      launchAndLogin(E2E_EMAIL))
    app = launched.app

    const artifactsPanel = await test.step('open Agents chat and find Generated files', () =>
      openSeededArtifactPanel(launched.page, seededChat!.title, [pptxName, pngName]))

    await test.step('download pptx through visible Desktop artifact action', async () => {
      await expectBrowserDownloadArtifactBytes(
        launched.page,
        artifactsPanel.getByRole('button', { name: `Download ${pptxName}` }),
        pptxName,
        pptxBody
      )
    })

    await test.step('download png through visible Desktop artifact action', async () => {
      await expectBrowserDownloadArtifactBytes(
        launched.page,
        artifactsPanel.getByRole('button', { name: `Download ${pngName}` }),
        pngName,
        pngBody
      )
    })
  } finally {
    await app?.close().catch(() => undefined)
    fs.rmSync(pptxDownloadPath, { force: true })
    fs.rmSync(pngDownloadPath, { force: true })
    seededChat?.restore()
    cleanupRuntimeArtifact(pptxName)
    cleanupRuntimeArtifact(pngName)
  }
})

test('surfaces a mcp-host download rejection in Desktop App when a listed artifact exceeds the broker limit', async () => {
  const artifactName = `e2e-pr91-desktop-huge-${Date.now()}.txt`
  prepareRuntimeArtifact(artifactName, `small before download ${artifactName}\n`)
  const { userId } = await loginAs(E2E_EMAIL)
  const seededChat = seedLocalArtifactChat(userId, artifactName)
  const { app, page } = await launchAndLogin(E2E_EMAIL)

  try {
    const artifactsPanel = await openSeededArtifactPanel(page, seededChat.title, artifactName)
    growRuntimeArtifactBeyondDownloadLimit(artifactName)

    await artifactsPanel.getByRole('button', { name: `Download ${artifactName}` }).click()
    await expect(page.getByText(/Artifact too large to download/i)).toBeVisible({ timeout: 60_000 })
  } finally {
    await app.close().catch(() => undefined)
    seededChat.restore()
    cleanupRuntimeArtifact(artifactName)
  }
})
