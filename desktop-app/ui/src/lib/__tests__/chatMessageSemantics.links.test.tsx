// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import fc from 'fast-check'
import type { Element, Root, RootContent } from 'hast'
import { ChatMarkdownContent } from '@components/agents/ChatMarkdownContent'
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

// Invariant S2: the forms the chat click handler and main's `app:openUrl`
// agree on. Restated as literal grammars on purpose rather than by calling
// `externalUrlToOpen` or `normalizeGfsResourceUri`: an oracle built on the
// producer's own helpers moves with them, so loosening a helper would loosen
// the check too and the property would stay green.
//
// mailto: comma-separated ASCII recipients, RFC 5322 dot-atom local part minus
// `%`, `?`, `&`, `#`; domain of 1..63-char alphanumeric/hyphen labels; no query
// or fragment. gfs: alphanumeric-bounded drive (`.`, `_`, `-` inside, case
// kept) and a lowercase 32-hex resource id. http(s): the WHATWG serialisation,
// which is lowercase-scheme and never carries whitespace, control or format
// (bidi / zero-width) characters.
const ATOM = "[A-Za-z0-9!$'*+/=^_`{|}~-]+"
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
const RECIPIENT = `${ATOM}(?:\\.${ATOM})*@${LABEL}(?:\\.${LABEL})*`
const CANONICAL_MAILTO = new RegExp(`^mailto:${RECIPIENT}(?:,${RECIPIENT})*$`)
const CANONICAL_GFS = /^gfs:\/\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?\/[0-9a-f]{32}$/
const CANONICAL_WEB_SHAPE = /^https?:\/\/[^\s\p{Cc}\p{Cf}]+$/u

function isCanonicalChatHref(href: unknown): boolean {
  if (typeof href !== 'string') return false
  if (CANONICAL_WEB_SHAPE.test(href)) {
    try {
      return new URL(href).href === href
    } catch {
      return false
    }
  }
  if (href.startsWith('mailto:')) return href.length <= 2048 && CANONICAL_MAILTO.test(href)
  return CANONICAL_GFS.test(href)
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
    'mailto:a\u202Emoc.knab@evil.com',
    'mailto:\u0430dmin@bank.com',
    'mailto:a@-x',
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

  it('S2: every <a> in the chat tree carries a canonical href, for arbitrary messages', () => {
    const hexId = fc.stringMatching(/^[0-9a-fA-F]{32}$/)
    // Hostile characters a recipient must never smuggle into a rendered link:
    // bidi overrides, zero-width joiners/spaces, Cyrillic homoglyphs, `%`.
    // The markdown parser percent-encodes non-ASCII before the policy runs, so
    // here they are rejected by the `%` rule; the ASCII-only rule for raw
    // recipients is covered by the openUrl tests.
    const hostileLocal = fc
      .array(
        fc.constantFrom('a', 'b', '.', '%', '+', '\u202E', '\u200B', '\u200D', '\u0430', '\u043E'),
        {
          minLength: 1,
          maxLength: 8,
        }
      )
      .map(chars => chars.join(''))
    const target = fc.oneof(
      fc.webUrl({ withQueryParameters: true, withFragments: true }),
      fc
        .tuple(fc.constantFrom('http', 'HTTPS', 'Https', 'ftp', 'javascript', 'file'), fc.string())
        .map(([scheme, rest]) => `${scheme}:${rest}`),
      fc
        .tuple(fc.constantFrom('mailto:', 'MAILTO:'), fc.emailAddress(), fc.string())
        .map(([scheme, address, query]) => `${scheme}${address}?${query}`),
      fc
        .tuple(fc.constantFrom('mailto:', 'MAILTO:'), hostileLocal, fc.domain())
        .map(([scheme, local, domain]) => `${scheme}${local}@${domain}`),
      fc.tuple(fc.constantFrom('mailto:', 'mailto:?'), fc.string()).map(([a, b]) => a + b),
      fc
        .tuple(fc.constantFrom('gfs://', 'GFS://', 'gfs:/'), fc.domain(), hexId)
        .map(([scheme, drive, id]) => `${scheme}${drive}/${id}`),
      fc
        .tuple(fc.constantFrom('gfs://main/', './', '#', '/', '?'), fc.string())
        .map(([a, b]) => a + b),
      fc.string()
    )
    const link = fc.record({
      dest: target,
      form: fc.constantFrom('inline', 'angle', 'autolink', 'reference'),
      wrap: fc.constantFrom('none', 'em', 'strong', 'list', 'footnote'),
    })
    const text = fc.oneof(fc.stringMatching(/^[a-z]{1,8}$/), fc.string({ maxLength: 12 }))
    const piece = fc.oneof(
      { weight: 1, arbitrary: text.map(value => ({ kind: 'text' as const, value })) },
      { weight: 3, arbitrary: link.map(value => ({ kind: 'link' as const, ...value })) }
    )

    // A canonical target in its own leading paragraph must always survive as a
    // link, so the policy cannot pass by rendering no anchors at all. The
    // paragraph starts with a word because a message wrapped in `[...]` is
    // shown as plain text by the JSON heuristic and would render no link.
    const lower = fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/)
    const witness = fc.oneof(
      fc
        .tuple(fc.stringMatching(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,10}[A-Za-z0-9])?$/), hexId)
        .map(([drive, id]) => `gfs://${drive}/${id.toLowerCase()}`),
      fc.tuple(lower, lower, lower).map(([host, tld, path]) => `https://${host}.${tld}/${path}`),
      fc.tuple(lower, lower, lower).map(([local, host, tld]) => `mailto:${local}@${host}.${tld}`)
    )

    const message = fc
      .tuple(witness, fc.array(piece, { minLength: 2, maxLength: 5 }))
      .map(([witnessHref, pieces]) => {
        const definitions: string[] = []
        const body = pieces.map((p, index) => {
          if (p.kind === 'text') return p.value
          const ref = `r${index}`
          const anchor =
            p.form === 'inline'
              ? `[label${index}](${p.dest})`
              : p.form === 'angle'
                ? `[label${index}](<${p.dest}>)`
                : p.form === 'autolink'
                  ? `<${p.dest}>`
                  : `[label${index}][${ref}]`
          if (p.form === 'reference') definitions.push(`[${ref}]: ${p.dest}`)
          switch (p.wrap) {
            case 'em':
              return `*${anchor}*`
            case 'strong':
              return `**${anchor}**`
            case 'list':
              return `\n\n- item ${anchor}\n- other\n\n`
            case 'footnote':
              definitions.push(`[^f${index}]: see ${anchor}`)
              return `note[^f${index}]`
            default:
              return anchor
          }
        })
        const content = [`see [w](${witnessHref})`, body.join(' '), ...definitions].join('\n\n')
        return { witnessHref, content }
      })

    const schemesSeen = new Set<string>()
    fc.assert(
      fc.property(message, ({ witnessHref, content }) => {
        const model = buildChatMessageSemanticModel(assistant(content))
        const hrefs = treeAnchors(model.renderTree).map(anchor => anchor.properties.href)
        for (const href of hrefs) {
          expect(isCanonicalChatHref(href), `${String(href)} in ${JSON.stringify(content)}`).toBe(
            true
          )
          if (href !== witnessHref) schemesSeen.add(String(href).split(':')[0] ?? '')
        }
        expect(hrefs).toContain(witnessHref)
      }),
      { numRuns: 2_000 }
    )
    // Guards against a vacuous run in which the hostile pieces never produced a link.
    expect([...schemesSeen].sort()).toEqual(['gfs', 'http', 'https', 'mailto'])
  })
})
