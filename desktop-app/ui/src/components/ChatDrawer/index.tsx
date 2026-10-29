import { useEffect, useState } from 'react'
import { FullscreenOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons'
import { Button, Drawer, Flex } from 'antd'
import { CHAT_DRAWER_MAX_ABSOLUTE, CHAT_DRAWER_MIN_WIDTH } from '@hooks/useChatDrawerResize'
import type { ChatDrawerProps } from './types'

/**
 * Cursor-style chat drawer that coexists with the live sandbox-ui embed on the
 * `apps` route. It is a `position: fixed` right column; the drawer and the embed
 * are always docked side by side — the embed slot is permanently shrunk with
 * `padding-right` so the native WebContentsView (which paints over the DOM
 * regardless of z-index) never overlaps the drawer.
 *
 * The drawer mounts a single <ChatPage> (passed as children) driven by the same
 * global `chatViewTabs` state as the full-screen chat route — no duplicated tab
 * state and no duplicated streams.
 */
export function ChatDrawer({
  header,
  onNewChat,
  onExpandFullScreen,
  onCollapse,
  open,
  onAfterClose,
  containerRef,
  ready,
  onResizeHandleMouseDown,
  onResizeHandleKeyDown,
  width,
  resizing,
  children,
}: ChatDrawerProps) {
  const [retainedReady, setRetainedReady] = useState(ready)
  const drawerOpen = open && ready

  useEffect(() => {
    if (ready) setRetainedReady(true)
  }, [ready])

  return (
    <aside
      className={`chat-drawer${ready || retainedReady ? ' is-ready' : ''}${drawerOpen ? ' is-open' : ''}${resizing ? ' is-resizing' : ''}`}
      aria-label="Chat"
      aria-hidden={!drawerOpen}
      data-ready={ready ? 'true' : 'false'}
      // A hidden or closing drawer is inert even while it remains mounted for
      // Ant Design's exit motion, so controls cannot receive focus or input.
      inert={!drawerOpen}
    >
      <div
        className="chat-drawer__resize-handle"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize chat drawer"
        aria-valuemin={CHAT_DRAWER_MIN_WIDTH}
        aria-valuemax={CHAT_DRAWER_MAX_ABSOLUTE}
        aria-valuenow={Math.round(width)}
        onMouseDown={onResizeHandleMouseDown}
        onKeyDown={onResizeHandleKeyDown}
      />
      <Drawer
        aria-label="Chat"
        aria-modal={false}
        autoFocus={false}
        closable={false}
        destroyOnHidden={false}
        extra={
          <Flex align="center" gap="small" className="chat-drawer__header-actions">
            <Button
              aria-label="New chat"
              htmlType="button"
              icon={<PlusOutlined aria-hidden="true" />}
              size="small"
              type="text"
              title="New chat"
              onClick={onNewChat}
            />
            <Button
              aria-label="Open chat in full screen"
              htmlType="button"
              icon={<FullscreenOutlined aria-hidden="true" />}
              size="small"
              type="text"
              title="Open chat in full screen"
              onClick={onExpandFullScreen}
            />
            <Button
              aria-label="Collapse chat drawer"
              htmlType="button"
              icon={<RightOutlined aria-hidden="true" />}
              size="small"
              type="text"
              title="Collapse chat drawer"
              onClick={onCollapse}
            />
          </Flex>
        }
        forceRender
        focusable={{ trap: false, focusTriggerAfterClose: false }}
        getContainer={false}
        keyboard={false}
        mask={false}
        afterOpenChange={isOpen => {
          if (!isOpen) {
            setRetainedReady(false)
            onAfterClose()
          }
        }}
        open={drawerOpen}
        placement="right"
        rootStyle={{ position: 'absolute', inset: 0 }}
        size={width}
        title={<div className="chat-drawer__header-main">{header}</div>}
        zIndex={1}
      >
        <div className="chat-drawer__surface" ref={containerRef as React.RefObject<HTMLDivElement>}>
          {children}
        </div>
      </Drawer>
    </aside>
  )
}
