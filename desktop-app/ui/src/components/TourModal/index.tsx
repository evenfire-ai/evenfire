import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button, IconButton } from '@components/Common'
import { selectTourSteps } from '@hooks/domain/tourDeck'
import { getTourStepContent } from './steps'
import type { TourModalProps } from './types'

/**
 * The first-run tour: a self-contained centered modal.
 *
 * It references no real DOM geometry, so a sidebar refactor cannot break it and
 * it behaves identically when a surface is empty or still loading — the reason
 * this is a modal rather than spotlight cut-outs anchored to live elements.
 *
 * Step position is local state: it is ephemeral and dies with the modal, unlike
 * the seen flag, which the controller owns and persists.
 */
export function TourModal({ census, context, onDismiss }: TourModalProps) {
  const titleId = useId()
  const bodyId = useId()
  const primaryRef = useRef<HTMLButtonElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusRef = useRef<Element | null>(null)

  const steps = useMemo(() => selectTourSteps(census), [census])
  const [index, setIndex] = useState(0)
  // `selectTourSteps` always returns at least welcome + handoff, so the
  // fallback is unreachable — it exists to keep the index access total.
  const step = steps[index] ?? 'welcome'
  const content = getTourStepContent(step, context)

  const isLast = index === steps.length - 1
  const canGoBack = index > 0

  const next = useCallback(() => {
    setIndex(current => (current < steps.length - 1 ? current + 1 : current))
  }, [steps.length])
  const back = useCallback(() => setIndex(current => Math.max(0, current - 1)), [])

  // Remember what had focus so it can be handed back on close.
  useEffect(() => {
    restoreFocusRef.current = document.activeElement
    return () => {
      const restore = restoreFocusRef.current
      if (restore instanceof HTMLElement) restore.focus()
    }
  }, [])

  // Focus the primary action on open and again on every step change, so a
  // keyboard user advances without hunting for the button each time.
  useEffect(() => {
    primaryRef.current?.focus()
  }, [index])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Escape skips. A backdrop click deliberately does not: a stray click
      // should not end something the user sees once per install.
      if (event.key === 'Escape') {
        event.preventDefault()
        onDismiss()
        return
      }
      // Arrow keys mirror the buttons. The deck is linear, so there is exactly
      // one forward and one back from any step. The tour has no text fields,
      // so nothing else wants these keys.
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        next()
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        back()
        return
      }
      if (event.key !== 'Tab' || !cardRef.current) return

      // Trap focus inside the card.
      const focusable = cardRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onDismiss, next, back])

  return (
    <div className="tour-backdrop" role="presentation">
      <div
        className="tour-card glass-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        ref={cardRef}
      >
        <IconButton
          className="tour-close"
          label="Close tour"
          onClick={onDismiss}
          size="sm"
          variant="ghost"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </IconButton>

        {/* Illustration, title and body move as one block so they can sit
            centered in whatever space the fixed-height card leaves, rather
            than hugging the top with the slack dumped underneath. */}
        <div className="tour-content">
          <div className="tour-illustration">{content.illustration}</div>
          <h2 className="tour-title" id={titleId}>
            {content.title}
          </h2>
          {/* A div, not a p: a step's body may carry a list, and a ul inside a
              p is invalid markup the browser silently reparents. */}
          <div className="tour-body" id={bodyId}>
            {content.body}
          </div>
        </div>

        {/* Dots are decorative; the position is announced as text. */}
        <p className="tour-position">{`Step ${index + 1} of ${steps.length}`}</p>
        <div className="tour-dots" aria-hidden="true">
          {steps.map((id, dotIndex) => (
            <span className={`tour-dot${dotIndex === index ? ' is-current' : ''}`} key={id} />
          ))}
        </div>

        <div className="tour-actions">
          <Button disabled={!canGoBack} onClick={back} size="md" variant="text">
            Back
          </Button>
          <Button ref={primaryRef} onClick={isLast ? onDismiss : next} size="md">
            {isLast ? 'Get started' : 'Next'}
          </Button>
        </div>
      </div>
    </div>
  )
}
