import { describe, expect, it } from 'vitest'
import { renderSuccessHtml } from '../src/routes/external/oauthCallback.js'

describe('renderSuccessHtml (spec §9.9 OAuth callback success page)', () => {
  it('redirects via meta-refresh to clerum://oauth-completed with clientId + provider', () => {
    const html = renderSuccessHtml('slack', 'slack-bot')
    expect(html).toMatch(/<meta http-equiv="refresh"\s+content="0;url=clerum:\/\//i)
    // URLSearchParams encodes the params; in HTML attribute context, & → &amp;.
    expect(html).toContain('clientId=slack-bot')
    expect(html).toContain('provider=slack')
  })

  it('also includes a JS-side replace as a fallback', () => {
    const html = renderSuccessHtml('slack', 'slack-bot')
    expect(html).toContain('window.location.replace(')
    expect(html).toContain('clerum://oauth-completed')
  })

  it('renders a clickable link as a fallback when neither meta-refresh nor JS fires', () => {
    const html = renderSuccessHtml('slack', 'slack-bot')
    expect(html).toMatch(/<a href="clerum:\/\/oauth-completed[^"]+"/)
  })

  it('strips disallowed characters from the provider field (defence-in-depth)', () => {
    const html = renderSuccessHtml('slack"><script>alert(1)</script>', 'cid')
    expect(html).not.toContain('<script>alert(1)</script>')
    // The provider has been filtered to just the [a-z0-9-] residue.
    expect(html).toContain('slackscriptalert1script')
  })

  it('safely escapes a clientId that contains HTML-special characters', () => {
    const html = renderSuccessHtml('slack', 'cid&"<wat')
    // Quotes from clientId must not break the href / content attribute.
    expect(html).not.toContain('href="clerum://oauth-completed?clientId=cid&"')
    // `<` from clientId must not appear unescaped inside an attribute value.
    expect(html).not.toMatch(/href="[^"]*<wat/)
    // The literal `&` character from clientId must not appear in attribute
    // context (it must be HTML-escaped to `&amp;`).
    const metaContent = /content="0;url=([^"]+)"/.exec(html)?.[1] ?? ''
    expect(metaContent).not.toMatch(/&(?!amp;|quot;|lt;|gt;|#)/)
  })

  it('recipe subject (no source opt) emits a FROZEN deep-link with NO source/mcpServerName param', () => {
    const html = renderSuccessHtml('slack', 'slack-bot')
    const metaContent = /content="0;url=([^"]+)"/.exec(html)?.[1] ?? ''
    expect(metaContent).not.toContain('source')
    expect(metaContent).not.toContain('mcpServerName')
    // Same when opts is present but source is absent — a stray mcpServerName in
    // opts must NOT leak into the recipe deep-link (only the mcp path forwards it).
    const html2 = renderSuccessHtml('slack', 'slack-bot', {
      backgroundEnabled: true,
      mcpServerName: 'should-not-appear',
    })
    const meta2 = /content="0;url=([^"]+)"/.exec(html2)?.[1] ?? ''
    expect(meta2).not.toContain('source')
    expect(meta2).not.toContain('mcpServerName')
  })

  it('mcp subject appends &source=mcp AND &mcpServerName=<X> on the same oauth-completed host', () => {
    const html = renderSuccessHtml('google', 'google-drive', {
      source: 'mcp',
      mcpServerName: 'gdrive',
    })
    const metaContent = /content="0;url=([^"]+)"/.exec(html)?.[1] ?? ''
    // HTML-attribute context escapes `&` → `&amp;`; decode for a clean parse.
    const url = new URL(metaContent.replace(/&amp;/g, '&'))
    expect(url.protocol).toBe('clerum:')
    expect(url.host).toBe('oauth-completed')
    expect(url.searchParams.get('clientId')).toBe('google-drive')
    expect(url.searchParams.get('provider')).toBe('google')
    expect(url.searchParams.get('source')).toBe('mcp')
    expect(url.searchParams.get('mcpServerName')).toBe('gdrive')
  })

  it('JSON-escapes the URL inside the inline <script> to block </script> injection', () => {
    // Even if a clientId carried `</script>`, the JSON.stringify+\\u003c
    // replace should keep it from closing the inline script tag.
    const html = renderSuccessHtml('slack', 'cid</script><script>alert(1)</script>')
    const scriptStart = html.indexOf('<script>')
    const scriptEnd = html.indexOf('</script>', scriptStart + 1)
    expect(scriptStart).toBeGreaterThan(-1)
    expect(scriptEnd).toBeGreaterThan(scriptStart)
    const scriptInner = html.slice(scriptStart + '<script>'.length, scriptEnd)
    expect(scriptInner).not.toContain('</script>')
  })
})
