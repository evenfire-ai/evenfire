import { expect, test } from '@playwright/test'

const INITIAL_DRAFT =
  'before [Project Plan](gfs://main/0123456789abcdef0123456789abcdef)' +
  '[Roadmap](gfs://main/abcdef0123456789abcdef0123456789) after'
const EDITED_LABEL_DRAFT = INITIAL_DRAFT.replace('Project Plan', 'Release notes')

test('link label, clipboard edits, undo and send preserve canonical Markdown source', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/markdown-source-editor-test.html')

  const editor = page.getByTestId('markdown-source')
  await page.getByRole('link', { name: 'Project Plan' }).click()
  await expect(editor).toBeFocused()

  const linkStart = INITIAL_DRAFT.indexOf('[Project Plan]')
  const linkEnd = INITIAL_DRAFT.indexOf(')') + 1
  await expect
    .poll(() =>
      editor.evaluate(element => {
        const textarea = element as HTMLTextAreaElement
        return [textarea.selectionStart, textarea.selectionEnd]
      })
    )
    .toEqual([linkStart, linkEnd])

  await editor.press('ArrowLeft')
  await editor.press('ArrowRight')
  for (let index = 0; index < 'Project Plan'.length; index += 1) {
    await editor.press('Shift+ArrowRight')
  }
  await editor.pressSequentially('Release notes')
  await expect(editor).toHaveValue(EDITED_LABEL_DRAFT)
  await expect(page.getByTestId('canonical-draft')).toHaveText(EDITED_LABEL_DRAFT)
  await expect(page.getByRole('link', { name: 'Release notes' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Roadmap' })).toBeVisible()

  await page.evaluate(() => navigator.clipboard.writeText(' pasted text'))
  await editor.evaluate(element => {
    const textarea = element as HTMLTextAreaElement
    textarea.focus()
    textarea.setSelectionRange(0, 0)
  })
  await editor.press('ControlOrMeta+v')
  const pastedDraft = ` pasted text${EDITED_LABEL_DRAFT}`
  await expect(editor).toHaveValue(pastedDraft)
  await expect(page.getByTestId('canonical-draft')).toHaveText(pastedDraft)

  const pastedStart = 1
  const pastedEnd = pastedStart + 'pasted text'.length
  await editor.evaluate(
    (element, range) => {
      const textarea = element as HTMLTextAreaElement
      textarea.setSelectionRange(range.start, range.end)
    },
    { start: pastedStart, end: pastedEnd }
  )
  await editor.press('ControlOrMeta+x')
  const cutDraft = ` ${EDITED_LABEL_DRAFT}`
  await expect(editor).toHaveValue(cutDraft)
  await expect(page.getByTestId('canonical-draft')).toHaveText(cutDraft)
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('pasted text')

  await editor.press('ControlOrMeta+z')
  await expect(editor).toHaveValue(pastedDraft)
  await expect(page.getByTestId('canonical-draft')).toHaveText(pastedDraft)
  await editor.press('ControlOrMeta+Shift+z')
  await expect(editor).toHaveValue(cutDraft)
  await expect(page.getByTestId('canonical-draft')).toHaveText(cutDraft)

  await page.getByRole('button', { name: 'Send current draft' }).click()
  await expect(page.getByTestId('sent-source')).toHaveText(cutDraft)
})
