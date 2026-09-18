import express from 'express'

// Default JSON ceiling for authenticated non-chat routes. Chat messages that
// carry inline images use `chatJsonBody` (24 MiB envelope + hop credit) instead.
// Mount either parser on each route right after its authentication middleware
// so unauthenticated requests are never parsed.
export const JSON_BODY_LIMIT = '10mb'

export const jsonBody = express.json({ limit: JSON_BODY_LIMIT })
