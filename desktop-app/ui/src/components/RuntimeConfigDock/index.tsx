import { useEffect, useRef, useState } from 'react'
import { CheckOutlined, DeleteOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons'
import { useAuthContext } from '@contexts/AuthContext'
import { Button, Card, Dropdown, Flex, FloatButton, Modal, Typography } from 'antd'
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

const runtimeDockPanelId = 'auth-runtime-dock-panel'
const runtimeDockCancelDeleteButtonId = 'auth-runtime-dock-cancel-delete'

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
  const runtimeDockTriggerRef = useRef<HTMLButtonElement | null>(null)
  const runtimeDockHasFocusRef = useRef(false)
  const authBusyRef = useRef(busy || authTransitioning)
  authBusyRef.current = busy || authTransitioning

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
    if (!busy && !authTransitioning) runtimeDockTriggerRef.current?.focus()
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
    if (!runtimeMenuOpen) return

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setRuntimeMenuOpen(false)
      if (!busy && !authTransitioning) runtimeDockTriggerRef.current?.focus()
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [runtimeMenuOpen, busy, authTransitioning])

  useEffect(() => {
    const isRuntimeDockTarget = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return false
      const runtimeMenu = document.getElementById(runtimeDockPanelId)
      return Boolean(
        runtimeDockTriggerRef.current?.contains(target) || runtimeMenu?.contains(target)
      )
    }
    const handleFocusIn = (event: FocusEvent) => {
      if (authBusyRef.current) return
      runtimeDockHasFocusRef.current = isRuntimeDockTarget(event.target)
    }
    const handleFocusOut = (event: FocusEvent) => {
      if (authBusyRef.current) return
      runtimeDockHasFocusRef.current = isRuntimeDockTarget(event.relatedTarget)
    }

    document.addEventListener('focusin', handleFocusIn)
    document.addEventListener('focusout', handleFocusOut)
    return () => {
      document.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('focusout', handleFocusOut)
    }
  }, [])

  useEffect(() => {
    if (!busy && !authTransitioning) {
      return
    }

    if (runtimeMenuOpen) setRuntimeMenuOpen(false)
    if (!runtimeDockHasFocusRef.current) return

    const focusReleaseTimer = window.setTimeout(() => {
      document.querySelector<HTMLElement>('main[tabindex="-1"]')?.focus()
      runtimeDockHasFocusRef.current = false
    }, 0)

    return () => window.clearTimeout(focusReleaseTimer)
  }, [runtimeMenuOpen, busy, authTransitioning])

  if (!runtimeConfigState) return null

  const renderRuntimeOption = (option: DesktopRuntimeConfigOption, deletable = false) => {
    const selected = option.id === activeRuntimeConfigId
    return (
      <Flex key={option.id} align="center" gap="small">
        <Button
          aria-pressed={selected}
          block
          disabled={busy || authTransitioning}
          htmlType="button"
          onClick={() => handleRuntimeOptionSelect(option.id)}
          type={selected ? 'primary' : 'default'}
        >
          <Flex align="center" gap="small">
            {selected ? <CheckOutlined aria-hidden="true" /> : null}
            <Typography.Text>{option.label}</Typography.Text>
          </Flex>
        </Button>
        {deletable ? (
          <Button
            aria-label={`Delete ${option.appName} environment`}
            danger
            disabled={busy || authTransitioning}
            htmlType="button"
            icon={<DeleteOutlined aria-hidden="true" />}
            onClick={() => setPendingDeleteOption(option)}
            size="small"
            title={`Delete ${option.appName}`}
            type="text"
          />
        ) : null}
      </Flex>
    )
  }

  const popup = (
    <Card
      extra={
        <Button
          aria-label="Add environment"
          disabled={busy || authTransitioning}
          htmlType="button"
          icon={<PlusOutlined aria-hidden="true" />}
          onClick={() => {
            setRuntimeMenuOpen(false)
            onAddEnvironment()
          }}
          size="small"
          title="Add environment"
          type="text"
        />
      }
      id={runtimeDockPanelId}
      size="small"
      title="Environment"
    >
      <Flex vertical gap="small">
        {savedRuntimeConfigOptions.map(option => renderRuntimeOption(option, true))}
        {displayedLocalhostRuntimeConfigOption
          ? renderRuntimeOption(displayedLocalhostRuntimeConfigOption)
          : null}
      </Flex>
    </Card>
  )

  return (
    <>
      <aside>
        <Dropdown
          open={runtimeMenuOpen}
          onOpenChange={open => setRuntimeMenuOpen(open && !busy && !authTransitioning)}
          placement="topRight"
          popupRender={() => popup}
          trigger={['click']}
        >
          <FloatButton
            {...{
              'aria-controls': runtimeDockPanelId,
              'aria-expanded': runtimeMenuOpen,
              title: 'Open environment selector',
            }}
            aria-label="Open environment selector"
            disabled={busy || authTransitioning}
            htmlType="button"
            icon={<SettingOutlined aria-hidden="true" />}
            ref={trigger => {
              runtimeDockTriggerRef.current = trigger
            }}
            type="default"
          />
        </Dropdown>
      </aside>
      <Modal
        centered
        closable={false}
        destroyOnHidden
        open={Boolean(pendingDeleteOption)}
        title="Delete environment?"
        okText="Delete"
        cancelText="Cancel"
        okButtonProps={{ danger: true, htmlType: 'button' }}
        cancelButtonProps={{ htmlType: 'button', id: runtimeDockCancelDeleteButtonId }}
        focusable={{ focusTriggerAfterClose: true }}
        keyboard
        mask={{ closable: true }}
        afterOpenChange={open => {
          if (open) document.getElementById(runtimeDockCancelDeleteButtonId)?.focus()
        }}
        onCancel={() => setPendingDeleteOption(null)}
        onOk={confirmDeleteRuntimeOption}
        zIndex={2300}
      >
        {pendingDeleteOption ? (
          <Typography.Paragraph>
            Delete <Typography.Text strong>{pendingDeleteOption.appName}</Typography.Text>? This
            only removes the local desktop environment configuration.
          </Typography.Paragraph>
        ) : null}
      </Modal>
    </>
  )
}
