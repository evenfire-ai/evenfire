import { type Locator, expect } from '@playwright/test'
import { humanClick } from './workflowAgentChatTools'

async function installResponseFileDownloadCapture(response: Locator): Promise<void> {
  await response.page().evaluate(() => {
    const win = window as Window & {
      __clerumE2eResponseFileDownloads?: Array<{
        filename: string
        text: string
        dataBase64: string
        mimeType: string
        sizeBytes: number
      }>
      __clerumE2eResponseFileDownloadCaptureInstalled?: boolean
    }
    if (win.__clerumE2eResponseFileDownloadCaptureInstalled) return
    win.__clerumE2eResponseFileDownloadCaptureInstalled = true
    win.__clerumE2eResponseFileDownloads = []

    const blobDataByUrl = new Map<
      string,
      Promise<{
        text: string
        dataBase64: string
        mimeType: string
        sizeBytes: number
      }>
    >()
    const blobToDownload = async (blob: Blob) => {
      const buffer = await blob.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
      }
      return {
        text: await blob.text(),
        dataBase64: btoa(binary),
        mimeType: blob.type,
        sizeBytes: blob.size,
      }
    }
    const originalCreateObjectURL = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = originalCreateObjectURL(object)
      if (object instanceof Blob) {
        blobDataByUrl.set(url, blobToDownload(object))
      }
      return url
    }

    const originalAnchorClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      const filename = this.download
      const dataPromise = blobDataByUrl.get(this.href)
      if (filename && dataPromise) {
        void dataPromise.then(download => {
          win.__clerumE2eResponseFileDownloads?.push({ filename, ...download })
        })
      }
      return originalAnchorClick.call(this)
    }
  })
}

type WorkflowResultDownloadExpectation =
  | { kind: 'json'; payload: Record<string, unknown> }
  | { kind: 'text'; text: string }
  | {
      kind: 'base64'
      dataBase64: string
      mimeType?: string
      sizeBytes?: number
    }

function normalizeDownloadExpectation(
  expectation: Record<string, unknown> | WorkflowResultDownloadExpectation
): WorkflowResultDownloadExpectation {
  const maybeKind = 'kind' in expectation ? expectation.kind : undefined
  return maybeKind === 'json' || maybeKind === 'text' || maybeKind === 'base64'
    ? (expectation as WorkflowResultDownloadExpectation)
    : { kind: 'json', payload: expectation }
}

export async function downloadWorkflowResultResponseFileFromAssistant(
  response: Locator,
  artifactName: string,
  expectation: Record<string, unknown> | WorkflowResultDownloadExpectation
): Promise<void> {
  await installResponseFileDownloadCapture(response)

  const attachmentList = response.getByLabel('Message attachments')
  await expect(attachmentList).toBeVisible({ timeout: 60_000 })
  const attachmentChip = attachmentList.locator('.message-attachment-chip').filter({
    hasText: artifactName,
  })
  await expect(attachmentChip).toContainText('Generated file')
  await expect(attachmentChip).toContainText(artifactName)

  const downloadButton = attachmentChip.getByRole('button', { name: /^Download$/ })
  await expect(downloadButton).toBeVisible({ timeout: 30_000 })
  await humanClick(downloadButton, {
    beforeMs: [800, 1_400],
    afterMs: [900, 1_500],
    moveSteps: 24,
    clickDelayMs: 120,
  })

  const expectedDownload = normalizeDownloadExpectation(expectation)
  await expect
    .poll(
      () =>
        response.page().evaluate(
          ({ filename, expected }) => {
            const downloads =
              (
                window as Window & {
                  __clerumE2eResponseFileDownloads?: Array<{
                    filename: string
                    text: string
                    dataBase64: string
                    mimeType: string
                    sizeBytes: number
                  }>
                }
              ).__clerumE2eResponseFileDownloads ?? []
            return downloads.some(download => {
              if (download.filename !== filename) return false
              if (expected.kind === 'json') {
                try {
                  return JSON.stringify(JSON.parse(download.text)) === expected.json
                } catch {
                  return false
                }
              }
              if (expected.kind === 'text') {
                return download.text === expected.text
              }
              return (
                download.dataBase64 === expected.dataBase64 &&
                (expected.mimeType === undefined || download.mimeType === expected.mimeType) &&
                (expected.sizeBytes === undefined || download.sizeBytes === expected.sizeBytes)
              )
            })
          },
          {
            filename: artifactName,
            expected:
              expectedDownload.kind === 'json'
                ? { kind: 'json' as const, json: JSON.stringify(expectedDownload.payload) }
                : expectedDownload,
          }
        ),
      {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
        message: `Desktop App should download workflow_result response attachment ${artifactName}`,
      }
    )
    .toBe(true)
}
