/**
 * Documented OpenAI image-input capability, resolved offline.
 *
 * OpenAI's Models API reports an id and an owner but not modalities
 * (https://developers.openai.com/api/reference/cli/resources/models/methods/retrieve),
 * so there is nothing to read back at runtime. Instead this module binds one
 * factual table of published model contracts to the one endpoint those contracts
 * were published for. A model is image-capable only when both hold:
 *
 *   1. the transport targets the official `https://api.openai.com/v1` endpoint, and
 *   2. the exact requested id appears in {@link DOCUMENTED_OPENAI_IMAGE_MODELS}.
 *
 * Everything else is `unknown`. There is no prefix, family, or size heuristic:
 * an id is listed only when a verified page documents `Image: Input only` *and*
 * the id is in scope for this provider's Chat Completions path. Codex variants,
 * Pro variants, audio/realtime models, and every unlisted id therefore stay
 * `unknown`; some of them (for example `gpt-5-pro` and `gpt-5.1-codex`) document
 * image input on their own pages, which on its own is not enough to list them
 * here. The table is a contract with sources, not a catalog: each entry carries
 * the official page it was verified against and the snapshot ids that page
 * lists.
 *
 * This module performs no I/O, reads no key, and never infers capability from a
 * model name. Absence of an entry means "not proven", never "not capable".
 */
import type { ImageInputCapability } from './policy'

/** The provider identity reported for a supported model. */
export const OPENAI_PROVIDER = 'openai'
/**
 * Fixed, bounded provenance string. The model id is echoed back exactly as
 * requested, so a caller can correlate the answer with its own request; the
 * evidence never contains upstream text.
 */
export const OPENAI_DOCUMENTED_EVIDENCE = 'openai-documented-model-contract'
/** The only endpoint whose model contracts this table describes. */
export const OFFICIAL_OPENAI_BASE_URL = 'https://api.openai.com/v1'

/**
 * One verified model contract: the documented model id, the snapshot ids the
 * same page lists for it, and the official page they were read from.
 */
export interface DocumentedOpenAIImageModel {
  /** Documented model id, accepted verbatim as `model` by the Chat Completions API. */
  readonly id: string
  /** Snapshot ids listed for {@link id} on the same page; empty for pointer aliases. */
  readonly snapshots: readonly string[]
  /** Official page this contract was verified against. */
  readonly source: string
}

/**
 * Verified on 2026-09-17. Every entry's page documents image input and the
 * snapshot ids listed here. This is provider-local contract data, not a
 * replacement for discovery or the broader capability catalog in #654.
 */
export const DOCUMENTED_OPENAI_IMAGE_MODELS: readonly DocumentedOpenAIImageModel[] = Object.freeze([
  Object.freeze({
    id: 'gpt-4.1',
    snapshots: Object.freeze(['gpt-4.1-2025-04-14']),
    source: 'https://developers.openai.com/api/docs/models/gpt-4.1',
  }),
  Object.freeze({
    id: 'gpt-4.1-mini',
    snapshots: Object.freeze(['gpt-4.1-mini-2025-04-14']),
    source: 'https://developers.openai.com/api/docs/models/gpt-4.1-mini',
  }),
  Object.freeze({
    id: 'gpt-4.1-nano',
    snapshots: Object.freeze(['gpt-4.1-nano-2025-04-14']),
    source: 'https://developers.openai.com/api/docs/models/gpt-4.1-nano',
  }),
  Object.freeze({
    id: 'gpt-4o',
    snapshots: Object.freeze(['gpt-4o-2024-05-13', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20']),
    source: 'https://developers.openai.com/api/docs/models/gpt-4o',
  }),
  Object.freeze({
    id: 'gpt-4o-mini',
    snapshots: Object.freeze(['gpt-4o-mini-2024-07-18']),
    source: 'https://developers.openai.com/api/docs/models/gpt-4o-mini',
  }),
  Object.freeze({
    id: 'gpt-5.4-mini',
    snapshots: Object.freeze(['gpt-5.4-mini-2026-03-17']),
    source: 'https://developers.openai.com/api/docs/models/gpt-5.4-mini',
  }),
  Object.freeze({
    id: 'gpt-5.4',
    snapshots: Object.freeze(['gpt-5.4-2026-03-05']),
    source: 'https://developers.openai.com/api/docs/models/gpt-5.4',
  }),
  Object.freeze({
    id: 'gpt-5.4-nano',
    snapshots: Object.freeze(['gpt-5.4-nano-2026-03-17']),
    source: 'https://developers.openai.com/api/docs/models/gpt-5.4-nano',
  }),
  Object.freeze({
    id: 'gpt-5',
    snapshots: Object.freeze(['gpt-5-2025-08-07']),
    source: 'https://developers.openai.com/api/docs/models/gpt-5',
  }),
  Object.freeze({
    id: 'gpt-5-mini',
    snapshots: Object.freeze(['gpt-5-mini-2025-08-07']),
    source: 'https://developers.openai.com/api/docs/models/gpt-5-mini',
  }),
  Object.freeze({
    id: 'gpt-5-nano',
    snapshots: Object.freeze(['gpt-5-nano-2025-08-07']),
    source: 'https://developers.openai.com/api/docs/models/gpt-5-nano',
  }),
  Object.freeze({
    id: 'gpt-5-chat-latest',
    snapshots: Object.freeze([]),
    source: 'https://developers.openai.com/api/docs/models/gpt-5-chat-latest',
  }),
  Object.freeze({
    id: 'gpt-5.1-chat-latest',
    snapshots: Object.freeze([]),
    source: 'https://developers.openai.com/api/docs/models/gpt-5.1-chat-latest',
  }),
  Object.freeze({
    id: 'gpt-5.2-chat-latest',
    snapshots: Object.freeze([]),
    source: 'https://developers.openai.com/api/docs/models/gpt-5.2-chat-latest',
  }),
  Object.freeze({
    id: 'gpt-5.3-chat-latest',
    snapshots: Object.freeze([]),
    source: 'https://developers.openai.com/api/docs/models/gpt-5.3-chat-latest',
  }),
])

const UNKNOWN = Object.freeze({ status: 'unknown' as const })

/** Aliases and snapshots share one lookup: both are documented model ids. */
const DOCUMENTED_MODEL_IDS: ReadonlySet<string> = new Set(
  DOCUMENTED_OPENAI_IMAGE_MODELS.flatMap(entry => [entry.id, ...entry.snapshots])
)

/**
 * Reads the documented image-input contract for one exact model id. Returns
 * `supported` with the requested id only when the transport targets the official
 * OpenAI endpoint and this module has a verified contract for that id;
 * otherwise `unknown`, so an unproven model is never handed an image.
 */
export function getDocumentedOpenAIImageCapability(
  model: string,
  baseURL: string | undefined
): ImageInputCapability {
  if (!targetsOfficialOpenAiEndpoint(baseURL)) return UNKNOWN
  // Exact membership only: no trimming, no case folding, no prefix family.
  if (!DOCUMENTED_MODEL_IDS.has(model)) return UNKNOWN

  return Object.freeze({
    status: 'supported' as const,
    provider: OPENAI_PROVIDER,
    model,
    evidence: OPENAI_DOCUMENTED_EVIDENCE,
  })
}

/**
 * True only for the resolved official `https://api.openai.com/v1` base. This
 * receives the SDK instance's effective URL, not its optional constructor input.
 * An absent endpoint is therefore unverified. Any other origin, path,
 * scheme, port, or a URL carrying userinfo, query, or fragment is a different
 * deployment whose model contracts this table does not describe.
 */
function targetsOfficialOpenAiEndpoint(baseURL: string | undefined): boolean {
  if (baseURL === undefined) return false

  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    // A relative, empty, or malformed base URL cannot be proven official.
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.search !== '' || url.hash !== '') return false
  if (url.hostname !== 'api.openai.com') return false
  if (url.port !== '' && url.port !== '443') return false
  // One optional trailing slash is equivalent; `//` and every other path are not.
  const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname
  return path === '/v1'
}
