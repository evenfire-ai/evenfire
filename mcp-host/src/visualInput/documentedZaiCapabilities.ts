/**
 * Documented z.ai image-input capability, resolved offline.
 *
 * z.ai's OpenAI-compatible Models API does not publish a modalities flag this
 * host can treat as authoritative, so there is nothing to read back at runtime.
 * This module binds one factual table of published model contracts to the one
 * endpoint those contracts were published for. A model is image-capable only
 * when both hold:
 *
 *   1. the transport targets the official GLM Coding Plan endpoint, and
 *   2. the exact requested id appears in {@link DOCUMENTED_ZAI_IMAGE_MODELS}.
 *
 * Everything else is `unknown`. There is no prefix, family, or size heuristic.
 * The table is a contract with sources, not a catalog: each entry carries the
 * official page it was verified against. This is provider-local contract data,
 * not a replacement for discovery or the broader capability catalog in #654.
 *
 * This module performs no I/O, reads no key, and never infers capability from a
 * model name. Absence of an entry means "not proven", never "not capable".
 */
import type { ImageInputCapability } from './policy'

/** The provider identity reported for a supported model. */
export const ZAI_PROVIDER = 'zai'
/**
 * Fixed, bounded provenance string. The model id is echoed back exactly as
 * requested, so a caller can correlate the answer with its own request; the
 * evidence never contains upstream text.
 */
export const ZAI_DOCUMENTED_EVIDENCE = 'zai-documented-model-contract'
/** The only endpoint whose model contracts this table describes. */
export const OFFICIAL_ZAI_CODING_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'

/**
 * One verified model contract: the documented model id and the official page
 * it was read from.
 */
export interface DocumentedZaiImageModel {
  /** Documented model id accepted verbatim by the Chat Completions API. */
  readonly id: string
  /** Official page this contract was verified against. */
  readonly source: string
}

/**
 * Verified on 2026-09-17. GLM-5.3-Flash is the first native multimodal model
 * in the GLM-5 series and documents image input via `image_url` content blocks
 * on the GLM Coding Plan.
 */
export const DOCUMENTED_ZAI_IMAGE_MODELS: readonly DocumentedZaiImageModel[] = Object.freeze([
  Object.freeze({
    id: 'glm-5.3-flash',
    source: 'https://docs.z.ai/guides/vlm/glm-5.3-flash',
  }),
])

const UNKNOWN = Object.freeze({ status: 'unknown' as const })

const DOCUMENTED_MODEL_IDS: ReadonlySet<string> = new Set(
  DOCUMENTED_ZAI_IMAGE_MODELS.map(entry => entry.id)
)

/**
 * Reads the documented image-input contract for one exact model id. Returns
 * `supported` with the requested id only when the transport targets the official
 * Coding Plan endpoint and this module has a verified contract for that id;
 * otherwise `unknown`, so an unproven model is never handed an image.
 */
export function getDocumentedZaiImageCapability(
  model: string,
  baseURL: string | undefined
): ImageInputCapability {
  if (!targetsOfficialZaiCodingEndpoint(baseURL)) return UNKNOWN
  // Exact membership only: no trimming, no case folding, no prefix family.
  if (!DOCUMENTED_MODEL_IDS.has(model)) return UNKNOWN

  return Object.freeze({
    status: 'supported' as const,
    provider: ZAI_PROVIDER,
    model,
    evidence: ZAI_DOCUMENTED_EVIDENCE,
  })
}

/**
 * True only for the resolved official `https://api.z.ai/api/coding/paas/v4`
 * base. An absent endpoint is unverified. Any other origin, path, scheme, port,
 * or a URL carrying userinfo, query, or fragment is a different deployment
 * whose model contracts this table does not describe.
 */
function targetsOfficialZaiCodingEndpoint(baseURL: string | undefined): boolean {
  if (baseURL === undefined) return false

  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.search !== '' || url.hash !== '') return false
  if (url.hostname !== 'api.z.ai') return false
  if (url.port !== '' && url.port !== '443') return false
  const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname
  return path === '/api/coding/paas/v4'
}
