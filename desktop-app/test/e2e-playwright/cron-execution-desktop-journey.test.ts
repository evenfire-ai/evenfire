import { CRON_EXEC_PROBE_INSTRUCTION } from '../../../tests/e2e/fixtures/cronExecProbeInstruction.js'
import { getStatus, mcpHostExec } from '../../../tests/e2e/helpers.js'
import { expect, test } from './fixtures.js'
import {
  enterChatllmChat,
  expandResponseToolDetails,
  startFreshThread,
} from './workflowAgentChatTools.js'
import { sendChatPromptAndApproveToolCallsUntilText } from './workflowChatMultiToolApproval.js'

const RUN_DESKTOP_CRON = process.env.E2E_RUN_DESKTOP_CRON === '1'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test.describe.serial('Desktop cron execution regression for issue #529', () => {
  test.skip(
    !RUN_DESKTOP_CRON,
    'Set E2E_RUN_DESKTOP_CRON=1 to run the real-LLM Desktop cron journey.'
  )
  test.setTimeout(900_000)

  test('user creates and executes the canonical cron probe through Agent Chat', async ({
    appPage,
  }) => {
    const suffix = Date.now().toString(36)
    const jobName = `e2e-desktop-cron-${suffix}`
    const proofPath = `/tmp/${jobName}-proof.txt`
    const instruction = CRON_EXEC_PROBE_INSTRUCTION.replaceAll('e2e-cron-exec', jobName)
      .replaceAll('/tmp/cron-exec-proof.txt', proofPath)
      .replace('"*/1 * * * *"', '"0 0 1 1 *"')

    expect(instruction).toContain('cron_manage')
    expect(instruction).toContain(jobName)
    expect(instruction).toContain(proofPath)
    expect(instruction).toContain('CRON_EXEC_OK')
    expect(instruction).toContain('CRON_EXEC_VERIFIED')

    mcpHostExec(`rm -f ${proofPath}`)
    const baselineCronJobs = Number((await getStatus()).cronJobs ?? 0)
    await enterChatllmChat(appPage)
    await startFreshThread(appPage)
    let cronMutationAttempted = false
    let journeyError: unknown

    try {
      const response =
        await test.step('user submits the canonical recipe instruction and approves its tool calls', () => {
          cronMutationAttempted = true
          return sendChatPromptAndApproveToolCallsUntilText(
            appPage,
            instruction,
            [/CRON_EXEC_VERIFIED/],
            720_000,
            { approvalRequired: true, requiredText: [/cron|shell/i] }
          )
        })

      await test.step('Desktop exposes the real cron and shell execution evidence', async () => {
        await expandResponseToolDetails(response)
        const progress = response.getByTestId('progress-stepper').last()
        await expect(progress).toContainText(/cron/i)
        await expect(progress).toContainText(/shell/i)
        const completedCron = progress
          .locator('.stepper-step:has(.stepper-step-icon.state-completed)')
          .filter({ hasText: /cron_manage/i })
        const completedCronCount = await completedCron.count()
        expect(completedCronCount).toBeGreaterThanOrEqual(2)
        const cronOutputs: string[] = []
        for (let index = 0; index < completedCronCount; index += 1) {
          const row = completedCron.nth(index)
          await row.click()
          const output = row.locator(
            'xpath=following-sibling::*[1][@data-testid="step-output-panel"]'
          )
          await expect(output).toBeVisible()
          cronOutputs.push(await output.textContent().then(text => text ?? ''))
        }
        expect(cronOutputs.some(output => output.includes(jobName))).toBe(true)
        expect(cronOutputs.some(output => /"triggered"\s*:\s*true/i.test(output))).toBe(true)

        const completedShells = progress
          .locator('.stepper-step:has(.stepper-step-icon.state-completed)')
          .filter({ hasText: /Shell.*shell_exec/i })
        const completedShellCount = await completedShells.count()
        expect(completedShellCount).toBeGreaterThanOrEqual(1)
        const shellInputs: string[] = []
        for (let index = 0; index < completedShellCount; index += 1) {
          const row = completedShells.nth(index)
          const input = row.locator(
            'xpath=following-sibling::*[1][@data-testid="step-input-preview"]'
          )
          await expect(input).toBeVisible()
          shellInputs.push(await input.textContent().then(text => text ?? ''))
        }
        const proofReader = new RegExp(
          `^(?:sleep\\s+8\\s*(?:;|&&)\\s*)?cat\\s+['"]?${escapeRegExp(proofPath)}['"]?\\s*$`
        )
        expect(shellInputs.every(input => proofReader.test(input.trim()))).toBe(true)
        await expect(response).toContainText('CRON_EXEC_OK')
        await expect(response).toContainText('CRON_EXEC_VERIFIED')
        await expect(response).not.toContainText('CRON_EXEC_FAILED')
      })

      await test.step('the runtime confirms the unique schedule exists', async () => {
        await expect
          .poll(() => getStatus().then(status => Number(status.cronJobs ?? 0)), {
            timeout: 30_000,
            intervals: [500, 1_000, 2_000],
            message: `cron job count should increase after creating ${jobName}`,
          })
          .toBe(baselineCronJobs + 1)
      })

      await test.step('the unique cron dispatch created an independent proof file', async () => {
        await expect
          .poll(
            () => {
              try {
                return mcpHostExec(`cat ${proofPath}`).trim()
              } catch {
                return ''
              }
            },
            {
              timeout: 180_000,
              intervals: [1_000, 2_000, 5_000],
              message: `cron task ${jobName} should write its unique proof file`,
            }
          )
          .toBe('CRON_EXEC_OK')
      })
    } catch (error) {
      journeyError = error
    } finally {
      let cleanupError: unknown
      if (cronMutationAttempted) {
        try {
          const cleanupResponse = await sendChatPromptAndApproveToolCallsUntilText(
            appPage,
            `Use cron_manage to delete the cron job named "${jobName}". If it is already absent, report that clearly.`,
            [new RegExp(jobName), /deleted|removed|absent|not found|does not exist/i],
            240_000,
            { requiredText: [/cron/i] }
          )
          await expect(cleanupResponse).toContainText(jobName)
          await expect
            .poll(() => getStatus().then(status => Number(status.cronJobs ?? 0)), {
              timeout: 30_000,
              intervals: [500, 1_000, 2_000],
              message: `cron job count should return to baseline after deleting ${jobName}`,
            })
            .toBe(baselineCronJobs)
        } catch (error) {
          cleanupError = error
        }
      }
      try {
        mcpHostExec(`rm -f ${proofPath}`)
      } catch (error) {
        cleanupError ??= error
      }
      if (journeyError) throw journeyError
      if (cleanupError) throw cleanupError
    }
  })
})
