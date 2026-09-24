import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// Regression guard for the narrow chat DRAWER (min width 340px) overflowing
// horizontally: the empty-state greeting header and the composer action row used
// to exceed the slim column and surface a horizontal scrollbar on
// `.chat-drawer__surface`. The full-screen chat route (same <ChatPage>) never had
// this because it wraps the workspace in `.chat-view-surface`, whose 0 width-floor
// + `overflow: hidden` clip it.
//
// A real layout assertion (`scrollWidth <= clientWidth` at 340px) is the ideal
// test, but this renderer has NO vitest browser-mode harness — the unit suite runs
// under jsdom, which performs no layout (every element reports scrollWidth 0), and
// the only real-layout lane is the heavy Playwright e2e that needs a live cluster.
// So this pins the CSS contract that makes the overflow impossible, at the source
// level, scoped entirely under `.chat-drawer` (the full-screen path is untouched).
// Whitespace-normalized copy so a rule can be located regardless of how its
// selector list is wrapped across lines in the source.
const styles = readFileSync(path.join(process.cwd(), 'ui/src/styles.css'), 'utf8').replace(
  /\s+/g,
  ' '
)

/** Return the declaration body of the first rule whose selector list matches. */
function ruleBody(selector: string): string {
  const normalized = selector.replace(/\s+/g, ' ').trim()
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = styles.match(new RegExp(`(?:^|[};/]) ?${escaped} ?{([^}]*)}`))
  const body = match?.[1]
  if (body === undefined) throw new Error(`rule not found: ${selector}`)
  return body
}

describe('chat drawer — no horizontal overflow', () => {
  it('gives the drawer scroll host a 0 width-floor and clips overflow-x', () => {
    const body = ruleBody('.chat-drawer__surface')
    expect(body).toMatch(/min-width:\s*0/)
    expect(body).toMatch(/overflow-x:\s*hidden/)
    // overflow-y stays scrollable — only the horizontal axis is clipped.
    expect(body).toMatch(/overflow-y:\s*auto/)
  })

  it('propagates the width-floor down the drawer chat body chain', () => {
    const body = ruleBody(
      '.chat-drawer .agent-page,\n.chat-drawer .agent-workspace-shell,\n.chat-drawer .agent-workspace-body-slot'
    )
    expect(body).toMatch(/min-width:\s*0/)
  })

  it('lets the drawer greeting row wrap, step down type, and shrink the selector', () => {
    expect(ruleBody('.chat-drawer .agent-workspace-shell .agent-workspace-greeting-row')).toMatch(
      /flex-wrap:\s*wrap/
    )
    // Heading + selector trigger drop from the full-screen 2xl to an lg step.
    expect(
      ruleBody(
        '.chat-drawer .agent-workspace-greeting-row .agent-workspace-greeting,\n.chat-drawer .agent-workspace-greeting-row .agent-title-selector-trigger.ui-button,\n.chat-drawer .agent-workspace-greeting-row .agent-title-selector-trigger.ui-button--sm'
      )
    ).toMatch(/font-size:\s*var\(--font-size-lg\)/)
    const selector = ruleBody('.chat-drawer .agent-workspace-greeting-row .agent-title-selector')
    expect(selector).toMatch(/flex:\s*0 1 auto/)
    expect(selector).toMatch(/min-width:\s*0/)
  })

  it('lets the drawer composer action row wrap and its right cluster shrink', () => {
    expect(ruleBody('.chat-drawer .composer-input-actions')).toMatch(/flex-wrap:\s*wrap/)
    const right = ruleBody('.chat-drawer .composer-actions-right')
    expect(right).toMatch(/min-width:\s*0/)
    expect(right).toMatch(/flex:\s*0 1 auto/)
  })

  // The composer reference submenu and the agent selector menu are portaled to
  // document.body and positioned with a fixed rect confined to the drawer in JS,
  // so they can no longer be cropped by the drawer's overflow-clipping ancestors
  // (or occluded by the native embed). Pin `position: fixed` and prove the old
  // in-flow drawer override is gone so nobody reintroduces the clipped in-flow
  // layout.
  it('portals the composer submenu and agent selector menu with a fixed rect', () => {
    expect(ruleBody('.composer-reference-submenu')).toMatch(/position:\s*fixed/)
    expect(ruleBody('.agent-title-selector-menu')).toMatch(/position:\s*fixed/)
    // The dead in-flow confinement override must not come back.
    expect(styles).not.toContain('.chat-drawer .composer-reference-submenu')
  })
})
