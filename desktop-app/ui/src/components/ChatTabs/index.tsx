import { Button } from '@components/Common'
import type { ChatTabsProps } from './types'

export function ChatTabs({ tabs, activeTabId, onSelect, onClose, panelId }: ChatTabsProps) {
  return (
    <div className="chat-view-tabs" role="toolbar" aria-label="Chat tabs">
      <div className="chat-view-tabs__list">
        {tabs.map(tab => {
          const active = tab.id === activeTabId
          return (
            <div className={`chat-view-tab${active ? ' is-active' : ''}`} key={tab.id}>
              <Button
                align="start"
                aria-controls={active ? panelId : undefined}
                aria-pressed={active}
                className="chat-view-tab__select"
                color="neutral"
                onClick={() => onSelect(tab.id)}
                size="sm"
                variant="ghost"
              >
                <span className="chat-view-tab__label">{tab.title}</span>
              </Button>
              <Button
                aria-label={`Close ${tab.title}`}
                className="chat-view-tab__close"
                color="neutral"
                onClick={() => onClose(tab.id)}
                size="xs"
                variant="ghost"
              >
                <span aria-hidden="true">×</span>
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
