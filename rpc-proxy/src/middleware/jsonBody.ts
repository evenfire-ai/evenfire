import express from 'express'

// The single request body limit for every JSON route: up to 8 MB of base64
// images from the Desktop composer (COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES)
// plus the message text and JSON envelope. Mount `jsonBody` on each route
// right after its authentication middleware so unauthenticated requests are
// never parsed.
export const JSON_BODY_LIMIT = '10mb'

export const jsonBody = express.json({ limit: JSON_BODY_LIMIT })
