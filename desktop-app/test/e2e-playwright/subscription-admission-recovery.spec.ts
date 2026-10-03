/**
 * E2E_GUARDIAN_IPC_FLOW: visible login -> owned Host/model -> visible Send while
 * the real authorizer owner is held -> visible terminal refusal -> actual owner
 * drain -> visible new chat/text Send -> primary completion and durable tasks.
 * The private companion prepares competing authorized incomplete bodies only.
 * It never sends, authenticates, selects, or advances the Desktop business flow.
 * Native inspector observations belong to the actual server instance and PID;
 * unknown/missing ownership is a failure, never a synthetic counter or UI error.
 */
import { randomUUID } from 'node:crypto'
import { openAdmissionPressure } from '../../../scripts/e2e/fixtures/subscription-image-admission-pressure.mjs'
import {
  expect,
  readVendorAttempts,
  subscriptionImageRun as run,
  sha256,
  test,
} from './subscriptionImageFixtures.js'
import { readRemainingFixture } from './subscriptionRemainingJourneyData.js'
import {
  assertPrimary,
  observeDurableTurn,
  openOwnedChat,
  outputPattern,
  settledVisibleAnswer,
  submitVisibly,
} from './subscriptionRemainingJourneyUi.js'
import {
  type AdmissionFixture,
  type FixtureReceipt,
  requireRemainingJourney,
} from './subscriptionRemainingJourneysContract.js'

const input = requireRemainingJourney('admission-recovery', run)
let receipt: FixtureReceipt
test.beforeAll(() => {
  receipt = readRemainingFixture(input, run)
})
type OwnerObservation = {
  pressureRunId: string
  maxInFlight: number
  owners: { baseline: number; held: number; drained: number }
  counts: { sameRunAttempts: number; sameRunTickets: number; reservations: number }
  pids: number[]
  inspector: { pid: number; startTime: string }
}

function assertSameNativeOwner(
  observation: OwnerObservation,
  reference: OwnerObservation,
  maxInFlight: number
): void {
  expect(observation.pressureRunId).toBe(reference.pressureRunId)
  expect(observation.maxInFlight).toBe(maxInFlight)
  expect(observation.inspector).toEqual(reference.inspector)
  expect(observation.pids).toEqual(reference.pids)
  expect(observation.pids).toContain(observation.inspector.pid)
  expect(observation.owners.baseline).toBe(0)
  expect(observation.counts).toEqual({ sameRunAttempts: 0, sameRunTickets: 0, reservations: 0 })
}

for (const binding of run.bindings) {
  test(`${binding.provider} local admission refusal settles visibly and a subsequent text turn stays on primary`, async ({
    appPage,
  }, testInfo) => {
    const fixture = receipt.fixtures[binding.provider] as AdmissionFixture
    // Keep the configured visible-journey budget and separately admit the nine
    // bounded private commands (including finally release/close on failure).
    test.setTimeout(testInfo.timeout + 9 * fixture.pressure.commandDeadlineMs)
    await openOwnedChat(appPage, binding)
    const refusalReceiptId = randomUUID()
    const refusalPrompt = `Reply with TEXT_RECEIPT:${refusalReceiptId} only. Receipt: ${refusalReceiptId}`
    await appPage.getByTestId('chat-input').fill(refusalPrompt)
    const pressure = await openAdmissionPressure({
      receiptFile: fixture.pressure.receiptFile,
    })
    let released = false
    try {
      const metadata = pressure.metadata
      expect(metadata.profile).toBe(run.profile)
      expect(metadata.context).toBe(run.context)
      expect(metadata.sourceManifestSha256).toBe(receipt.sourceManifestSha256)
      expect(metadata.podUid).toBe(fixture.controlApiPodUid)
      expect(metadata.imageId).toBe(fixture.controlApiImageId)
      expect(metadata.maxInFlight).toBe(fixture.maxInFlight)
      expect(metadata.commandDeadlineMs).toBe(fixture.pressure.commandDeadlineMs)
      expect(metadata.readDeadlineMs).toBe(fixture.readDeadlineMs)
      expect(metadata.workDeadlineMs).toBe(fixture.pressure.workDeadlineMs)
      expect(metadata.closeGraceMs).toBe(fixture.pressure.closeGraceMs)
      expect(new Set(metadata.hostRefs)).toEqual(new Set(run.bindings.map(item => item.hostRef)))
      const baseline = (await pressure.owners()) as OwnerObservation
      expect(baseline.pressureRunId).toBe(metadata.pressureRunId)
      assertSameNativeOwner(baseline, baseline, fixture.maxInFlight)
      expect(baseline.owners).toEqual({ baseline: 0, held: 0, drained: 0 })
      const held = (await pressure.hold({ maxInFlight: fixture.maxInFlight })) as OwnerObservation
      assertSameNativeOwner(held, baseline, fixture.maxInFlight)
      expect(held.owners.held).toBe(fixture.maxInFlight)
      await test.step('send through Desktop and inspect the local refusal while actual owners remain held', async () => {
        await submitVisibly(appPage, binding, refusalPrompt)
        const response = appPage.getByTestId('agent-response')
        await expect(response).toHaveCount(1, { timeout: 60_000 })
        await expect(response).toHaveClass(/chat-bubble--error/)
        await expect(response.locator('.error-bubble-label')).toContainText(/Connection Error/i)
        await expect(response.locator('.error-bubble-message')).toContainText(
          /authorize.*503|authorize_capacity_exceeded|admission.*full/i
        )
        await response.getByText('Details', { exact: true }).click()
        await expect(response.locator('.error-bubble-details-text')).toBeVisible()
        await expect(response.locator('.error-bubble-details-text')).toContainText(
          /authorize.*503|authorize_capacity_exceeded|admission.*full/i
        )
        await expect(appPage.locator('.chat-message--in-flight')).toHaveCount(0)
        await expect(appPage.getByTestId('send-button')).toHaveAttribute(
          'aria-label',
          'Send message'
        )
        await expect(appPage.getByTestId('chat-input')).toBeEnabled()
        await assertPrimary(appPage, binding)
      })
      const stillHeld = (await pressure.owners()) as OwnerObservation
      assertSameNativeOwner(stillHeld, baseline, fixture.maxInFlight)
      expect(stillHeld.owners.held).toBe(fixture.maxInFlight)
      const failed = await observeDurableTurn(appPage, binding, { status: 'failed' })
      expect(failed.error).toMatchObject({
        code: 'LLM_API_CALL_FAILED',
        retryable: false,
        provider: binding.provider,
      })
      expect(failed.toolSteps).toEqual([])
      for (const target of run.bindings)
        expect(
          readVendorAttempts(run, target).filter(row => row.receiptId === refusalReceiptId)
        ).toHaveLength(0)
      const beforeRelease = (await pressure.owners()) as OwnerObservation
      assertSameNativeOwner(beforeRelease, baseline, fixture.maxInFlight)
      expect(beforeRelease.owners.held).toBe(fixture.maxInFlight)
      const drained = (await pressure.release()) as OwnerObservation
      released = true
      assertSameNativeOwner(drained, baseline, fixture.maxInFlight)
      expect(drained.owners.drained).toBe(0)
      const afterRelease = (await pressure.owners()) as OwnerObservation
      assertSameNativeOwner(afterRelease, baseline, fixture.maxInFlight)
      expect(afterRelease.owners.drained).toBe(0)
      await openOwnedChat(appPage, binding)
      const recoveryReceiptId = randomUUID()
      const recoveryPrompt = `Reply with TEXT_RECEIPT:${recoveryReceiptId} only. Receipt: ${recoveryReceiptId}`
      await submitVisibly(appPage, binding, recoveryPrompt)
      const expectedOutput = `TEXT_RECEIPT:${recoveryReceiptId}`
      const expected = outputPattern([expectedOutput])
      await settledVisibleAnswer(appPage, binding, expected)
      const recovered = await observeDurableTurn(appPage, binding, {
        status: 'completed',
        response: expected,
      })
      expect(recovered.taskId).not.toBe(failed.taskId)
      expect(recovered.chatId).not.toBe(failed.chatId)
      expect(recovered.toolSteps).toEqual([])
      await expect
        .poll(
          () => readVendorAttempts(run, binding).filter(row => row.receiptId === recoveryReceiptId),
          { timeout: 20_000 }
        )
        .toHaveLength(1)
      const wire = readVendorAttempts(run, binding).find(
        row => row.receiptId === recoveryReceiptId
      )!
      expect(wire.model).toBe(binding.modelId)
      expect(wire.responseKind).toBe('text')
      expect(wire.imageSha256).toEqual([])
      expect(wire.outputSha256).toBe(sha256(expectedOutput))
      for (const other of run.bindings.filter(item => item.provider !== binding.provider)) {
        expect(
          readVendorAttempts(run, other).filter(row => row.receiptId === recoveryReceiptId)
        ).toHaveLength(0)
      }
      await testInfo.attach('admission-refusal-and-primary-recovery', {
        contentType: 'application/json',
        body: Buffer.from(
          JSON.stringify({
            runId: run.runId,
            provider: binding.provider,
            hostRef: binding.hostRef,
            model: binding.modelId,
            failedTaskId: failed.taskId,
            recoveredTaskId: recovered.taskId,
            refusalReceiptId,
            recoveryReceiptId,
            controlApiPodUid: fixture.controlApiPodUid,
            controlApiImageId: fixture.controlApiImageId,
            nativeOwner: { baseline, held, stillHeld, beforeRelease, drained, afterRelease },
            recoveryWire: {
              sequence: wire.sequence,
              requestSha256: wire.requestSha256,
              outputSha256: wire.outputSha256,
            },
          })
        ),
      })
    } finally {
      try {
        if (!released) await pressure.release()
      } finally {
        await pressure.close()
      }
    }
  })
}
