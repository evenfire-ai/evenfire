import { Fragment, type MouseEvent, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AuthContext } from '@contexts/AuthContext'
import { QueryClientContext } from '@tanstack/react-query'
import MDEditor from '@uiw/react-md-editor/nohighlight'
import type { Element, Root, RootContent } from 'hast'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import type { Components } from 'react-markdown'
import { jsx, jsxs } from 'react/jsx-runtime'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import {
  isGfsSessionAuthorityFailure,
  revokeGfsSessionAccess,
  useGfsSessionAccessState,
} from '../../hooks/domain/useGfsBrowserController'
import { useGfsResourceProfileOrigin } from '../../hooks/domain/useGfsResourceProfileOrigin'
import {
  type ChatMessageSemanticModel,
  annotateChatSemanticTree,
  createChatSemanticRehypePlugin,
} from '../../lib/chatMessageSemantics'
import { gfsResourceLabelResolver } from '../../lib/gfsResourceLabelResolver'
import type { GfsResourceLabel } from '../../lib/gfsResourceLabelResolver'
import { parseGfsResourceLink } from '../../lib/gfsResourceLinks'

type LinkSourceRange = { start: number; end: number }
const EMPTY_RESOURCE_LABELS: ReadonlyMap<string, GfsResourceLabel> = new Map()

function textContent(node: RootContent | Root): string {
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map(textContent).join('') : ''
}

function originalHref(node: Element): string | null {
  const stored = (node.data as Record<string, unknown> | undefined)?.originalHref
  if (typeof stored === 'string') return stored
  return typeof node.properties.href === 'string' ? node.properties.href : null
}

function semanticHrefAtRange(node: RootContent | Root, start: number, end: number): string | null {
  if (node.type === 'element' && node.tagName === 'a') {
    if (node.position?.start.offset === start && node.position.end.offset === end) {
      return originalHref(node)
    }
  }
  if ('children' in node) {
    for (const child of node.children) {
      const target = semanticHrefAtRange(child, start, end)
      if (target) return target
    }
  }
  return null
}

function collectBareResourceLinks(
  node: RootContent | Root,
  source: string,
  profileOrigin: string | null,
  found = new Set<string>()
): Set<string> {
  if (node.type === 'element' && node.tagName === 'a') {
    const href = originalHref(node)
    const uri = href ? parseGfsResourceLink(href, profileOrigin) : null
    const position = node.position
    if (
      uri &&
      position?.start.offset !== undefined &&
      position.end.offset !== undefined &&
      source.slice(position.start.offset, position.end.offset).trimStart()[0] !== '[' &&
      textContent(node) === href
    ) {
      found.add(uri)
    }
    return found
  }
  if ('children' in node) {
    node.children.forEach(child => collectBareResourceLinks(child, source, profileOrigin, found))
  }
  return found
}

function safeExternalHttpUrl(raw: string): string | null {
  try {
    const transformed = new URL(raw)
    if (
      !['http:', 'https:'].includes(transformed.protocol) ||
      transformed.username ||
      transformed.password
    ) {
      return null
    }
    return transformed.toString()
  } catch {
    return null
  }
}

function safeInlineImageSource(raw: unknown): string | null {
  return typeof raw === 'string' && /^data:image\/(?:png|gif|jpe?g|webp);base64,/i.test(raw)
    ? raw
    : null
}

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] }

function preserveRawHtmlAsText() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children) return
      node.children = node.children.map(child => {
        if (child.type === 'html') return { ...child, type: 'text' }
        visit(child)
        return child
      })
    }
    visit(tree)
  }
}

function prepareMarkdownLinks(profileOrigin: string | null) {
  return () => (tree: Root) => {
    const visit = (node: RootContent | Root) => {
      if (node.type === 'element') {
        if (typeof node.properties.href === 'string') {
          const rawHref = node.properties.href
          node.data = { ...(node.data ?? {}), originalHref: rawHref } as Element['data']
          node.properties.href = parseGfsResourceLink(rawHref, profileOrigin)
            ? '#gfs-resource'
            : (safeExternalHttpUrl(rawHref) ?? undefined)
        }
        if (typeof node.properties.src === 'string') {
          node.properties.src = safeInlineImageSource(node.properties.src) ?? undefined
        }
      }
      if ('children' in node) node.children.forEach(visit)
    }
    visit(tree)
  }
}

export function ChatMarkdownContent({
  model,
  query,
  activeOccurrence,
  onOpenGfsResource,
  onEditLink,
  remoteGfsChangeEpoch = 0,
}: {
  model: ChatMessageSemanticModel
  query: string
  activeOccurrence: number | null
  onOpenGfsResource?: (uri: string) => void
  onEditLink?: (range: LinkSourceRange) => void
  remoteGfsChangeEpoch?: number
}) {
  const auth = useContext(AuthContext)
  const queryClient = useContext(QueryClientContext)
  const profileOrigin = useGfsResourceProfileOrigin()
  const principalIdentity =
    auth?.isAuthenticated && !auth.authTransitioning && auth.me
      ? `${auth.runtimeConfigState?.envKey ?? ''}:${auth.me.id}:${auth.me.teamId ?? ''}`
      : null
  const accessState = useGfsSessionAccessState(principalIdentity)
  const authorizationRef = useRef({
    principalIdentity,
    authorizationEpoch: remoteGfsChangeEpoch,
    accessState,
  })
  authorizationRef.current = {
    principalIdentity,
    authorizationEpoch: remoteGfsChangeEpoch,
    accessState,
  }
  const resourceLinks = useMemo(
    () => [...collectBareResourceLinks(model.renderTree, model.contentRevision, profileOrigin)],
    [model.contentRevision, model.renderTree, profileOrigin]
  )
  const resourceLinksKey = resourceLinks.join('\u0000')
  const [resolvedResources, setResolvedResources] = useState<{
    principalIdentity: string | null
    authorizationEpoch: number
    names: ReadonlyMap<string, { name: string; kind: 'directory' | 'file' }>
  }>({ principalIdentity: null, authorizationEpoch: -1, names: EMPTY_RESOURCE_LABELS })

  useEffect(() => {
    let active = true
    gfsResourceLabelResolver.setActivePrincipal(principalIdentity)
    setResolvedResources({
      principalIdentity,
      authorizationEpoch: remoteGfsChangeEpoch,
      names: EMPTY_RESOURCE_LABELS,
    })
    if (!principalIdentity || accessState !== 'active' || !resourceLinksKey) return
    const subscriptions = resourceLinks.map(uri =>
      gfsResourceLabelResolver.subscribe(
        principalIdentity,
        remoteGfsChangeEpoch,
        uri,
        (label, error) => {
          const current =
            active &&
            authorizationRef.current.principalIdentity === principalIdentity &&
            authorizationRef.current.authorizationEpoch === remoteGfsChangeEpoch &&
            authorizationRef.current.accessState === 'active'
          if (!current) return
          if (
            error &&
            queryClient &&
            principalIdentity &&
            isGfsSessionAuthorityFailure(
              error instanceof Error ? error.message : String(error),
              'operation'
            )
          ) {
            revokeGfsSessionAccess(queryClient, principalIdentity)
          }
          if (!label) return
          setResolvedResources(previous => {
            if (
              previous.principalIdentity !== principalIdentity ||
              previous.authorizationEpoch !== remoteGfsChangeEpoch
            ) {
              return previous
            }
            const names = new Map(previous.names)
            names.set(uri, label)
            return { ...previous, names }
          })
        }
      )
    )
    return () => {
      active = false
      subscriptions.forEach(unsubscribe => unsubscribe())
    }
  }, [accessState, principalIdentity, queryClient, remoteGfsChangeEpoch, resourceLinksKey])

  // Render-time gating prevents a cached authorized name from surviving even
  // the first render after App advances the existing GFS authority epoch.
  const resolvedNames =
    accessState === 'active' &&
    resolvedResources.principalIdentity === principalIdentity &&
    resolvedResources.authorizationEpoch === remoteGfsChangeEpoch
      ? resolvedResources.names
      : EMPTY_RESOURCE_LABELS

  const tree = useMemo(
    () => annotateChatSemanticTree(model, query, activeOccurrence),
    [activeOccurrence, model, query]
  )
  const semanticPlugin = useMemo(
    () => createChatSemanticRehypePlugin(model, query, activeOccurrence),
    [activeOccurrence, model, query]
  )
  const prepareLinksPlugin = useMemo(() => prepareMarkdownLinks(profileOrigin), [profileOrigin])
  const rehypePlugins = useMemo(
    () => [prepareLinksPlugin, rehypeSanitize, semanticPlugin],
    [prepareLinksPlugin, semanticPlugin]
  )
  const remarkPlugins = useMemo(() => [remarkGfm, preserveRawHtmlAsText], [])
  const urlTransform = useMemo(
    () => (rawUrl: string, key: string) => {
      if (key === 'href') {
        if (rawUrl === '#gfs-resource') return rawUrl
        if (parseGfsResourceLink(rawUrl, profileOrigin)) return '#gfs-resource'
        return safeExternalHttpUrl(rawUrl) ?? ''
      }
      if (key === 'src') return safeInlineImageSource(rawUrl) ?? ''
      return ''
    },
    [profileOrigin]
  )
  const components = useMemo<Components>(
    () => ({
      img: ({ alt, src }: { alt?: string; src?: string }) => {
        const safeSource = safeInlineImageSource(src)
        return safeSource ? (
          <img alt={typeof alt === 'string' ? alt : ''} loading="lazy" src={safeSource} />
        ) : alt ? (
          <span>{alt}</span>
        ) : null
      },
      a: ({ children, href, node, ...rest }) => {
        const sourceStart = node?.position?.start.offset
        const sourceEnd = node?.position?.end.offset
        const range =
          typeof sourceStart === 'number' && typeof sourceEnd === 'number'
            ? { start: sourceStart, end: sourceEnd }
            : null
        const target =
          (range && semanticHrefAtRange(model.renderTree, range.start, range.end)) ||
          (node ? originalHref(node) : (href ?? null))
        const gfsUri = target ? parseGfsResourceLink(target, profileOrigin) : null
        const authoredMarkdown =
          range !== null &&
          model.contentRevision.slice(range.start, range.end).trimStart()[0] === '['
        const isBareGfs = Boolean(
          gfsUri && !authoredMarkdown && node && textContent(node) === target
        )
        const resolved = isBareGfs ? resolvedNames.get(gfsUri!) : undefined
        const label = isBareGfs ? (resolved?.name ?? 'EvenDrive resource') : children
        const activate = (event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault()
          if (onEditLink && range) {
            event.stopPropagation()
            onEditLink(range)
            return
          }
          if (gfsUri) {
            onOpenGfsResource?.(gfsUri)
            return
          }
          const safeUrl = target ? safeExternalHttpUrl(target) : null
          if (safeUrl) void window.clerum.app.openUrl(safeUrl).catch(() => undefined)
        }

        if (onEditLink && !gfsUri && !(target && safeExternalHttpUrl(target))) {
          return range ? model.contentRevision.slice(range.start, range.end) : children
        }
        if (!gfsUri && !(target && safeExternalHttpUrl(target))) return <span>{label}</span>
        return (
          <a
            {...rest}
            href={gfsUri ? '#gfs-resource' : (safeExternalHttpUrl(target ?? '') ?? undefined)}
            onClick={activate}
            aria-label={isBareGfs ? (resolved?.name ?? 'EvenDrive resource') : undefined}
          >
            {label}
          </a>
        )
      },
    }),
    [
      model.contentRevision,
      onEditLink,
      onOpenGfsResource,
      principalIdentity,
      profileOrigin,
      resolvedNames,
    ]
  )

  if (model.representation === 'plain') {
    return toJsxRuntime(tree, {
      Fragment,
      ignoreInvalidStyle: true,
      jsx,
      jsxs,
      passKeys: true,
      passNode: true,
      components,
    })
  }

  return (
    <MDEditor.Markdown
      source={model.contentRevision}
      className="chat-markdown-rendered"
      disableCopy
      skipHtml
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      urlTransform={urlTransform}
      components={components}
    />
  )
}
