/**
 * E2E_GUARDIAN_IPC_FLOW: visible login -> owned Host/model -> the real
 * authorizer's retained-body unit is held -> visible text Send -> primary
 * completion and durable task while the unit is still held -> actual owner
 * drain -> visible new chat/text Send -> primary completion and durable tasks.
 * A text authorize body fits the ordinary parser and never takes the retained
 * unit, so a held unit must not delay or refuse it. The refusal reasons of the
 * retained path (principal_share, queue_full, queue_wait) are covered by the
 * control-api HTTP tests; a visible image refusal journey is not part of this
 * lane. The private companion prepares competing authorized incomplete bodies
 * only. It never sends, authenticates, selects, or advances the Desktop
 * business flow. Native inspector observations belong to the actual server
 * instance and PID; unknown/missing ownership is a failure, never a synthetic
 * counter or UI error.
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

async function completeTextTurn(
  appPage: Parameters<typeof submitVisibly>[0],
  binding: (typeof run.bindings)[number],
  afterVisibleAnswer?: () => Promise<void>
) {
  const receiptId = randomUUID()
  const prompt = `Reply with TEXT_RECEIPT:${receiptId} only. Receipt: ${receiptId}`
  await submitVisibly(appPage, binding, prompt)
  const expectedOutput = `TEXT_RECEIPT:${receiptId}`
  const expected = outputPattern([expectedOutput])
  await settledVisibleAnswer(appPage, binding, expected)
  if (afterVisibleAnswer) await afterVisibleAnswer()
  const turn = await observeDurableTurn(appPage, binding, {
    status: 'completed',
    response: expected,
  })
  expect(turn.toolSteps).toEqual([])
  await expect
    .poll(() => readVendorAttempts(run, binding).filter(row => row.receiptId === receiptId), {
      timeout: 20_000,
    })
    .toHaveLength(1)
  const wire = readVendorAttempts(run, binding).find(row => row.receiptId === receiptId)!
  expect(wire.model).toBe(binding.modelId)
  expect(wire.responseKind).toBe('text')
  expect(wire.imageSha256).toEqual([])
  expect(wire.outputSha256).toBe(sha256(expectedOutput))
  // The exact-one primary attempt above is the witness for this zero.
  for (const other of run.bindings.filter(item => item.provider !== binding.provider)) {
    expect(readVendorAttempts(run, other).filter(row => row.receiptId === receiptId)).toHaveLength(
      0
    )
  }
  return { turn, receiptId, wire }
}

for (const binding of run.bindings) {
  test(`${binding.provider} text turn completes on primary while the retained authorize unit is held`, async ({
    appPage,
  }, testInfo) => {
    const fixture = receipt.fixtures[binding.provider] as AdmissionFixture
    // Keep the configured visible-journey budget and separately admit the eight
    // bounded private commands (including finally release/close on failure).
    test.setTimeout(testInfo.timeout + 8 * fixture.pressure.commandDeadlineMs)
    await openOwnedChat(appPage, binding)
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
      const heldAt = Date.now()
      assertSameNativeOwner(held, baseline, fixture.maxInFlight)
      expect(held.owners.held).toBe(fixture.maxInFlight)
      // The holder's incomplete body is answered 408 at the read deadline, after
      // which the unit cannot be re-held. If text authorizes still queued behind
      // the retained unit, the answer could only appear after that 408 and both
      // checks below fail; they are the witness that the turn ran while held.
      // Both run as soon as the answer is visible, before the durable and
      // vendor reads, so those reads do not count against the deadline.
      let settledMs = -1
      let stillHeld: OwnerObservation | undefined
      const whileHeld =
        await test.step('send text through Desktop while the retained unit is held', () =>
          completeTextTurn(appPage, binding, async () => {
            settledMs = Date.now() - heldAt
            expect(
              settledMs,
              `text answer must appear inside the holder's ${fixture.readDeadlineMs} ms read deadline`
            ).toBeLessThan(fixture.readDeadlineMs)
            stillHeld = (await pressure.owners()) as OwnerObservation
            assertSameNativeOwner(stillHeld, baseline, fixture.maxInFlight)
            expect(
              stillHeld.owners.held,
              'the retained unit must still be held when the text answer is visible'
            ).toBe(fixture.maxInFlight)
          }))
      expect(stillHeld, 'the held-unit witness must have run').toBeDefined()
      const drained = (await pressure.release()) as OwnerObservation
      released = true
      assertSameNativeOwner(drained, baseline, fixture.maxInFlight)
      expect(drained.owners.drained).toBe(0)
      const afterRelease = (await pressure.owners()) as OwnerObservation
      assertSameNativeOwner(afterRelease, baseline, fixture.maxInFlight)
      expect(afterRelease.owners.drained).toBe(0)
      await openOwnedChat(appPage, binding)
      const recovered =
        await test.step('send text through Desktop after the unit is released', () =>
          completeTextTurn(appPage, binding))
      expect(recovered.turn.taskId).not.toBe(whileHeld.turn.taskId)
      expect(recovered.turn.chatId).not.toBe(whileHeld.turn.chatId)
      await testInfo.attach('text-while-held-and-after-release', {
        contentType: 'application/json',
        body: Buffer.from(
          JSON.stringify({
            runId: run.runId,
            provider: binding.provider,
            hostRef: binding.hostRef,
            model: binding.modelId,
            heldTaskId: whileHeld.turn.taskId,
            releasedTaskId: recovered.turn.taskId,
            heldReceiptId: whileHeld.receiptId,
            releasedReceiptId: recovered.receiptId,
            heldSettledMs: settledMs,
            controlApiPodUid: fixture.controlApiPodUid,
            controlApiImageId: fixture.controlApiImageId,
            nativeOwner: { baseline, held, stillHeld, drained, afterRelease },
            heldWire: {
              sequence: whileHeld.wire.sequence,
              requestSha256: whileHeld.wire.requestSha256,
              outputSha256: whileHeld.wire.outputSha256,
            },
            releasedWire: {
              sequence: recovered.wire.sequence,
              requestSha256: recovered.wire.requestSha256,
              outputSha256: recovered.wire.outputSha256,
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
