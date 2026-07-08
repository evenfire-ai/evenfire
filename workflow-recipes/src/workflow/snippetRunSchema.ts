export const SNIPPET_RUN_FIELD_NAMES = ['type', 'language', 'code', 'capabilities'] as const

export const SNIPPET_RUN_KEYS = new Set<string>(SNIPPET_RUN_FIELD_NAMES)
