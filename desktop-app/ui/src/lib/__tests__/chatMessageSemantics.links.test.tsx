// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import fc from 'fast-check'
import type { Element, Root, RootContent } from 'hast'
import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import { ChatMarkdownContent } from '@components/agents/ChatMarkdownContent'
import { externalUrlToOpen } from '../../../../src/externalUrl'
import type { AgentChatMessage } from '../../uiTypes'
import { buildChatMessageSemanticModel } from '../chatMessageSemantics'

function assistant(content: string): AgentChatMessage {
  return { id: 'assistant-1', role: 'assistant', content, timestamp: 1 }
}

function renderMessage(content: string): HTMLElement {
  const model = buildChatMessageSemanticModel(assistant(content))
  const { container } = render(
    <ChatMarkdownContent model={model} query="" activeOccurrence={null} />
  )
  return container
}

function anchors(container: HTMLElement): Array<{ href: string | null; text: string }> {
  return Array.from(container.querySelectorAll('a')).map(anchor => ({
    href: anchor.getAttribute('href'),
    text: anchor.textContent ?? '',
  }))
}

function treeAnchors(node: Root | RootContent): Element[] {
  const own = node.type === 'element' && node.tagName === 'a' ? [node] : []
  const children = 'children' in node ? node.children.flatMap(treeAnchors) : []
  return [...own, ...children]
}

// Invariant S2, stated independently of the implementation: the forms the
// chat click handler and main's `app:openUrl` agree on.
function isCanonicalChatHref(href: unknown): boolean {
  if (typeof href !== 'string') return false
  if (/^https?:\/\//.test(href)) {
    try {
      return new URL(href).href === href && externalUrlToOpen(href) === href
    } catch {
      return false
    }
  }
  if (/^mailto:[^?#]+$/.test(href)) {
    try {
      return externalUrlToOpen(href) === href
    } catch {
      return false
    }
  }
  return normalizeGfsResourceUri(href) === href
}

afterEach(cleanup)

describe('chat link policy (S-9)', () => {
  it('renders the reported agent message as a canonical gfs:// link', () => {
    const container = renderMessage(
      'Carpeta creada: [test-subscription](gfs://main/859df99de46b407bb0ec4b0f7cb424a5), dentro de `diego`.'
    )

    expect(anchors(container)).toEqual([
      { href: 'gfs://main/859df99de46b407bb0ec4b0f7cb424a5', text: 'test-subscription' },
    ])
    expect(container.textContent).toBe('Carpeta creada: test-subscription, dentro de diego.')
  })

  it('keeps only the gfs and web links of the literal mixed message; the relative one is text', () => {
    const container = renderMessage(
      '[relativo](./nueva-carpeta) · [gfs](gfs://diego/0123456789abcdef0123456789abcdef) · [web](https://evenfire.ai)'
    )

    expect(anchors(container)).toEqual([
      { href: 'gfs://diego/0123456789abcdef0123456789abcdef', text: 'gfs' },
      { href: 'https://evenfire.ai/', text: 'web' },
    ])
    expect(container.textContent).toBe('relativo · gfs · web')
  })

  it('shows the real URL of a web link as its title', () => {
    const container = renderMessage('[docs](https://evenfire.ai/docs "Read the docs")')

    expect(container.querySelector('a')?.getAttribute('title')).toBe('https://evenfire.ai/docs')
  })

  it.each([
    ['[x](mailto:a@b.c "https://bank.example")', 'mailto:a@b.c'],
    [
      '[x](gfs://main/859df99de46b407bb0ec4b0f7cb424a5 "https://bank.example")',
      'gfs://main/859df99de46b407bb0ec4b0f7cb424a5',
    ],
  ])('replaces an author-supplied title with the canonical href: %s', (content, href) => {
    const anchor = renderMessage(content).querySelector('a')
    expect(anchor?.getAttribute('href')).toBe(href)
    expect(anchor?.getAttribute('title')).toBe(href)
  })

  it.each([
    ['HTTPS://Host', 'https://host/'],
    ['https:host', 'https://host/'],
    ['HTTP://Host/Path?q=1', 'http://host/Path?q=1'],
    ['GFS://main/859DF99DE46B407BB0EC4B0F7CB424A5', 'gfs://main/859df99de46b407bb0ec4b0f7cb424a5'],
    ['MAILTO:a@b.co?attach=/etc/passwd', 'mailto:a@b.co'],
    ['mailto:a@b.co,c@d.co?subject=x', 'mailto:a@b.co,c@d.co'],
  ])('canonicalises %s to %s', (target, href) => {
    expect(anchors(renderMessage(`[x](${target})`))).toEqual([{ href, text: 'x' }])
  })

  it.each([
    'mailto:?to=x',
    'mailto:a@b.co%3Fattach=x',
    './nueva-carpeta',
    '/abs/path',
    '#section',
    '',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'gfs://drive/path/to/folder',
    'gfs://main/not-a-rid',
    'https://',
    'evenfire://files?uri=x',
  ])('renders [x](%s) as plain text', target => {
    const container = renderMessage(`before [x](${target}) after`)

    expect(anchors(container)).toEqual([])
    expect(container.textContent).toBe('before x after')
  })

  it('turns GFM footnote references and back-references into text', () => {
    const container = renderMessage('Claim[^1].\n\n[^1]: Source.')

    expect(anchors(container)).toEqual([])
    expect(container.textContent).toContain('Claim1.')
    expect(container.textContent).toContain('Source.')
  })

  it('applies the policy to autolinks and reference links', () => {
    const container = renderMessage(
      [
        '<https://evenfire.ai/a>',
        'www.example.com',
        'team@evenfire.ai',
        '<mailto:team@evenfire.ai?subject=hi>',
        '[ref][web] [bad][rel] [drive][gfs]',
        '[web]: https://evenfire.ai/ref',
        '[rel]: ./elsewhere',
        '[gfs]: gfs://main/859df99de46b407bb0ec4b0f7cb424a5',
      ].join('\n\n')
    )

    expect(anchors(container).map(anchor => anchor.href)).toEqual([
      'https://evenfire.ai/a',
      'http://www.example.com/',
      'mailto:team@evenfire.ai',
      'mailto:team@evenfire.ai',
      'https://evenfire.ai/ref',
      'gfs://main/859df99de46b407bb0ec4b0f7cb424a5',
    ])
    expect(container.textContent).toContain('bad')
  })

  it('leaves image sources on the default transform', () => {
    const model = buildChatMessageSemanticModel(
      assistant('![a](https://evenfire.ai/a.png) ![b](gfs://main/859df99de46b407bb0ec4b0f7cb424a5)')
    )
    const images: Element[] = []
    const collect = (node: Root | RootContent) => {
      if (node.type === 'element' && node.tagName === 'img') images.push(node)
      if ('children' in node) node.children.forEach(collect)
    }
    collect(model.renderTree)

    expect(images.map(image => image.properties.src)).toEqual(['https://evenfire.ai/a.png', ''])
  })

  it('S2: every <a> in the chat tree carries a canonical href, for arbitrary link targets', () => {
    const rid = fc.stringMatching(/^[0-9a-fA-F]{32}$/)
    const target = fc.oneof(
      fc.webUrl({ withQueryParameters: true, withFragments: true }),
      fc
        .tuple(fc.constantFrom('http', 'HTTPS', 'Https', 'ftp', 'javascript', 'file'), fc.string())
        .map(([scheme, rest]) => `${scheme}:${rest}`),
      fc
        .tuple(fc.constantFrom('mailto:', 'MAILTO:'), fc.emailAddress(), fc.string())
        .map(([scheme, address, query]) => `${scheme}${address}?${query}`),
      fc.tuple(fc.constantFrom('mailto:', 'mailto:?'), fc.string()).map(([a, b]) => a + b),
      fc
        .tuple(fc.constantFrom('gfs://', 'GFS://', 'gfs:/'), fc.domain(), rid)
        .map(([scheme, drive, id]) => `${scheme}${drive}/${id}`),
      fc
        .tuple(fc.constantFrom('gfs://main/', './', '#', '/', '?'), fc.string())
        .map(([a, b]) => a + b),
      fc.string()
    )
    const markdown = fc
      .tuple(target, fc.constantFrom('inline', 'angle', 'autolink', 'reference'))
      .map(([dest, form]) =>
        form === 'inline'
          ? `[label](${dest})`
          : form === 'angle'
            ? `[label](<${dest}>)`
            : form === 'autolink'
              ? `<${dest}>`
              : `[label][r]\n\n[r]: ${dest}`
      )

    const schemesSeen = new Set<string>()
    fc.assert(
      fc.property(markdown, content => {
        const model = buildChatMessageSemanticModel(assistant(content))
        for (const anchor of treeAnchors(model.renderTree)) {
          schemesSeen.add(String(anchor.properties.href).split(':')[0] ?? '')
          expect(isCanonicalChatHref(anchor.properties.href), String(anchor.properties.href)).toBe(
            true
          )
        }
      }),
      { numRuns: 2_000 }
    )
    // Guards against a vacuous run in which the generator never produced a link.
    expect([...schemesSeen].sort()).toEqual(['gfs', 'http', 'https', 'mailto'])
  })
})
