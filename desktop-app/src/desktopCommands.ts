export type DesktopShortcutPlatform = 'darwin' | 'win32' | 'linux'
export type DesktopCommandSource = 'host' | 'sandbox'
export type DesktopCommandGroup =
  | 'Chat'
  | 'Navigation'
  | 'Search'
  | 'Commands'
  | 'Workspace'
  | 'Account'
export type DesktopCommandEligibility =
  | 'always'
  | 'tab-exists'
  | 'multiple-tabs'
  | 'tab-index'
  | 'searchable-content'
  | 'composer-available'

export type SemanticShortcutBinding = {
  key: string
  modifier: 'mod' | 'control'
  shift?: true
}

export type DesktopCommandDefinition = {
  id: string
  label: string
  description: string
  group: DesktopCommandGroup
  order: number
  defaultBinding: SemanticShortcutBinding | null
  sources: readonly DesktopCommandSource[]
  eligibility: DesktopCommandEligibility
  tabIndex?: number
  editingPolicy: 'allow' | 'suppress'
  modalPolicy: 'block' | 'toggle-palette'
  actionOwner: 'renderer'
  visibleInPalette: boolean
  visibleInSettings: boolean
}

export type DesktopCommandRuntimeContext = {
  tabCount: number
  searchableContent: boolean
  composerAvailable: boolean
}

function tabSelectCommand<const Id extends `tabs.select${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`>(
  id: Id,
  tabIndex: number
) {
  const number = tabIndex + 1
  return {
    id,
    label: `Select tab ${number}`,
    description: `Switch to chat tab ${number}.`,
    group: 'Navigation' as const,
    order: 30 + tabIndex,
    defaultBinding: { key: String(number), modifier: 'mod' as const },
    sources: ['host', 'sandbox'] as const,
    eligibility: 'tab-index' as const,
    tabIndex,
    editingPolicy: 'allow' as const,
    modalPolicy: 'block' as const,
    actionOwner: 'renderer' as const,
    visibleInPalette: true,
    visibleInSettings: true,
  }
}

const TAB_SELECT_COMMANDS = [
  tabSelectCommand('tabs.select1', 0),
  tabSelectCommand('tabs.select2', 1),
  tabSelectCommand('tabs.select3', 2),
  tabSelectCommand('tabs.select4', 3),
  tabSelectCommand('tabs.select5', 4),
  tabSelectCommand('tabs.select6', 5),
  tabSelectCommand('tabs.select7', 6),
  tabSelectCommand('tabs.select8', 7),
] as const

const definitions = [
  {
    id: 'chat.newTab',
    label: 'New chat tab',
    description: 'Open a blank chat view tab.',
    group: 'Chat',
    order: 10,
    defaultBinding: { key: 't', modifier: 'mod' },
    sources: ['host', 'sandbox'],
    eligibility: 'always',
    editingPolicy: 'allow',
    modalPolicy: 'block',
    actionOwner: 'renderer',
    visibleInPalette: true,
    visibleInSettings: true,
  },
  {
    id: 'chat.closeTab',
    label: 'Close current tab',
    description: 'Close the active chat view without deleting its conversation.',
    group: 'Chat',
    order: 20,
    defaultBinding: { key: 'w', modifier: 'mod' },
    sources: ['host', 'sandbox'],
    eligibility: 'tab-exists',
    editingPolicy: 'allow',
    modalPolicy: 'block',
    actionOwner: 'renderer',
    visibleInPalette: true,
    visibleInSettings: true,
  },
  ...TAB_SELECT_COMMANDS,
  {
    id: 'tabs.selectLast',
    label: 'Select last tab',
    description: 'Switch to the last open chat tab.',
    group: 'Navigation',
    order: 40,
    defaultBinding: { key: '9', modifier: 'mod' },
    sources: ['host', 'sandbox'],
    eligibility: 'tab-exists',
    editingPolicy: 'allow',
    modalPolicy: 'block',
    actionOwner: 'renderer',
    visibleInPalette: true,
    visibleInSettings: true,
  },
  {
    id: 'tabs.next',
    label: 'Next tab',
    description: 'Switch to the next chat tab, wrapping at the end.',
    group: 'Navigation',
    order: 50,
    defaultBinding: { key: 'Tab', modifier: 'control' },
    sources: ['host', 'sandbox'],
    eligibility: 'multiple-tabs',
    editingPolicy: 'allow',
    modalPolicy: 'block',
    actionOwner: 'renderer',
    visibleInPalette: true,
    visibleInSettings: true,
  },
  {
    id: 'tabs.previous',
    label: 'Previous tab',
    description: 'Switch to the previous chat tab, wrapping at the start.',
    group: 'Navigation',
    order: 60,
    defaultBinding: { key: 'Tab', modifier: 'control', shift: true },
    sources: ['host', 'sandbox'],
    eligibility: 'multiple-tabs',
    editingPolicy: 'allow',
    modalPolicy: 'block',
    actionOwner: 'renderer',
    visibleInPalette: true,
    visibleInSettings: true,
  },
  {
    id: 'search.open',
    label: 'Focus global search',
    description: 'Open and focus the existing Desktop application search.',
    group: 'Search',
    order: 70,
    defaultBinding: { key: 'f', modifier: 'mod' },
    sources: ['host', 'sandbox'],
    eligibility: 'always',
    editingPolicy: 'allow',
    modalPolicy: 'block',
    actionOwner: 'renderer',
    visibleInPalette: true,
    visibleInSettings: true,
  },
  {
    id: 'search.current',
    label: 'Search current content',
    description: 'Find text in the current chat or app.',
    group: 'Search',
    order: 80,
    defaultBinding: { key: 'f', modifier: 'mod', shift: true },
    sources: ['host', 'sandbox'],
    eligibility: 'searchable-content',
    editingPolicy: 'allow',
    modalPolicy: 'block',
    actionOwner: 'renderer',
    visibleInPalette: true,
    visibleInSettings: true,
  },
  {
    id: 'composer.focus',
    label: 'Focus message composer',
    description: 'Move keyboard focus to the current chat composer.',
    group: 'Chat',
    order: 90,
    defaultBinding: { key: 'l', modifier: 'mod', shift: true },
    sources: ['host', 'sandbox'],
    eligibility: 'composer-available',
    editingPolicy: 'allow',
    modalPolicy: 'block',
    actionOwner: 'renderer',
    visibleInPalette: true,
    visibleInSettings: true,
  },
  {
    id: 'commands.open',
    label: 'Open command palette',
    description: 'Search and run available Desktop commands.',
    group: 'Commands',
    order: 100,
    defaultBinding: { key: 'k', modifier: 'mod' },
    sources: ['host', 'sandbox'],
    eligibility: 'always',
    editingPolicy: 'allow',
    modalPolicy: 'toggle-palette',
    actionOwner: 'renderer',
    visibleInPalette: true,
    visibleInSettings: true,
  },
  {
    id: 'settings.open',
    label: 'Open Settings',
    description: 'Open Desktop settings.',
    group: 'Workspace',
    order: 110,
    defaultBinding: { key: ',', modifier: 'mod' },
    sources: ['host', 'sandbox'],
    eligibility: 'always',
    editingPolicy: 'allow',
    modalPolicy: 'block',
    actionOwner: 'renderer',
    visibleInPalette: true,
    visibleInSettings: true,
  },
  {
    id: 'settings.shortcuts',
    label: 'Keyboard shortcuts',
    description: 'Open the read-only keyboard shortcuts reference.',
    group: 'Commands',
    order: 120,
    defaultBinding: null,
    sources: ['host', 'sandbox'],
    eligibility: 'always',
    editingPolicy: 'allow',
    modalPolicy: 'block',
    actionOwner: 'renderer',
    visibleInPalette: true,
    visibleInSettings: false,
  },
  {
    id: 'auth.logout',
    label: 'Log out',
    description: 'Log out of the current Desktop session.',
    group: 'Account',
    order: 130,
    defaultBinding: null,
    sources: ['host', 'sandbox'],
    eligibility: 'always',
    editingPolicy: 'suppress',
    modalPolicy: 'block',
    actionOwner: 'renderer',
    visibleInPalette: true,
    visibleInSettings: false,
  },
  {
    id: 'navigate.chat',
    label: 'Go to Chat',
    description: 'Open the Chat workspace.',
    group: 'Navigation',
    order: 140,
    defaultBinding: null,
    sources: ['host', 'sandbox'],
    eligibility: 'always',
    editingPolicy: 'suppress',
    modalPolicy: 'block',
    actionOwner: 'renderer',
    visibleInPalette: true,
    visibleInSettings: false,
  },
  {
    id: 'navigate.apps',
    label: 'Go to Apps',
    description: 'Open the Apps workspace.',
    group: 'Navigation',
    order: 150,
    defaultBinding: null,
    sources: ['host', 'sandbox'],
    eligibility: 'always',
    editingPolicy: 'suppress',
    modalPolicy: 'block',
    actionOwner: 'renderer',
    visibleInPalette: true,
    visibleInSettings: false,
  },
  {
    id: 'navigate.agents',
    label: 'Go to Agents',
    description: 'Open the Agents workspace.',
    group: 'Navigation',
    order: 160,
    defaultBinding: null,
    sources: ['host', 'sandbox'],
    eligibility: 'always',
    editingPolicy: 'suppress',
    modalPolicy: 'block',
    actionOwner: 'renderer',
    visibleInPalette: true,
    visibleInSettings: false,
  },
  {
    id: 'notifications.open',
    label: 'Open notifications and approvals',
    description: 'Open the existing notifications and approvals tray.',
    group: 'Workspace',
    order: 170,
    defaultBinding: null,
    sources: ['host', 'sandbox'],
    eligibility: 'always',
    editingPolicy: 'suppress',
    modalPolicy: 'block',
    actionOwner: 'renderer',
    visibleInPalette: true,
    visibleInSettings: false,
  },
] as const satisfies readonly DesktopCommandDefinition[]

export type DesktopCommandId = (typeof definitions)[number]['id']

export const DESKTOP_COMMANDS: readonly DesktopCommandDefinition[] = definitions

export type DesktopShortcutInput = {
  type: string
  key: string
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  isAutoRepeat: boolean
  isComposing: boolean
}

export function isDesktopCommandId(value: unknown): value is DesktopCommandId {
  return typeof value === 'string' && definitions.some(command => command.id === value)
}

export function getDesktopCommand(id: DesktopCommandId): DesktopCommandDefinition {
  const command = definitions.find(candidate => candidate.id === id)
  if (!command) throw new Error(`Unknown Desktop command: ${id}`)
  return command
}

export function isDesktopCommandEligible(
  command: DesktopCommandDefinition,
  context: DesktopCommandRuntimeContext
): boolean {
  if (command.eligibility === 'always') return true
  if (command.eligibility === 'tab-exists') return context.tabCount > 0
  if (command.eligibility === 'multiple-tabs') return context.tabCount > 1
  if (command.eligibility === 'tab-index') {
    return command.tabIndex !== undefined && command.tabIndex < context.tabCount
  }
  if (command.eligibility === 'searchable-content') return context.searchableContent
  return context.composerAvailable
}

export function platformFromNode(platform: NodeJS.Platform): DesktopShortcutPlatform {
  if (platform === 'darwin' || platform === 'win32') return platform
  return 'linux'
}

export function platformFromNavigator(platform: string): DesktopShortcutPlatform {
  if (/mac/i.test(platform)) return 'darwin'
  if (/win/i.test(platform)) return 'win32'
  return 'linux'
}

function normalizedKey(value: string): string {
  return value.length === 1 ? value.toLowerCase() : value
}

export function bindingMatchesInput(
  binding: SemanticShortcutBinding,
  input: DesktopShortcutInput,
  platform: DesktopShortcutPlatform
): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat || input.isComposing || input.alt) return false
  if (input.control && input.alt) return false
  const usesMeta = binding.modifier === 'mod' && platform === 'darwin'
  if (usesMeta ? !input.meta || input.control : !input.control || input.meta) return false
  if (Boolean(binding.shift) !== input.shift) return false
  return normalizedKey(binding.key) === normalizedKey(input.key)
}

export function matchDesktopCommand(
  input: DesktopShortcutInput,
  platform: DesktopShortcutPlatform,
  source: DesktopCommandSource
): DesktopCommandDefinition | null {
  return (
    definitions.find(
      command =>
        command.defaultBinding &&
        command.sources.includes(source) &&
        bindingMatchesInput(command.defaultBinding, input, platform)
    ) ?? null
  )
}

export function formatDesktopShortcut(
  binding: SemanticShortcutBinding,
  platform: DesktopShortcutPlatform
): string {
  const key = binding.key === 'Tab' ? 'Tab' : binding.key.toUpperCase()
  if (platform === 'darwin' && binding.modifier === 'mod') {
    return `⌘${binding.shift ? '⇧' : ''}${key}`
  }
  if (platform === 'darwin') return `⌃${binding.shift ? '⇧' : ''}${key}`
  return `Ctrl+${binding.shift ? 'Shift+' : ''}${key}`
}

export function desktopBindingCollisionKey(
  binding: SemanticShortcutBinding,
  platform: DesktopShortcutPlatform
): string {
  const modifier = binding.modifier === 'mod' && platform === 'darwin' ? 'meta' : 'control'
  return `${modifier}+${binding.shift ? 'shift+' : ''}${normalizedKey(binding.key)}`
}
