'use client'

import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const GAP_PX = 6
const EDGE_MARGIN_PX = 8
// Grace period for moving the pointer across the gap between the trigger and
// the card without dismissing it (WCAG 2.2 SC 1.4.13 "hoverable").
const HOVER_GRACE_MS = 80

// Portal-based hover tooltip for the agent lifecycle type.
//
// - Renders into document.body with fixed coordinates, so scrollable table
//   containers cannot clip it. The card is placed from its measured size,
//   flipped above the trigger when there is no room below, and clamped to
//   the window on both axes — all before paint.
// - Interaction model per WCAG 2.2 SC 1.4.13 (Content on Hover or Focus):
//   shows on pointer hover or keyboard focus, stays while the pointer moves
//   onto the card, stays while the trigger keeps focus even after the pointer
//   leaves, and Escape dismisses it until hover or focus returns.
// - Scroll closes a pointer-open tooltip (the hover intent is stale after the
//   content moved) and re-places one held open by keyboard focus.
export function HoverTooltip({
  label,
  tooltip,
  className,
}: {
  label: string
  tooltip: string
  className?: string
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissedByEscape, setDismissedByEscape] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [reflowTick, setReflowTick] = useState(0)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverMayReopenRef = useRef(true)
  const tooltipId = useId()
  const open = (hovered || focused) && !dismissedByEscape

  // Require a new hover interaction, so removing a card that overlaps its trigger
  // cannot immediately reopen it under a stationary pointer.
  const openHover = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    setHovered(true)
    if (hoverMayReopenRef.current) setDismissedByEscape(false)
  }
  const closeHoverSoon = () => {
    hoverMayReopenRef.current = true
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => setHovered(false), HOVER_GRACE_MS)
  }

  // Place the card before paint: measure it at its hidden provisional spot,
  // flip above the trigger when the space below is too tight, clamp both axes.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    // jsdom reports 0 for offsetWidth/Height; `||` falls back to the same
    // estimates a not-yet-laid-out card needs in a real browser.
    const cardWidth = cardRef.current?.offsetWidth || 288
    const cardHeight = cardRef.current?.offsetHeight || 40
    const halfWidth = Math.min(cardWidth / 2, window.innerWidth / 2 - EDGE_MARGIN_PX)
    const left = Math.min(
      Math.max(rect.left + rect.width / 2, halfWidth + EDGE_MARGIN_PX),
      window.innerWidth - halfWidth - EDGE_MARGIN_PX
    )
    const spaceBelow = window.innerHeight - rect.bottom - GAP_PX
    const flipAbove = spaceBelow < cardHeight + EDGE_MARGIN_PX && rect.top >= cardHeight + GAP_PX
    const preferredTop = flipAbove ? rect.top - GAP_PX - cardHeight : rect.bottom + GAP_PX
    const top = Math.max(
      EDGE_MARGIN_PX,
      Math.min(preferredTop, window.innerHeight - cardHeight - EDGE_MARGIN_PX)
    )
    setPos({ top, left })
  }, [open, reflowTick])

  useEffect(() => {
    if (!open) return
    const onScroll = (event: Event) => {
      // A constrained card can scroll its own text without losing hover intent.
      if (event.target instanceof Node && cardRef.current?.contains(event.target)) return
      setHovered(false)
      setReflowTick(tick => tick + 1)
    }
    const onResize = () => setReflowTick(tick => tick + 1)
    // Observe Escape wherever focus lives; leave dialog handlers and defaults intact.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        hoverMayReopenRef.current = false
        setDismissedByEscape(true)
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('keydown', onKeyDown, true)
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    }
  }, [open])

  return (
    <>
      <span
        ref={triggerRef}
        className={className}
        tabIndex={0}
        aria-describedby={open ? tooltipId : undefined}
        onMouseEnter={openHover}
        onMouseLeave={closeHoverSoon}
        onFocus={() => {
          setFocused(true)
          setDismissedByEscape(false)
        }}
        onBlur={() => setFocused(false)}
      >
        {label}
      </span>
      {open
        ? createPortal(
            <div
              ref={cardRef}
              role="tooltip"
              id={tooltipId}
              className="cu-hover-tooltip-card"
              style={
                pos
                  ? { top: pos.top, left: pos.left }
                  : // Hidden on the first open render: the placement effect
                    // measures this node and positions it before paint.
                    { top: -10000, left: -10000, visibility: 'hidden' }
              }
              onMouseEnter={openHover}
              onMouseLeave={closeHoverSoon}
            >
              {tooltip}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
