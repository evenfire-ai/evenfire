// E2E_GUARDIAN_IPC_FLOW: Resource mutations and reads are brokered through Electron IPC.
import { type Page, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { humanRecordedPause } from '../helpers/humanPause'

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
    await humanRecordedPause([600, 1200])
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
    await this.page.getByLabel('Upload file', { exact: true }).setInputFiles(filePath)
    await expect(this.page.getByRole('button', { name: `Open ${name}` })).toBeVisible({
      timeout: 120_000,
    })
    fs.rmSync(dir, { recursive: true, force: true })
    await humanRecordedPause([600, 1200])
  }

  async openShare(name: string): Promise<void> {
    await this.page.getByRole('button', { name: `Options for ${name}` }).click()
    await this.page
      .getByRole('menu', { name: `Actions for ${name}` })
      .getByRole('menuitem', { name: 'Share' })
      .hover()
    await this.page
      .getByRole('menu', { name: `Share options for ${name}` })
      .getByRole('menuitem', { name: 'Share', exact: true })
      .click()
    await expect(
      this.page.getByRole('dialog', { name: new RegExp(`^Share (folder|file) `) })
    ).toBeVisible()
    await humanRecordedPause([600, 1200])
  }

  /** The open folder accepts writes: its header offers New folder only with write access. */
  async expectWritable(): Promise<void> {
    const browser = this.page.getByRole('region', { name: 'EvenDrive browser' })
    await expect(browser.getByRole('button', { name: 'New folder' })).toBeVisible()
  }

  async expectRefused(code: string): Promise<void> {
    await expect(this.page.getByRole('alert').getByText(code)).toBeVisible()
  }
}
