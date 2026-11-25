import { useEffect, useRef, useState } from 'react'
import { checkChatImage } from '@lib/chatImages'
import type { ChatImageProps } from './types'

/** Mounts the `<img>` only after its pixel size has been checked. */
export function ChatImage({ src, alt, className, fallback, onShow, onLoad }: ChatImageProps) {
  const latestOnShow = useRef(onShow)
  latestOnShow.current = onShow
  const [checked, setChecked] = useState<{ src: string; drawable: boolean } | null>(null)
  useEffect(() => {
    let active = true
    const settle = (drawable: boolean) => {
      if (!active) return
      if (drawable) latestOnShow.current?.()
      setChecked({ src, drawable })
    }
    checkChatImage(src).then(
      () => settle(true),
      () => settle(false)
    )
    return () => {
      active = false
    }
  }, [src])
  if (checked?.src !== src) return null
  if (!checked.drawable) return <>{fallback}</>
  return <img className={className} src={src} alt={alt} onLoad={onLoad} />
}
