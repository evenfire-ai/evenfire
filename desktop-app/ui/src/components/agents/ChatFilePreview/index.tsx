import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useChatLinkActivation } from '@contexts/ChatLinkActivationContext'
import { Button } from '@components/Common'
import {
  CHAT_FILE_PREVIEW_MARKDOWN_MAX_CHARS,
  CHAT_FILE_PREVIEW_TABLE_MAX_CELL_CHARS,
  CHAT_FILE_PREVIEW_TABLE_MAX_CHARS,
  CHAT_FILE_PREVIEW_TABLE_MAX_COLUMNS,
  CHAT_FILE_PREVIEW_TABLE_MAX_LAYOUT_COST,
  CHAT_FILE_PREVIEW_TABLE_MAX_ROWS,
  CHAT_FILE_PREVIEW_VIEWPORT_MARGIN,
  CHAT_GENERATED_FILE_PREVIEW_LIMIT,
} from '@constants/chatRendering'
import { HTML_PREVIEW_SAFE_SANDBOX } from '@constants/htmlPreview'
import { useChatEndFollower, useNearChatViewport } from '@hooks/useNearChatViewport'
import type { ChatEndActions } from '@hooks/useNearChatViewport.types'
import { estimateBase64DecodedLength } from '@lib/base64Size'
import {
  beginningOfText,
  chatFileDownloadMaxBytes,
  chatFilePreviewKind,
  chatFilePreviewMaxBytes,
  chatImageBlob,
  codeFenceFor,
  decodeBase64,
  decodeText,
  fileExtension,
  formattedJson,
  generatedFilePreviewKind,
  textBlocks,
} from '@lib/chatFilePreview'
import { isTooLargeToShow, loadChatGfsFile } from '@lib/chatGfsFiles'
import { activateClickedChatLink } from '@lib/chatLinkActivation'
import type { ChatMessageSemanticModel } from '@lib/chatMessageSemantics'
import { parseDelimited } from '@lib/csv'
import { layoutCost } from '@lib/layoutCost'
import { layOutMarkdown } from '@lib/markdownDocument'
import { ChatImage } from '../ChatImage'
import { ChatMarkdownContent } from '../ChatMarkdownContent'
import type {
  ChatAttachmentPreviewsProps,
  ChatFileLoadState,
  ChatFilePreviewProps,
  ChatLinkedFilePreviewsProps,
  ChatMarkdownLayout,
} from './types'

const UNAVAILABLE = 'This file could not be shown.'
const TOO_LARGE = 'This file is too large to show here.'
const EMPTY = 'This file is empty.'
const LONG_DOCUMENT = 'This document is long, so it shows as plain text.'

function ImagePreview({
  name,
  bytes,
  onGrow,
}: {
  name: string
  bytes: ArrayBuffer
  onGrow?: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const blob = chatImageBlob(name, bytes)
    if (!blob) return
    const objectUrl = URL.createObjectURL(blob)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [bytes, name])
  if (!url) return null
  return (
    <ChatImage
      className="chat-file-preview__image"
      src={url}
      alt={name}
      fallback={<p className="chat-file-preview__note">{UNAVAILABLE}</p>}
      onLoad={onGrow}
    />
  )
}

function MarkdownPreview({
  name,
  markdown,
  text,
  onGrow,
}: {
  name: string
  markdown: string
  text: string
  onGrow?: () => void
}) {
  const activateChatLink = useChatLinkActivation()
  const [layout, setLayout] = useState<ChatMarkdownLayout | null>(null)
  useEffect(() => {
    const closed = new AbortController()
    const settle = (model: ChatMessageSemanticModel | null) => {
      if (!closed.signal.aborted) setLayout({ markdown, model })
    }
    layOutMarkdown({ id: `file:${name}`, markdown }, closed.signal).then(settle, () => settle(null))
    return () => closed.abort()
  }, [markdown, name])
  const current = layout?.markdown === markdown ? layout : null
  useLayoutEffect(() => {
    if (current) onGrow?.()
  }, [current, onGrow])
  if (!current) return <div className="chat-file-preview--pending" aria-busy="true" />
  if (!current.model) return <LongDocumentPreview name={name} text={text} />
  return (
    <div
      className="chat-file-preview__scroll markdown-content"
      role="region"
      aria-label={`Contents of ${name}`}
      tabIndex={0}
      onClick={(event: ReactMouseEvent<HTMLDivElement>) =>
        activateClickedChatLink(event, activateChatLink)
      }
    >
      <ChatMarkdownContent model={current.model} query="" activeOccurrence={null} />
    </div>
  )
}

// Rendered out of process: the empty sandbox allows no scripts, forms, popups or same-origin access.
function PagePreview({ name, bytes }: { name: string; bytes: ArrayBuffer }) {
  const page = useMemo(() => decodeText(bytes), [bytes])
  const frame = useRef<HTMLIFrameElement | null>(null)
  // The button that had the focus was just removed.
  useEffect(() => frame.current?.focus({ preventScroll: true }), [])
  return (
    <iframe
      ref={frame}
      className="chat-file-preview__html"
      sandbox={HTML_PREVIEW_SAFE_SANDBOX}
      srcDoc={page}
      title={`Page ${name}`}
    />
  )
}

function TextPreview({ name, text }: { name: string; text: string }) {
  const beginning = useMemo(() => beginningOfText(text), [text])
  const blocks = useMemo(() => textBlocks(beginning.text), [beginning])
  return (
    <>
      <pre
        className="chat-file-preview__scroll chat-file-preview__text"
        role="region"
        aria-label={`Contents of ${name}`}
        tabIndex={0}
      >
        {blocks.map((block, index) => (
          <span key={index} className="chat-file-preview__text-block">
            {block}
          </span>
        ))}
      </pre>
      {beginning.truncated ? (
        <p className="chat-file-preview__note">Showing the beginning of this file.</p>
      ) : null}
    </>
  )
}

function LongDocumentPreview({ name, text }: { name: string; text: string }) {
  return (
    <>
      <TextPreview name={name} text={text} />
      <p className="chat-file-preview__note">{LONG_DOCUMENT}</p>
    </>
  )
}

function TablePreview({ name, text }: { name: string; text: string }) {
  const { columns, cells, truncated, moreColumns, cut } = useMemo(() => {
    const parsed = parseDelimited(
      text,
      fileExtension(name) === 'tsv' ? '\t' : ',',
      CHAT_FILE_PREVIEW_TABLE_MAX_ROWS + 1
    )
    const widest = Math.max(0, ...parsed.rows.map(row => row.length))
    const shown = Math.min(CHAT_FILE_PREVIEW_TABLE_MAX_COLUMNS, widest)
    let left = CHAT_FILE_PREVIEW_TABLE_MAX_CHARS
    let budget = CHAT_FILE_PREVIEW_TABLE_MAX_LAYOUT_COST
    let shortened = false
    const limited: string[][] = []
    for (const row of parsed.rows) {
      if (budget <= 0) break
      limited.push(
        Array.from({ length: shown }, (_, index) => {
          const full = row[index] ?? ''
          const whole = full.slice(0, Math.min(CHAT_FILE_PREVIEW_TABLE_MAX_CELL_CHARS, left))
          const cell = budget > 0 ? whole : ''
          left -= cell.length
          budget -= layoutCost(cell, budget)
          shortened ||= cell.length < full.length
          return cell
        })
      )
    }
    return {
      columns: shown,
      cells: limited,
      truncated: parsed.truncated || limited.length < parsed.rows.length,
      moreColumns: widest > shown,
      cut: shortened,
    }
  }, [name, text])
  const [header, ...body] = cells
  if (!header) return <p className="chat-file-preview__note">{EMPTY}</p>
  return (
    <>
      <div
        className="chat-file-preview__scroll markdown-content"
        role="region"
        aria-label={`Table in ${name}`}
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              {header.map((cell, index) => (
                <th key={index}>{cell}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, index) => (
                  <td key={index}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated || moreColumns ? (
        <p className="chat-file-preview__note">
          Showing the first {Math.min(body.length, CHAT_FILE_PREVIEW_TABLE_MAX_ROWS)} rows
          {moreColumns ? ` and ${columns} columns` : ''}.
        </p>
      ) : null}
      {cut ? (
        <p className="chat-file-preview__note">Some cells are too long to show whole.</p>
      ) : null}
    </>
  )
}

/** HTML renders only on request: even sandboxed, a page can demand unbounded work. */
export function ChatFilePreview({ name, kind, bytes, onGrow }: ChatFilePreviewProps) {
  const tooLarge = bytes.byteLength > chatFilePreviewMaxBytes(kind)
  const text = useMemo(
    () => (tooLarge || kind === 'image' || kind === 'html' ? '' : decodeText(bytes)),
    [bytes, kind, tooLarge]
  )
  const json = useMemo(
    () => (kind === 'code' && !tooLarge ? formattedJson(text) : ''),
    [kind, text, tooLarge]
  )
  const jsonMarkdown = useMemo(() => {
    if (json.length > CHAT_FILE_PREVIEW_MARKDOWN_MAX_CHARS) return null
    const fence = codeFenceFor(json)
    return `${fence}json\n${json}\n${fence}`
  }, [json])
  const [requested, setRequested] = useState<ArrayBuffer | null>(null)
  const empty = !tooLarge && kind !== 'image' && bytes.byteLength === 0
  let body
  if (tooLarge) {
    body = <p className="chat-file-preview__note">{TOO_LARGE}</p>
  } else if (empty) {
    body = <p className="chat-file-preview__note">{EMPTY}</p>
  } else if (kind === 'html' && requested !== bytes) {
    body = (
      <div className="chat-file-preview__request">
        <Button variant="outline" size="sm" onClick={() => setRequested(bytes)}>
          Show page
        </Button>
      </div>
    )
  } else if (kind === 'image') {
    body = <ImagePreview name={name} bytes={bytes} onGrow={onGrow} />
  } else if (kind === 'markdown') {
    body =
      text.length > CHAT_FILE_PREVIEW_MARKDOWN_MAX_CHARS ? (
        <LongDocumentPreview name={name} text={text} />
      ) : (
        <MarkdownPreview name={name} markdown={text} text={text} onGrow={onGrow} />
      )
  } else if (kind === 'table') {
    body = <TablePreview name={name} text={text} />
  } else if (kind === 'code') {
    body =
      jsonMarkdown === null ? (
        <LongDocumentPreview name={name} text={json} />
      ) : (
        <MarkdownPreview name={name} markdown={jsonMarkdown} text={json} onGrow={onGrow} />
      )
  } else if (kind === 'html') {
    body = <PagePreview name={name} bytes={bytes} />
  } else {
    body = <TextPreview name={name} text={text} />
  }
  return (
    <figure className={`chat-file-preview chat-file-preview--${kind}`}>
      {body}
      <figcaption className="chat-file-preview__caption">{name}</figcaption>
    </figure>
  )
}

function FileNote({ name, kind, note }: { name: string; kind: string; note: string }) {
  return (
    <figure className={`chat-file-preview chat-file-preview--${kind}`}>
      <p className="chat-file-preview__note">{note}</p>
      <figcaption className="chat-file-preview__caption">{name}</figcaption>
    </figure>
  )
}

function FilePending({ anchor }: { anchor: RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={anchor} className="chat-file-preview chat-file-preview--pending" aria-busy="true" />
  )
}

function useFileLoad(
  load: ((signal: AbortSignal) => Promise<{ name: string; bytes: ArrayBuffer }>) | null,
  chatEnd: ChatEndActions
) {
  const anchor = useRef<HTMLDivElement | null>(null)
  const near = useNearChatViewport(anchor, CHAT_FILE_PREVIEW_VIEWPORT_MARGIN)
  const [state, setState] = useState<ChatFileLoadState>({ status: 'idle' })
  const follower = useChatEndFollower(chatEnd)
  useEffect(() => {
    if (!near || !load) return
    let active = true
    const closed = new AbortController()
    load(closed.signal).then(
      file => {
        if (!active) return
        follower.capture()
        setState({ status: 'ready', ...file })
      },
      error => {
        if (!active) return
        setState({
          status: 'unavailable',
          reason: isTooLargeToShow(error) ? TOO_LARGE : UNAVAILABLE,
        })
      }
    )
    return () => {
      active = false
      closed.abort()
    }
  }, [follower, load, near])
  useLayoutEffect(() => {
    if (state.status === 'ready') follower.grew()
  }, [follower, state])
  return { anchor, state, grew: follower.grew }
}

function AttachmentPreview({
  name,
  dataBase64,
  chatEnd,
}: {
  name: string
  dataBase64: string
  chatEnd: ChatEndActions
}) {
  const kind = chatFilePreviewKind(name)
  // Checked before decoding: a generated file can be up to 50 MB.
  const tooLarge =
    kind !== null && estimateBase64DecodedLength(dataBase64) > chatFilePreviewMaxBytes(kind)
  const load = useMemo(
    () => (kind && !tooLarge ? async () => ({ name, bytes: decodeBase64(dataBase64) }) : null),
    [dataBase64, kind, name, tooLarge]
  )
  const { anchor, state, grew } = useFileLoad(load, chatEnd)
  if (!kind) return null
  if (tooLarge) return <FileNote name={name} kind={kind} note={TOO_LARGE} />
  if (state.status === 'unavailable')
    return <FileNote name={name} kind={kind} note={state.reason} />
  if (state.status === 'ready') {
    return <ChatFilePreview name={name} kind={kind} bytes={state.bytes} onGrow={grew} />
  }
  return <FilePending anchor={anchor} />
}

export function ChatAttachmentPreviews({ attachments, chatEnd }: ChatAttachmentPreviewsProps) {
  const files = attachments
    .filter(attachment => generatedFilePreviewKind(attachment) !== null)
    .slice(0, CHAT_GENERATED_FILE_PREVIEW_LIMIT)
  if (!files.length) return null
  return (
    <div className="chat-file-previews">
      {files.map(attachment => (
        <AttachmentPreview
          key={attachment.id}
          name={attachment.filename || attachment.label}
          dataBase64={attachment.dataBase64 ?? ''}
          chatEnd={chatEnd}
        />
      ))}
    </div>
  )
}

function LinkedFilePreview({
  uri,
  name,
  chatEnd,
}: {
  uri: string
  name: string
  chatEnd: ChatEndActions
}) {
  const linkedKind = chatFilePreviewKind(name)
  const load = useMemo(
    () =>
      linkedKind
        ? (signal: AbortSignal) =>
            loadChatGfsFile(uri, chatFileDownloadMaxBytes(linkedKind), signal)
        : null,
    [linkedKind, uri]
  )
  const { anchor, state, grew } = useFileLoad(load, chatEnd)
  if (state.status === 'ready') {
    // The stored name decides the kind; the link text only selected what to fetch.
    const kind = chatFilePreviewKind(state.name)
    return kind ? (
      <ChatFilePreview name={state.name} kind={kind} bytes={state.bytes} onGrow={grew} />
    ) : null
  }
  if (state.status === 'unavailable') {
    return <FileNote name={name} kind={linkedKind ?? 'text'} note={state.reason} />
  }
  return <FilePending anchor={anchor} />
}

export function ChatLinkedFilePreviews({ files, chatEnd }: ChatLinkedFilePreviewsProps) {
  if (!files.length) return null
  return (
    <div className="chat-file-previews">
      {files.map(file => (
        <LinkedFilePreview key={file.uri} uri={file.uri} name={file.name} chatEnd={chatEnd} />
      ))}
    </div>
  )
}
