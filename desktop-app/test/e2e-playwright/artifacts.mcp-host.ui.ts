import { type Locator, type Page, expect } from '@playwright/test'
import { HOST_REF } from './artifacts.mcp-host.runtime.js'
import { openAgentsPage } from './navigationHelpers.js'

async function enterAgentChat(page: Page): Promise<void> {
  await openAgentsPage(page)
  const chatInput = page.getByTestId('chat-input')
  const agentLink = page.getByRole('button', { name: `Open conversation with ${HOST_REF}` }).first()
  await expect(chatInput.or(agentLink)).toBeVisible({ timeout: 20_000 })
  if (await agentLink.isVisible()) {
    await agentLink.click()
  }
}

async function closeChatListBackdropIfOpen(page: Page): Promise<void> {
  const chatListBackdrop = page.locator('.chat-list-backdrop')
  try {
    await expect(chatListBackdrop).toBeHidden({ timeout: 750 })
    return
  } catch {
    await chatListBackdrop.click()
  }
  await expect(chatListBackdrop).toBeHidden({ timeout: 5_000 })
}

export async function openSeededArtifactPanel(
  page: Page,
  title: string,
  artifactName: string | string[]
): Promise<Locator> {
  const artifactNames = Array.isArray(artifactName) ? artifactName : [artifactName]
  const primaryArtifactName = artifactNames[0] ?? ''
  await enterAgentChat(page)

  const sessionButton = page.getByRole('button', { name: title }).first()
  await expect(sessionButton).toBeVisible({ timeout: 20_000 })
  await sessionButton.click()
  await closeChatListBackdropIfOpen(page)

  const assistantMessage = page
    .getByTestId('agent-response')
    .filter({ hasText: primaryArtifactName })
  await expect(assistantMessage).toBeVisible({ timeout: 20_000 })

  const artifactsPanel = assistantMessage.getByRole('region', { name: 'Generated files' })
  await expect(artifactsPanel).toBeVisible({ timeout: 20_000 })
  for (const name of artifactNames) {
    await expect(artifactsPanel).toContainText(name)
  }
  return artifactsPanel
}

async function installBrowserDownloadCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as Window & {
      __clerumE2eDownloads?: Array<{ filename: string; text: string; base64: string }>
      __clerumE2eDownloadCaptureInstalled?: boolean
    }
    if (win.__clerumE2eDownloadCaptureInstalled) return
    win.__clerumE2eDownloadCaptureInstalled = true
    win.__clerumE2eDownloads = []

    const blobDataByUrl = new Map<string, Promise<{ text: string; base64: string }>>()
    const originalCreateObjectURL = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = originalCreateObjectURL(object)
      if (object instanceof Blob) {
        blobDataByUrl.set(
          url,
          object.arrayBuffer().then(buffer => {
            const text = new TextDecoder().decode(buffer)
            let binary = ''
            for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte)
            return { text, base64: btoa(binary) }
          })
        )
      }
      return url
    }

    const originalAnchorClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      const filename = this.download
      const dataPromise = blobDataByUrl.get(this.href)
      if (filename && dataPromise) {
        void dataPromise.then(data => {
          win.__clerumE2eDownloads?.push({ filename, ...data })
        })
      }
      return originalAnchorClick.call(this)
    }
  })
}

export async function expectBrowserDownloadArtifact(
  page: Page,
  button: Locator,
  artifactName: string,
  expectedText: string
): Promise<void> {
  await installBrowserDownloadCapture(page)
  await closeChatListBackdropIfOpen(page)
  await button.click()
  await page.waitForFunction(
    ({ filename, text }) => {
      const downloads =
        (
          window as Window & {
            __clerumE2eDownloads?: Array<{ filename: string; text: string }>
          }
        ).__clerumE2eDownloads ?? []
      return downloads.some(download => download.filename === filename && download.text === text)
    },
    { filename: artifactName, text: expectedText },
    { timeout: 30_000 }
  )
}

export async function expectBrowserDownloadArtifactBytes(
  page: Page,
  button: Locator,
  artifactName: string,
  expectedBytes: Buffer
): Promise<void> {
  await installBrowserDownloadCapture(page)
  await closeChatListBackdropIfOpen(page)
  await button.click()
  await page.waitForFunction(
    ({ filename, base64 }) => {
      const downloads =
        (
          window as Window & {
            __clerumE2eDownloads?: Array<{ filename: string; base64: string }>
          }
        ).__clerumE2eDownloads ?? []
      return downloads.some(
        download => download.filename === filename && download.base64 === base64
      )
    },
    { filename: artifactName, base64: expectedBytes.toString('base64') },
    { timeout: 30_000 }
  )
}
