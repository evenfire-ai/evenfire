/**
 * Max length of an app tab's live title (mini-spec 08 §2). The title is
 * controlled by the plugin (`document.title` of the embed), so it is bounded
 * before it reaches the host chrome; longer values are truncated to this length
 * with a trailing ellipsis by `sanitizeAppTabTitle`.
 */
export const MAX_TAB_TITLE_LEN = 64
