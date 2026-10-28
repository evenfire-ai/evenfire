// E2E_GUARDIAN_IPC_FLOW: Resource mutations and reads are brokered through Electron IPC.
import { type Page, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export class DesktopResourceView {
  constructor(private readonly page: Page) {}

  async createFolder(name: string): Promise<void> {
    await this.page.getByRole('button', { name: 'New folder' }).click()
    const dialog = this.page.getByRole('dialog', { name: 'New folder' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Folder name').fill(name)
    await dialog.getByRole('button', { name: 'Create folder' }).click()
    await expect(dialog).toBeHidden()
    await expect(this.page.getByRole('button', { name: `Open ${name}` })).toBeVisible()
  }

  async uploadFile(name: string, bytes: Buffer): Promise<void> {
    // Desktop uploads stream from disk: FilesPage resolves the picked file's
    // real path (`window.clerum.gfs.getPathForFile`) and an in-memory File has
    // none ("Could not resolve the selected local file"). Pick a real file. The
    // row appears only after the awaited upload mutation succeeds and refreshes
    // the listing (FilesPage upload handler, useGfsBrowserController
    // createFileFromPathMutation), so the file is no longer read once it shows.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfs-home-upload-'))
    const filePath = path.join(dir, name)
    fs.writeFileSync(filePath, bytes)
    try {
      await this.page.getByLabel('Upload file', { exact: true }).setInputFiles(filePath)
      await expect(this.page.getByRole('button', { name: `Open ${name}` })).toBeVisible()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  async openShare(name: string): Promise<void> {
    await this.page.getByRole('button', { name: `Options for ${name}` }).click()
    await this.page
      .getByRole('menu', { name: `Actions for ${name}` })
      .getByRole('menuitem', { name: 'Share' })
      .click()
    await this.page
      .getByRole('menu', { name: `Share options for ${name}` })
      .getByRole('menuitem', { name: 'Share', exact: true })
      .click()
    await expect(
      this.page.getByRole('dialog', { name: new RegExp(`^Share (folder|file) `) })
    ).toBeVisible()
  }

  async expectYourAccess(bits: string[]): Promise<void> {
    const line = this.page.getByLabel('Your access')
    await expect(line).toBeVisible()
    for (const bit of bits) await expect(line).toContainText(bit)
  }

  async expectRefused(code: string): Promise<void> {
    await expect(this.page.getByRole('alert').getByText(code)).toBeVisible()
  }
}
