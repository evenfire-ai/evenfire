const BYTES_PER_MIB = 1024 * 1024

/** The image limits a provider contract enforces, in the contract's own units. */
export type AttachmentBudgetLimits = {
  maxImageBytes: number
  maxTotalImageBytes: number
  maxVisualRequestBodyBytes: number
  /** Absent when the contract has no dimension limit (Grok, #784). */
  maxImageDimension?: number
  /** Absent when the contract has no pixel limit (Grok, #784). */
  maxImagePixels?: number
}

export type AttachmentBudgetRefusal = {
  pattern: RegExp
  requiresImage: boolean
  userMessage: string
}

/**
 * The contract `size` refusals that an attached image caused, each with the
 * sentence the user reads. The Desktop renders the classified message as the
 * error bubble under "Invalid Attachment", so the sentence names the limit the
 * image broke; the numbers come from the provider contract's own limits. Both
 * subscription contracts emit these messages byte for byte (#784 G1), so one
 * set of patterns serves both.
 *
 * The per-image messages carry a `messages[i].contentParts[j]: ` prefix, so
 * they are anchored at the end only. A dimension or pixel row exists only when
 * the provider has that limit. In Codex `maxImagePixels` equals
 * `maxImageDimension` squared and the dimension check runs first, so the pixel
 * refusal is unreachable with today's limits; it is mapped so a looser pixel
 * limit cannot reach the user as a raw contract string.
 *
 * The V2 whole-body ceiling (`maxVisualRequestBodyBytes`) is checked before any
 * part is parsed. It is an attachment refusal only when the request carries an
 * image: a V2 request whose text alone crosses it is a conversation that is too
 * long, and blaming an attachment the user never sent would be false.
 */
export function buildAttachmentBudgetRefusals(
  limits: AttachmentBudgetLimits
): ReadonlyArray<AttachmentBudgetRefusal> {
  return [
    {
      pattern: /image exceeds \d+ decoded bytes$/,
      requiresImage: false,
      userMessage: `An attached image is too large: it exceeds ${limits.maxImageBytes / BYTES_PER_MIB} MiB. Reduce its size and send it again.`,
    },
    ...(limits.maxImageDimension !== undefined
      ? [
          {
            pattern: /image dimension exceeds \d+$/,
            requiresImage: false,
            userMessage: `An attached image is too large: its width or height exceeds ${limits.maxImageDimension} pixels. Resize it and send it again.`,
          },
        ]
      : []),
    ...(limits.maxImagePixels !== undefined
      ? [
          {
            pattern: /image pixel count exceeds \d+$/,
            requiresImage: false,
            userMessage: `An attached image is too large: it has more than ${limits.maxImagePixels.toLocaleString('en-US')} pixels. Resize it and send it again.`,
          },
        ]
      : []),
    {
      pattern: /^request exceeds \d+ total image bytes$/,
      requiresImage: false,
      userMessage: `The attached images are too large together: they exceed ${limits.maxTotalImageBytes / BYTES_PER_MIB} MiB in total. Send fewer or smaller images.`,
    },
    {
      pattern: /^request exceeds maxVisualRequestBodyBytes$/,
      requiresImage: true,
      userMessage: `The message and its attached images are too large together: they exceed ${limits.maxVisualRequestBodyBytes / BYTES_PER_MIB} MiB. Send fewer or smaller images.`,
    },
  ]
}

/**
 * The user-facing sentence for a contract refusal caused by an attached image,
 * or `undefined` when the refusal is not an image budget in `table`.
 */
export function attachmentBudgetRefusalMessageFor(
  table: ReadonlyArray<AttachmentBudgetRefusal>,
  contractMessage: string,
  requestCarriesImage: boolean
): string | undefined {
  return table.find(
    refusal =>
      refusal.pattern.test(contractMessage) && (requestCarriesImage || !refusal.requiresImage)
  )?.userMessage
}
