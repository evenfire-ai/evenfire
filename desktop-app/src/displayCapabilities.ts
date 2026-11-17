/**
 * What this Desktop build shows in an agent reply. It rides on every chat
 * message so the agent writes only what the app can draw; a build that lacks
 * an entry never gets the agent writing for it. `mermaid`: fenced `mermaid`
 * blocks are drawn as diagrams.
 */
export const DESKTOP_DISPLAY_CAPABILITIES: readonly string[] = ['mermaid']
