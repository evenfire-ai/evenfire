export const COMPOSER_MAX_IMAGE_ATTACHMENTS = 3
export const COMPOSER_MAX_IMAGE_BYTES = 3 * 1024 * 1024
export const COMPOSER_ACCEPT_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'] as const
export const ZAI_IMAGE_ATTACHMENT_UNSUPPORTED_MESSAGE =
  'Image attachments are not supported for agents running on Z AI yet. Switch this agent to a provider with image input support before attaching images.'
