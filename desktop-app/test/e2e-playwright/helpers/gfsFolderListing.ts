// The Control UI EvenDrive browser lists a folder up to a page cap and offers
// "Load more" (control-ui/components/GfsBrowser.tsx:3244-3258). /Users keeps the
// home of every retired user, so a new test home can sit past the first page.
// Structural types and no Playwright import: Control UI specs load this file
// from desktop-app, which has its own @playwright/test copy and types.

interface ListingLocator {
  count(): Promise<number>
  isVisible(): Promise<boolean>
  textContent(): Promise<string | null>
  click(options: { timeout: number }): Promise<void>
  waitFor(options: { state: 'visible' | 'hidden'; timeout: number }): Promise<void>
}

interface ListingPage {
  getByText(text: RegExp | string, options?: { exact?: boolean }): ListingLocator
  getByRole(role: 'button', options: { name: string; exact?: boolean }): ListingLocator
}

const MAX_PAGES = 20

/** Clicks "Load more" until `target` is listed, as an operator would. */
export async function revealInFolderListing(
  page: ListingPage,
  target: ListingLocator
): Promise<void> {
  // The count line ("Showing the first 100 items." / "Showing all 118 items.")
  // renders only once the listing has settled.
  const countLine = page.getByText(/^Showing (all|the first) \d+ items?\.$/)
  await countLine.waitFor({ state: 'visible', timeout: 30_000 })
  const loadMore = page.getByRole('button', { name: 'Load more', exact: true })
  for (let pages = 1; (await target.count()) === 0; pages++) {
    const shown = await countLine.textContent()
    if (shown === null) throw new Error('The folder count line has no text')
    if (!(await loadMore.isVisible())) {
      throw new Error(`${target} is not listed: "${shown}" and there is no "Load more"`)
    }
    if (pages >= MAX_PAGES) throw new Error(`${target} is not listed within ${MAX_PAGES} pages`)
    await loadMore.click({ timeout: 10_000 })
    // The appended page changes the count line.
    await page.getByText(shown, { exact: true }).waitFor({ state: 'hidden', timeout: 30_000 })
    await countLine.waitFor({ state: 'visible', timeout: 30_000 })
  }
}
