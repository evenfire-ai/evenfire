import { useEffect, useRef, useState } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { IconButton, MenuItem } from '@components/Common'
import { ConfirmDialog } from '@components/ConfirmDialog'
import {
  LOCALHOST_RUNTIME_CONFIG_OPTION_ID,
  createLocalhostRuntimeConfigOption,
} from '@constants/runtimeConfig'
import { useLocalhostReachable } from '@hooks/useLocalhostReachable'
import type { DesktopRuntimeConfigOption } from '../../../../src/types'

interface RuntimeConfigDockProps {
  /**
   * Where "Add environment" goes. AuthPage opens its inline environment form;
   * onboarding moves to its manual step. The dock itself stays identical, so
   * the Localhost escape hatch is reachable from both — a
   * cold install renders onboarding, not AuthPage, and would otherwise have no
   * way to reach it.
   */
  onAddEnvironment: () => void
}

export function RuntimeConfigDock({ onAddEnvironment }: RuntimeConfigDockProps) {
  const {
    busy,
    authTransitioning,
    runtimeConfigState,
    handleDeleteRuntimeConfig,
    handleSelectRuntimeConfig,
    handleClearRuntimeConfigSelection,
  } = useAuthContext()

  const [runtimeMenuOpen, setRuntimeMenuOpen] = useState(false)
  const [pendingDeleteOption, setPendingDeleteOption] = useState<DesktopRuntimeConfigOption | null>(
    null
  )
  const runtimeDockRef = useRef<HTMLDivElement | null>(null)

  const runtimeConfigOptions = runtimeConfigState?.options || []
  const activeRuntimeConfigId = runtimeConfigState?.activeOptionId ?? null
  const selectedRuntimeConfig = runtimeConfigOptions.find(
    option => option.id === activeRuntimeConfigId
  )
  const savedRuntimeConfigOptions = runtimeConfigOptions.filter(option => option.source === 'file')
  const localhostRuntimeConfigOption = runtimeConfigOptions.find(
    option => option.source === 'localhost'
  )
  // Offer Localhost only when a local Evenfire actually answers, so the menu
  // never advertises a server that isn't there. The exception is a Localhost
  // that is already the active environment: hiding the row the user is
  // currently on would strand them with no way to see or leave it — a cluster
  // that went down mid-session is exactly when that row matters most.
  const localhostIsActive =
    activeRuntimeConfigId === LOCALHOST_RUNTIME_CONFIG_OPTION_ID ||
    selectedRuntimeConfig?.source === 'localhost'
  const localhostReachable = useLocalhostReachable()
  const displayedLocalhostRuntimeConfigOption =
    localhostReachable || localhostIsActive
      ? localhostRuntimeConfigOption || createLocalhostRuntimeConfigOption()
      : null

  const handleRuntimeOptionSelect = (optionId: string) => {
    setRuntimeMenuOpen(false)
    if (
      optionId === activeRuntimeConfigId &&
      (selectedRuntimeConfig?.source === 'localhost' ||
        optionId === LOCALHOST_RUNTIME_CONFIG_OPTION_ID)
    ) {
      handleClearRuntimeConfigSelection()
      return
    }
    handleSelectRuntimeConfig(optionId)
  }

  const confirmDeleteRuntimeOption = () => {
    if (!pendingDeleteOption) return
    handleDeleteRuntimeConfig(pendingDeleteOption.id)
    setPendingDeleteOption(null)
  }

  useEffect(() => {
    if (!runtimeMenuOpen) {
      return
    }

    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (runtimeDockRef.current?.contains(event.target as Node)) {
        return
      }

      setRuntimeMenuOpen(false)
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setRuntimeMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', handleDocumentPointerDown)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('pointerdown', handleDocumentPointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [runtimeMenuOpen])

  if (!runtimeConfigState) return null

  return (
    <>
      <aside className="auth-runtime-dock" ref={runtimeDockRef}>
        <IconButton
          className="auth-runtime-dock__toggle"
          aria-label="Open environment selector"
          aria-expanded={runtimeMenuOpen}
          aria-controls="auth-runtime-dock-panel"
          label="Open environment selector"
          onClick={() => setRuntimeMenuOpen(open => !open)}
          variant="soft"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M19.43 12.98a7.9 7.9 0 0 0 .05-.98 7.9 7.9 0 0 0-.05-.98l2.11-1.65a.48.48 0 0 0 .12-.61l-2-3.46a.49.49 0 0 0-.58-.22l-2.49 1a7.2 7.2 0 0 0-1.7-.98l-.38-2.65A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.41l-.38 2.65a7.2 7.2 0 0 0-1.7.98l-2.49-1a.49.49 0 0 0-.58.22l-2 3.46a.48.48 0 0 0 .12.61l2.11 1.65a7.9 7.9 0 0 0-.05.98 7.9 7.9 0 0 0 .05.98l-2.11 1.65a.48.48 0 0 0-.12.61l2 3.46a.49.49 0 0 0 .58.22l2.49-1a7.2 7.2 0 0 0 1.7.98l.38 2.65A.49.49 0 0 0 10 22h4a.49.49 0 0 0 .49-.41l.38-2.65a7.2 7.2 0 0 0 1.7-.98l2.49 1a.49.49 0 0 0 .58-.22l2-3.46a.48.48 0 0 0-.12-.61Zm-7.43 2.52A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5Z" />
          </svg>
        </IconButton>
        {runtimeMenuOpen ? (
          <div className="auth-runtime-dock__panel glass-card" id="auth-runtime-dock-panel">
            <div className="auth-runtime-menu__header">
              <span className="auth-runtime-menu__label">Environment</span>
              <IconButton
                aria-label="Add environment"
                disabled={busy || authTransitioning}
                label="Add environment"
                onClick={() => {
                  setRuntimeMenuOpen(false)
                  onAddEnvironment()
                }}
                size="sm"
                variant="ghost"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M12 5v14" />
                  <path d="M5 12h14" />
                </svg>
              </IconButton>
            </div>
            <div className="auth-runtime-menu">
              {savedRuntimeConfigOptions.length > 0 ? (
                <section className="auth-runtime-menu__section">
                  {savedRuntimeConfigOptions.map(option => {
                    const selected = option.id === activeRuntimeConfigId
                    return (
                      <div
                        key={option.id}
                        className={`auth-runtime-menu__row${selected ? ' selected' : ''}`}
                      >
                        <MenuItem
                          className={`auth-runtime-menu__select${selected ? ' selected' : ''}`}
                          active={selected}
                          disabled={busy || authTransitioning}
                          leadingIcon={
                            <span className="auth-runtime-menu__check" aria-hidden="true">
                              {selected ? (
                                <svg viewBox="0 0 24 24" focusable="false">
                                  <path d="M20 6 9 17l-5-5" />
                                </svg>
                              ) : null}
                            </span>
                          }
                          onClick={() => handleRuntimeOptionSelect(option.id)}
                        >
                          {option.label}
                        </MenuItem>
                        <IconButton
                          className="auth-runtime-menu__delete"
                          aria-label={`Delete ${option.appName} environment`}
                          color="danger"
                          disabled={busy || authTransitioning}
                          label={`Delete ${option.appName}`}
                          onClick={() => setPendingDeleteOption(option)}
                          size="sm"
                          title={`Delete ${option.appName}`}
                          variant="ghost"
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <path d="M3 6h18" />
                            <path d="M8 6V4h8v2" />
                            <path d="M6 6l1 15h10l1-15" />
                            <path d="M10 10v7" />
                            <path d="M14 10v7" />
                          </svg>
                        </IconButton>
                      </div>
                    )
                  })}
                </section>
              ) : null}
              {displayedLocalhostRuntimeConfigOption ? (
                <section className="auth-runtime-menu__section">
                  {(() => {
                    const option = displayedLocalhostRuntimeConfigOption
                    const selected = option.id === activeRuntimeConfigId
                    return (
                      <MenuItem
                        className={`auth-runtime-menu__select auth-runtime-menu__select--standalone${
                          selected ? ' selected' : ''
                        }`}
                        active={selected}
                        disabled={busy || authTransitioning}
                        leadingIcon={
                          <span className="auth-runtime-menu__check" aria-hidden="true">
                            {selected ? (
                              <svg viewBox="0 0 24 24" focusable="false">
                                <path d="M20 6 9 17l-5-5" />
                              </svg>
                            ) : null}
                          </span>
                        }
                        onClick={() => handleRuntimeOptionSelect(option.id)}
                      >
                        Localhost
                      </MenuItem>
                    )
                  })()}
                </section>
              ) : null}
            </div>
          </div>
        ) : null}
      </aside>
      {pendingDeleteOption ? (
        <ConfirmDialog
          title="Delete environment?"
          body={
            <p>
              Delete <strong>{pendingDeleteOption.appName}</strong>? This only removes the local
              desktop environment configuration.
            </p>
          }
          confirmLabel="Delete"
          tone="danger"
          onCancel={() => setPendingDeleteOption(null)}
          onConfirm={confirmDeleteRuntimeOption}
        />
      ) : null}
    </>
  )
}
