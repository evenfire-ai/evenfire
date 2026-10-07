/**
 * E2E_GUARDIAN_IPC_FLOW: visible login -> owned Host/model -> Send -> real shell
 * approval -> real Host X11 screenshot -> visible pixels -> one durable task.
 * Main prepares only a QA image on the owned Host's display. The vendor fixture
 * receives actual tool-result pixels, never the expected answer or source file.
 * Screenshot pixels are a new frame: its wire digest need not equal the input PNG.
 */
import { randomUUID } from 'node:crypto'
import { expect, subscriptionImageRun as run, sha256, test } from './subscriptionImageFixtures.js'
import { preparedPixelCode, readRemainingFixture } from './subscriptionRemainingJourneyData.js'
import {
  assertPixelVendorEvidence,
  observeDurableTurn,
  observeVisibleApprovalTask,
  openOwnedChat,
  outputPattern,
  settledVisibleAnswer,
  showCompletedTools,
  submitVisibly,
} from './subscriptionRemainingJourneyUi.js'
import {
  type ScreenFixture,
  requireRemainingJourney,
} from './subscriptionRemainingJourneysContract.js'

const input = requireRemainingJourney('tool-screenshot', run)
let fixtures: Record<string, ScreenFixture>
test.beforeAll(() => {
  fixtures = readRemainingFixture(input, run).fixtures as Record<string, ScreenFixture>
})

for (const binding of run.bindings) {
  test(`${binding.provider} real desktop screenshot tool yields pixel evidence after visible approval`, async ({
    appPage,
  }, testInfo) => {
    const fixture = fixtures[binding.provider]!
    const code = await preparedPixelCode(run, fixture)
    const receiptId = randomUUID()
    const prompt = [
      'Journey: tool-screenshot',
      `Screen fixture: ${fixture.hostImagePath}`,
      `Screenshot region: ${JSON.stringify(fixture.region)}`,
      'First use shell_exec to check that the prepared screen file exists with exactly this command:',
      `test -r ${fixture.hostImagePath}`,
      'Wait for my visible approval. Then use desktop_screenshot once for that region of the actual desktop.',
      'Read the 64-bit hexadecimal challenge from its pixels. Reply with that code only.',
      'Do not use OCR, read the PNG with another tool, or infer the answer from the path.',
      `Receipt: ${receiptId}`,
    ].join('\n')
    expect(prompt).not.toContain(code)
    await openOwnedChat(appPage, binding)
    await submitVisibly(appPage, binding, prompt)
    let approvedTaskId: string | undefined
    await test.step('inspect and grant the real shell approval in the visible task', async () => {
      const approve = appPage.getByTestId('approval-approve-btn')
      await expect(approve).toHaveCount(1, { timeout: 60_000 })
      await expect(approve).toBeVisible()
      const stepper = appPage.getByTestId('progress-stepper').filter({ has: approve })
      await expect(stepper).toHaveClass(/status-suspended/)
      await expect(stepper.getByRole('status')).toContainText(/shell.*requires approval/i)
      approvedTaskId = await observeVisibleApprovalTask(appPage, binding)
      await approve.click()
      await expect(approve).toHaveCount(0)
      await expect(
        appPage.getByText(`Approved request for ${binding.hostRef}.`, { exact: true })
      ).toBeVisible()
    })
    const expected = outputPattern([code])
    await settledVisibleAnswer(appPage, binding, expected)
    await showCompletedTools(appPage, ['shell_exec', 'desktop_screenshot'])
    const turn = await observeDurableTurn(appPage, binding, {
      status: 'completed',
      response: expected,
    })
    expect(turn.taskId).toBe(approvedTaskId)
    expect(turn.userAttachments).toEqual([])
    expect(turn.toolSteps).toEqual([
      { toolName: 'shell_exec', state: 'completed' },
      { toolName: 'desktop_screenshot', state: 'completed' },
    ])
    await assertPixelVendorEvidence(
      run,
      binding,
      receiptId,
      {
        journey: 'tool-screenshot',
        stages: ['prepare', 'capture', 'pixels'],
        mimeTypes: ['image/png'],
        output: code,
        calls: [
          {
            name: 'shell_exec',
            argumentsSha256: sha256(
              JSON.stringify({ command: `test -r ${fixture.hostImagePath}` })
            ),
          },
          {
            name: 'desktop_screenshot',
            argumentsSha256: sha256(JSON.stringify({ region: fixture.region })),
          },
        ],
      },
      turn,
      testInfo
    )
    await testInfo.attach('tool-screenshot-source-identity', {
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify({
          runId: run.runId,
          hostRef: fixture.hostRef,
          podUid: fixture.podUid,
          imageId: fixture.imageId,
          preparedImageSha256: fixture.imageSha256,
          captureRegion: fixture.region,
          taskId: turn.taskId,
          tool: 'desktop_screenshot',
        })
      ),
    })
  })
}
