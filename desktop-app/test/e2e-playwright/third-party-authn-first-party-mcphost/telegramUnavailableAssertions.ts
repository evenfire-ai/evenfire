import { type Page, expect } from '@playwright/test'
import { telegramReplyItems } from './telegramE2eClient'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function waitForWorkflowUnavailableReply(
  page: Page,
  previousCount: number,
  recipeName: string
): Promise<void> {
  const escapedRecipe = escapeRegExp(recipeName)
  const denial =
    "not available|unable to run|cannot run|can't run|cannot trigger|not authorized|not permitted|no access|doesn'?t exist|not found|couldn'?t find|could not find|no matching"
  const explicitDenial = new RegExp(
    `(${escapedRecipe}[\\s\\S]{0,500}(${denial})|(${denial})[\\s\\S]{0,500}${escapedRecipe})`,
    'i'
  )
  const listFallback =
    /(available workflow recipes|workflow recipes|workflow_list|recipes you can|can trigger|can run|available to this conversation|did you mean)/i

  await expect
    .poll(
      async () => {
        const replies = await telegramReplyItems(page).evaluateAll(
          (nodes, count) => nodes.slice(count).map(node => node.textContent || ''),
          previousCount
        )
        const matchedReply = replies.some(text => {
          if (text.includes('Processing your request')) return false
          if (text.includes('Approved. Workflow approval recorded.')) return false
          if (explicitDenial.test(text)) return true
          return listFallback.test(text) && !new RegExp(escapedRecipe, 'i').test(text)
        })
        if (!matchedReply) {
          const finalReplyCount = replies.filter(
            text =>
              !text.includes('Processing your request') &&
              !text.includes('Approved. Workflow approval recorded.')
          ).length
          if (finalReplyCount === 0) return false
          const listCard = page.getByTestId('telegram-workflow-list-card')
          const list = page.getByTestId('telegram-workflow-list')
          const isListVisible = await listCard.isVisible().catch(() => false)
          const listText = (await list.textContent().catch(() => '')) || ''
          return isListVisible && !new RegExp(escapedRecipe, 'i').test(listText)
        }
        return true
      },
      {
        timeout: 180_000,
        intervals: [500, 1_000, 2_000],
        message: `Telegram fake client should show ${recipeName} denied or omitted from the visible workflow choices`,
      }
    )
    .toBe(true)
}
