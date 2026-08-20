export const HOST_DEFAULT_TAB = 'details'

export const HOST_TABS = ['details', 'identity', 'model', 'contexts', 'access', 'advanced'] as const

export type HostTab = (typeof HOST_TABS)[number]
