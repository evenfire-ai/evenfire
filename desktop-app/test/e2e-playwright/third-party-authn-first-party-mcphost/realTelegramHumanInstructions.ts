import { type Browser, type Page, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export async function openHumanInstructions(
  browser: Browser,
  params: {
    botName: string
    visualUsername: string
    recipeName: string
    marker: string
    artifactProof: string
  }
): Promise<Page> {
  const page = await browser.newPage()
  await page.setContent(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Real Telegram Human E2E</title>
        <style>
          body { margin: 0; font: 18px system-ui, -apple-system, BlinkMacSystemFont, sans-serif; color: #16212f; background: #f4f7fb; }
          main { max-width: 980px; margin: 32px auto; padding: 28px; background: white; border: 1px solid #d9e2ef; border-radius: 10px; }
          h1 { margin: 0 0 16px; font-size: 28px; }
          h2 { margin-top: 26px; font-size: 20px; }
          code, pre { font: 16px ui-monospace, SFMono-Regular, Menlo, monospace; }
          pre { white-space: pre-wrap; padding: 14px 16px; border: 1px solid #cdd8e6; border-radius: 8px; background: #f8fbff; }
          .pending { padding: 14px 16px; border-radius: 8px; background: #fff8e6; border: 1px solid #ecd394; }
          .confirm { margin-top: 18px; padding: 12px 18px; border: 0; border-radius: 8px; background: #087f5b; color: white; font-weight: 700; font-size: 16px; cursor: pointer; }
          .confirm:disabled { background: #8795a1; cursor: default; }
        </style>
      </head>
      <body>
        <main>
          <h1>Real Telegram Human E2E</h1>
          <p>Use Telegram as <strong>${escapeHtml(params.visualUsername)}</strong> with bot <strong>${escapeHtml(params.botName)}</strong>.</p>
          <h2>1. List workflows</h2>
          <pre>List the workflow recipes I can run. Include the exact workflow recipe names.</pre>
          <h2>2. Check workflow status and health</h2>
          <pre>Check the status and health for ${escapeHtml(params.recipeName)}.</pre>
          <h2>3. Trigger this workflow</h2>
          <pre>Run ${escapeHtml(params.recipeName)} with marker: ${escapeHtml(params.marker)}. Give me the workflow result in this Telegram chat after it starts.</pre>
          <h2>4. Approve local tool gate if Telegram asks</h2>
          <pre>/approve</pre>
          <h2>5. Approve durable workflow request</h2>
          <div class="pending" data-testid="approval-instruction">Waiting for the Telegram workflow approval request. Approve it by workflow name, not by an internal id.</div>
          <h2>6. Download the workflow result artifact in Telegram</h2>
          <div class="pending" data-testid="artifact-instruction">Waiting for the workflow run to succeed before asking Telegram for the artifact document.</div>
          <button class="confirm" data-testid="artifact-confirmation" type="button" disabled>I opened/downloaded the Telegram document and saw the exact artifact proof</button>
          <script>
            window.__artifactConfirmed = false;
            const button = document.querySelector('[data-testid="artifact-confirmation"]');
            button.addEventListener('click', () => {
              window.__artifactConfirmed = true;
              button.textContent = 'Artifact document confirmed';
              button.disabled = true;
            });
          </script>
        </main>
      </body>
    </html>
  `)
  await expect(page.getByRole('heading', { name: 'Real Telegram Human E2E' })).toBeVisible()
  console.log(
    [
      'Real Telegram human E2E instructions:',
      `Bot: ${params.botName}`,
      `Telegram user: ${params.visualUsername}`,
      `Workflow recipe: ${params.recipeName}`,
      `Marker: ${params.marker}`,
      `Artifact proof: ${params.artifactProof}`,
      'When the run succeeds, ask Telegram to send the workflow result artifact as a downloadable document and confirm only after opening or downloading that document.',
    ].join('\n')
  )
  return page
}

export async function updateHumanInstructions(
  page: Page,
  params: { recipeName: string }
): Promise<void> {
  await page.getByTestId('approval-instruction').evaluate((node, recipeName) => {
    node.textContent = `Send this in Telegram: /approve ${recipeName}`
  }, params.recipeName)
  await expect(page.getByTestId('approval-instruction')).toContainText(params.recipeName)
}

export async function showArtifactInstructions(
  page: Page,
  params: { recipeName: string; artifactProof: string }
): Promise<void> {
  await page.getByTestId('artifact-instruction').evaluate((node, value) => {
    node.textContent = `Send this in Telegram: Show me the workflow result artifact for ${value.recipeName}. Send it as a downloadable document in this Telegram chat and include the artifact proof value from the output. Confirm only after Telegram shows a document attachment you can open or download, and the document content contains exactly: ${value.artifactProof}`
  }, params)
  await page.getByTestId('artifact-confirmation').evaluate(button => {
    ;(button as HTMLButtonElement).disabled = false
  })
  await expect(page.getByTestId('artifact-instruction')).toContainText(params.artifactProof)
}

export async function artifactConfirmed(page: Page, artifactProof: string): Promise<boolean> {
  if (downloadedArtifactContainsProof(artifactProof)) return true
  return page.evaluate(() => Boolean((window as any).__artifactConfirmed))
}

function downloadedArtifactContainsProof(artifactProof: string): boolean {
  const explicit = process.env.E2E_REAL_TELEGRAM_ARTIFACT_DOWNLOAD_PATH?.trim()
  const candidate =
    explicit || join(homedir(), 'Downloads', 'third-party-authn-first-party-mcphost-result.json')
  if (!existsSync(candidate)) return false
  const content = readFileSync(candidate, 'utf8')
  return content.includes(artifactProof)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}
