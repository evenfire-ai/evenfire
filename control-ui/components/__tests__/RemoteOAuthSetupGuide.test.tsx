import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import type { RegistryRemoteOAuthBlock } from '../../lib/api'
import {
  CURATOR_HOSTILE_GUIDE_ENTRY,
  CURATOR_WORKIQ_ENTRY,
} from '../../test/fixtures/catalogRemoteOAuthWire'
import { RemoteOAuthSetupGuide } from '../RemoteOAuthSetupGuide'

/**
 * The setup guide is Markdown from a registry entry. These tests render the guide
 * control-api actually serves (catalogRemoteOAuthWire goldens) through the real
 * `MDEditor.Markdown` pipeline and assert the resulting DOM.
 */

afterEach(cleanup)

function oauthOf(entry: { mcp_server_meta: unknown }): RegistryRemoteOAuthBlock {
  return (entry.mcp_server_meta as { oauth: RegistryRemoteOAuthBlock }).oauth
}

async function renderGuide(block: RegistryRemoteOAuthBlock) {
  render(
    <RemoteOAuthSetupGuide guide={block.setupGuide} providerConsoleUrl={block.providerConsoleUrl}>
      <div>redirect field</div>
    </RemoteOAuthSetupGuide>
  )
  const article = await screen.findByRole('article', {
    name: 'Setup guide from the Marketplace curator',
  })
  // The renderer is loaded client-side; wait for the parsed document, not the loader.
  await waitFor(() => expect(within(article).queryByRole('status')).not.toBeInTheDocument(), {
    timeout: 10000,
  })
  return article
}

describe('RemoteOAuthSetupGuide', () => {
  it('neutralizes every unsafe construct in the guide: nothing executable, no image, only https links', async () => {
    const block = oauthOf(CURATOR_HOSTILE_GUIDE_ENTRY)
    expect(block.setupGuide).toContain('<script>')
    const article = await renderGuide(block)

    await within(article).findByRole('heading', { name: 'Register the app' })

    // Nothing active survives, raw HTML included.
    expect(
      article.querySelectorAll(
        'script, iframe, object, embed, style, form, img, [onclick], [onerror], [onload], [src]'
      )
    ).toHaveLength(0)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()

    // Exactly one link: the https one, opening in a new tab without referrer or opener.
    const links = article.querySelectorAll('a')
    expect(links).toHaveLength(1)
    const safe = within(article).getByRole('link', { name: 'Safe console' })
    expect(safe).toHaveAttribute('href', 'https://console.example.com/apps')
    expect(safe).toHaveAttribute('target', '_blank')
    expect(safe).toHaveAttribute('rel', 'noopener noreferrer')

    // Every other link is plain text.
    for (const text of [
      'Script link',
      'Plain http link',
      'Protocol-relative link',
      'Relative link',
      'Mail link',
      'Data link',
      'Raw script anchor',
      'Raw http anchor',
    ]) {
      expect(within(article).getByText(text).closest('a')).toBeNull()
    }
    // The GFM `www.` autolink would be an http: link; it stays text.
    expect(article).toHaveTextContent('www.autolink.example.com')
    // Images, Markdown or raw, render as their alt text.
    expect(article).toHaveTextContent('[Image: Markdown image]')
    expect(article).toHaveTextContent('Inline handler text')
    expect((window as { setupGuidePwned?: boolean }).setupGuidePwned).toBeUndefined()
  })

  it('renders a real guide with its structure, the console button and the redirect field below', async () => {
    const block = oauthOf(CURATOR_WORKIQ_ENTRY)
    const article = await renderGuide(block)

    expect(within(article).getAllByRole('listitem').length).toBeGreaterThanOrEqual(3)
    expect(within(article).getByText('Authentication').tagName).toBe('STRONG')

    const consoleLink = screen.getByRole('link', { name: 'Open entra.microsoft.com' })
    expect(consoleLink).toHaveAttribute('href', block.providerConsoleUrl)
    expect(consoleLink).toHaveAttribute('target', '_blank')
    expect(consoleLink).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByText('redirect field')).toBeInTheDocument()
  })

  it('never links a console URL that is not https', () => {
    render(<RemoteOAuthSetupGuide providerConsoleUrl="http://console.example.com/apps" />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
