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
  containerRef,
  ready,
  onResizeHandleMouseDown,
  onResizeHandleKeyDown,
  width,
  resizing,
  children,
}: ChatDrawerProps) {
  return (
    <aside
      className={`chat-drawer${ready ? ' is-ready' : ''}${resizing ? ' is-resizing' : ''}`}
      aria-label="Chat"
      data-ready={ready ? 'true' : 'false'}
      // Not-ready is hidden with `opacity: 0; pointer-events: none`, which stops
      // the mouse but NOT the keyboard: a `tabIndex=0` under opacity:0 is still
      // focusable, so between mount and the embed's bounds-ack Tab could land on
      // the invisible resize handle / CTAs. `inert` takes the whole subtree out
      // of the tab order (and the a11y tree) until the drawer is actually shown.
      inert={!ready}
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
        open={ready}
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
