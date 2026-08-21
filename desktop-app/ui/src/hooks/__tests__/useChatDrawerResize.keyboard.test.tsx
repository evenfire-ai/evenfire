// @vitest-environment jsdom
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  CHAT_DRAWER_DEFAULT_WIDTH,
  CHAT_DRAWER_MAX_ABSOLUTE,
  CHAT_DRAWER_MIN_WIDTH,
  useChatDrawerResize,
} from '../useChatDrawerResize'

// R2-L2: the separator handle only had onMouseDown, so it was inert to keyboard
// users. These pin the arrow/Home/End behavior on the hook. In jsdom the content
// panel measures 0, so clampWidth falls back to the [MIN, MAX_ABSOLUTE] range —
// enough to exercise direction and the extremes without layout.

function setup() {
  const ref = createRef<HTMLElement>()
  return renderHook(() => useChatDrawerResize(ref, true))
}

function press(result: ReturnType<typeof setup>['result'], key: string) {
  const event = { key, preventDefault: vi.fn() } as unknown as React.KeyboardEvent<HTMLElement>
  act(() => result.current.onResizeHandleKeyDown(event))
  return event
}

describe('useChatDrawerResize keyboard resize', () => {
  it('widens by one step on ArrowLeft (drawer grows leftward)', () => {
    const { result } = setup()
    expect(result.current.width).toBe(CHAT_DRAWER_DEFAULT_WIDTH) // 420
    press(result, 'ArrowLeft')
    expect(result.current.width).toBe(CHAT_DRAWER_DEFAULT_WIDTH + 24) // 444
  })

  it('narrows by one step on ArrowRight', () => {
    const { result } = setup()
    press(result, 'ArrowRight')
    expect(result.current.width).toBe(CHAT_DRAWER_DEFAULT_WIDTH - 24) // 396
  })

  it('jumps to the max on Home and the min on End', () => {
    const { result } = setup()
    press(result, 'Home')
    expect(result.current.width).toBe(CHAT_DRAWER_MAX_ABSOLUTE) // 820
    press(result, 'End')
    expect(result.current.width).toBe(CHAT_DRAWER_MIN_WIDTH) // 340
  })

  it('ignores unrelated keys and does not preventDefault them', () => {
    const { result } = setup()
    const event = press(result, 'a')
    expect(result.current.width).toBe(CHAT_DRAWER_DEFAULT_WIDTH)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('preventDefaults a handled key so the surface does not scroll', () => {
    const { result } = setup()
    const event = press(result, 'ArrowLeft')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })
})
