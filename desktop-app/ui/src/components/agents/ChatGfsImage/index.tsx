import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  CHAT_FILE_PREVIEW_IMAGE_MAX_BYTES,
  CHAT_FILE_PREVIEW_VIEWPORT_MARGIN,
} from '@constants/chatRendering'
import { useChatEndFollowerFromContext, useNearChatViewport } from '@hooks/useNearChatViewport'
import { chatImageBlob } from '@lib/chatFilePreview'
import { loadChatGfsFile } from '@lib/chatGfsFiles'
import { ChatImage } from '../ChatImage'
import type { ChatGfsImageProps } from './types'

/** Fetched with the user's access once near the viewport; falls back to its alt text. */
export function ChatGfsImage({ uri, alt }: ChatGfsImageProps) {
  const anchor = useRef<HTMLSpanElement | null>(null)
  const near = useNearChatViewport(anchor, CHAT_FILE_PREVIEW_VIEWPORT_MARGIN)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const follower = useChatEndFollowerFromContext()

  useEffect(() => {
    if (!near) return
    let active = true
    let objectUrl: string | null = null
    const closed = new AbortController()
    setUrl(null)
    setFailed(false)
    loadChatGfsFile(uri, CHAT_FILE_PREVIEW_IMAGE_MAX_BYTES, closed.signal).then(
      file => {
        if (!active) return
        const blob = chatImageBlob(file.name, file.bytes)
        if (!blob) {
          setFailed(true)
          return
        }
        objectUrl = URL.createObjectURL(blob)
        follower.capture()
        setUrl(objectUrl)
      },
      () => {
        if (active) setFailed(true)
      }
    )
    return () => {
      active = false
      closed.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [follower, near, uri])

  useLayoutEffect(() => {
    if (url) follower.grew()
  }, [follower, url])

  if (url) {
    return (
      <ChatImage
        className="chat-md-image"
        src={url}
        alt={alt}
        fallback={alt}
        onLoad={follower.grew}
      />
    )
  }
  return (
    <span ref={anchor} className={failed ? undefined : 'chat-md-image-pending'} aria-busy={!failed}>
      {failed ? alt : null}
    </span>
  )
}
