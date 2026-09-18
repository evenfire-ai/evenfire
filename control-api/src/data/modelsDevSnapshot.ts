/**
 * VENDORED offline snapshot of the public models.dev catalog
 * (https://models.dev/api.json, MIT-licensed). GENERATED DATA — do not edit by hand.
 *
 * Trimmed to only the ~22 models.dev provider keys that control-api maps to its
 * providers, and to only the fields discovery consumes
 * ({ id, name?, limit.context?, modalities.input? }).
 * Used by services/modelsDevClient.ts as the offline fallback when the LIVE fetch
 * of api.json fails, so catalog sync always has data. Regenerate with:
 *
 *   cd control-api && npm run build && node scripts/regenerate-models-dev-snapshot.mjs
 *
 * Shape mirrors the normalized catalog: providerKey -> { name?, models: id -> entry }.
 */
import type { RawModelsDevCatalog } from '../services/modelsDevClient.js'

/**
 * When this snapshot's data was captured from the public catalog — the instant
 * the regeneration script read api.json, NOT the time it is loaded. The script
 * writes it; never edit it by hand.
 *
 * Catalog evidence must never be rejuvenated by re-reading an old file (a
 * vendored fallback is a static offline copy, not a fresh observation).
 */
export const VENDORED_MODELS_DEV_SNAPSHOT_CAPTURED_AT = '2026-09-18T09:45:53.791Z'

export const VENDORED_MODELS_DEV_SNAPSHOT: RawModelsDevCatalog = {
  openai: {
    name: 'OpenAI',
    models: {
      'gpt-5-nano': {
        id: 'gpt-5-nano',
        name: 'GPT-5 Nano',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-4.1-nano': {
        id: 'gpt-4.1-nano',
        name: 'GPT-4.1 nano',
        limit: {
          context: 1047576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-4o-2024-05-13': {
        id: 'gpt-4o-2024-05-13',
        name: 'GPT-4o (2024-05-13)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5-pro': {
        id: 'gpt-5-pro',
        name: 'GPT-5 Pro',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'chatgpt-image-latest': {
        id: 'chatgpt-image-latest',
        name: 'chatgpt-image-latest',
        limit: {
          context: 0,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5.6-sol': {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-4o-2024-08-06': {
        id: 'gpt-4o-2024-08-06',
        name: 'GPT-4o (2024-08-06)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-6-astra': {
        id: 'gpt-6-astra',
        name: 'GPT-6 Astra',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-5.2-pro': {
        id: 'gpt-5.2-pro',
        name: 'GPT-5.2 Pro',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5.3-codex-spark': {
        id: 'gpt-5.3-codex-spark',
        name: 'GPT-5.3 Codex Spark',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-4.1-mini': {
        id: 'gpt-4.1-mini',
        name: 'GPT-4.1 mini',
        limit: {
          context: 1047576,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-5.4': {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-4-turbo': {
        id: 'gpt-4-turbo',
        name: 'GPT-4 Turbo',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5.1': {
        id: 'gpt-5.1',
        name: 'GPT-5.1',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      o1: {
        id: 'o1',
        name: 'o1',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-4o': {
        id: 'gpt-4o',
        name: 'GPT-4o',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-5.6-luna': {
        id: 'gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-5.3-codex': {
        id: 'gpt-5.3-codex',
        name: 'GPT-5.3 Codex',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-4o-mini': {
        id: 'gpt-4o-mini',
        name: 'GPT-4o mini',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-image-1.5': {
        id: 'gpt-image-1.5',
        name: 'gpt-image-1.5',
        limit: {
          context: 0,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'o1-pro': {
        id: 'o1-pro',
        name: 'o1-pro',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-4.1': {
        id: 'gpt-4.1',
        name: 'GPT-4.1',
        limit: {
          context: 1047576,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'text-embedding-ada-002': {
        id: 'text-embedding-ada-002',
        name: 'text-embedding-ada-002',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-image-1': {
        id: 'gpt-image-1',
        name: 'gpt-image-1',
        limit: {
          context: 0,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5.4-nano': {
        id: 'gpt-5.4-nano',
        name: 'GPT-5.4 nano',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5.5-pro': {
        id: 'gpt-5.5-pro',
        name: 'GPT-5.5 Pro',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-image-1-mini': {
        id: 'gpt-image-1-mini',
        name: 'gpt-image-1-mini',
        limit: {
          context: 0,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5.4-mini': {
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 mini',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-image-2': {
        id: 'gpt-image-2',
        name: 'gpt-image-2',
        limit: {
          context: 0,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-3.5-turbo': {
        id: 'gpt-3.5-turbo',
        name: 'GPT-3.5-turbo',
        limit: {
          context: 16385,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-5.6': {
        id: 'gpt-5.6',
        name: 'GPT-5.6',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'text-embedding-3-small': {
        id: 'text-embedding-3-small',
        name: 'text-embedding-3-small',
        limit: {
          context: 8191,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-5-mini': {
        id: 'gpt-5-mini',
        name: 'GPT-5 Mini',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5.4-pro': {
        id: 'gpt-5.4-pro',
        name: 'GPT-5.4 Pro',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'text-embedding-3-large': {
        id: 'text-embedding-3-large',
        name: 'text-embedding-3-large',
        limit: {
          context: 8191,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-5.6-terra': {
        id: 'gpt-5.6-terra',
        name: 'GPT-5.6 Terra',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-4': {
        id: 'gpt-4',
        name: 'GPT-4',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-5.2': {
        id: 'gpt-5.2',
        name: 'GPT-5.2',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5': {
        id: 'gpt-5',
        name: 'GPT-5',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5.2-chat-latest': {
        id: 'gpt-5.2-chat-latest',
        name: 'GPT-5.2 Chat',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'o4-mini': {
        id: 'o4-mini',
        name: 'o4-mini',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-realtime-2.1': {
        id: 'gpt-realtime-2.1',
        name: 'GPT-Realtime-2.1',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'audio', 'image'],
        },
      },
      'o3-mini': {
        id: 'o3-mini',
        name: 'o3-mini',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text'],
        },
      },
      o3: {
        id: 'o3',
        name: 'o3',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'o3-pro': {
        id: 'o3-pro',
        name: 'o3-pro',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5.3-chat-latest': {
        id: 'gpt-5.3-chat-latest',
        name: 'GPT-5.3 Chat (latest)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-4o-2024-11-20': {
        id: 'gpt-4o-2024-11-20',
        name: 'GPT-4o (2024-11-20)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
    },
  },
  anthropic: {
    name: 'Anthropic',
    models: {
      'claude-sonnet-4-6': {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-opus-5': {
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-opus-4-5': {
        id: 'claude-opus-4-5',
        name: 'Claude Opus 4.5 (latest)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-fable-5-1': {
        id: 'claude-fable-5-1',
        name: 'Claude Fable 5.1',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-opus-4-6': {
        id: 'claude-opus-4-6',
        name: 'Claude Opus 4.6',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-sonnet-4-5-20250929': {
        id: 'claude-sonnet-4-5-20250929',
        name: 'Claude Sonnet 4.5',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-opus-4-7': {
        id: 'claude-opus-4-7',
        name: 'Claude Opus 4.7',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-haiku-4-5-20251001': {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-fable-5': {
        id: 'claude-fable-5',
        name: 'Claude Fable 5',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5 (latest)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-sonnet-4-5': {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5 (latest)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-opus-4-8': {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-sonnet-5': {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-opus-4-5-20251101': {
        id: 'claude-opus-4-5-20251101',
        name: 'Claude Opus 4.5',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
    },
  },
  'zai-coding-plan': {
    name: 'Z.AI Coding Plan',
    models: {
      'glm-5.2-highspeed': {
        id: 'glm-5.2-highspeed',
        name: 'GLM-5.2 Highspeed',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'glm-4.7': {
        id: 'glm-4.7',
        name: 'GLM-4.7',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'glm-5.2': {
        id: 'glm-5.2',
        name: 'GLM-5.2',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'glm-5.3-highspeed': {
        id: 'glm-5.3-highspeed',
        name: 'GLM-5.3 Highspeed',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'glm-5.3-flash': {
        id: 'glm-5.3-flash',
        name: 'GLM-5.3-Flash',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'glm-5-turbo': {
        id: 'glm-5-turbo',
        name: 'GLM-5-Turbo',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'glm-5.3': {
        id: 'glm-5.3',
        name: 'GLM-5.3',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
    },
  },
  alibaba: {
    name: 'Alibaba',
    models: {
      'qwen3.7-max': {
        id: 'qwen3.7-max',
        name: 'Qwen3.7 Max',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen2-5-72b-instruct': {
        id: 'qwen2-5-72b-instruct',
        name: 'Qwen2.5 72B Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek-v4-flash-0731': {
        id: 'deepseek-v4-flash-0731',
        name: 'DeepSeek V4 Flash 0731',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen3-coder-plus': {
        id: 'qwen3-coder-plus',
        name: 'Qwen3 Coder Plus',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen3-next-80b-a3b-thinking': {
        id: 'qwen3-next-80b-a3b-thinking',
        name: 'Qwen3-Next 80B-A3B (Thinking)',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen2-5-omni-7b': {
        id: 'qwen2-5-omni-7b',
        name: 'Qwen2.5-Omni 7B',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'video'],
        },
      },
      'qwen-mt-turbo': {
        id: 'qwen-mt-turbo',
        name: 'Qwen-MT Turbo',
        limit: {
          context: 16384,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen-vl-max': {
        id: 'qwen-vl-max',
        name: 'Qwen-VL Max',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'qwen3-next-80b-a3b-instruct': {
        id: 'qwen3-next-80b-a3b-instruct',
        name: 'Qwen3-Next 80B-A3B Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen3-coder-flash': {
        id: 'qwen3-coder-flash',
        name: 'Qwen3 Coder Flash',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen3-14b': {
        id: 'qwen3-14b',
        name: 'Qwen3 14B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen-max': {
        id: 'qwen-max',
        name: 'Qwen Max',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen3.6-plus': {
        id: 'qwen3.6-plus',
        name: 'Qwen3.6 Plus',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen-vl-plus': {
        id: 'qwen-vl-plus',
        name: 'Qwen-VL Plus',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'qwen-omni-turbo-realtime': {
        id: 'qwen-omni-turbo-realtime',
        name: 'Qwen-Omni Turbo Realtime',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text', 'image', 'audio'],
        },
      },
      'qwen3.5-27b': {
        id: 'qwen3.5-27b',
        name: 'Qwen3.5 27B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio'],
        },
      },
      'qwen3.5-35b-a3b': {
        id: 'qwen3.5-35b-a3b',
        name: 'Qwen3.5 35B-A3B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio'],
        },
      },
      'qwen-flash': {
        id: 'qwen-flash',
        name: 'Qwen Flash',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'glm-5.2': {
        id: 'glm-5.2',
        name: 'GLM-5.2',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen-turbo': {
        id: 'qwen-turbo',
        name: 'Qwen Turbo',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen3-livetranslate-flash-realtime': {
        id: 'qwen3-livetranslate-flash-realtime',
        name: 'Qwen3-LiveTranslate Flash Realtime',
        limit: {
          context: 53248,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'video'],
        },
      },
      'qwen3-vl-30b-a3b': {
        id: 'qwen3-vl-30b-a3b',
        name: 'Qwen3-VL 30B-A3B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'qwen-vl-ocr': {
        id: 'qwen-vl-ocr',
        name: 'Qwen-VL OCR',
        limit: {
          context: 34096,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'qwen3-32b': {
        id: 'qwen3-32b',
        name: 'Qwen3 32B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwq-plus': {
        id: 'qwq-plus',
        name: 'QwQ Plus',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen3-vl-plus': {
        id: 'qwen3-vl-plus',
        name: 'Qwen3-VL Plus',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'qwen2-5-7b-instruct': {
        id: 'qwen2-5-7b-instruct',
        name: 'Qwen2.5 7B Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen3-coder-30b-a3b-instruct': {
        id: 'qwen3-coder-30b-a3b-instruct',
        name: 'Qwen3-Coder 30B-A3B Instruct',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen3.5-397b-a17b': {
        id: 'qwen3.5-397b-a17b',
        name: 'Qwen3.5 397B-A17B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio'],
        },
      },
      'qwen3.6-27b': {
        id: 'qwen3.6-27b',
        name: 'Qwen3.6 27B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio'],
        },
      },
      'qwen3-asr-flash': {
        id: 'qwen3-asr-flash',
        name: 'Qwen3-ASR Flash',
        limit: {
          context: 53248,
        },
        modalities: {
          input: ['audio'],
        },
      },
      'qwen3-omni-flash': {
        id: 'qwen3-omni-flash',
        name: 'Qwen3-Omni Flash',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'video'],
        },
      },
      'kimi-k3': {
        id: 'kimi-k3',
        name: 'Kimi K3',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'qwen2-5-vl-72b-instruct': {
        id: 'qwen2-5-vl-72b-instruct',
        name: 'Qwen2.5-VL 72B Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'qwen3.6-35b-a3b': {
        id: 'qwen3.6-35b-a3b',
        name: 'Qwen3.6 35B-A3B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio'],
        },
      },
      'qwen3-max': {
        id: 'qwen3-max',
        name: 'Qwen3 Max',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen-plus': {
        id: 'qwen-plus',
        name: 'Qwen Plus',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen3.5-122b-a10b': {
        id: 'qwen3.5-122b-a10b',
        name: 'Qwen3.5 122B-A10B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio'],
        },
      },
      'qwen3-omni-flash-realtime': {
        id: 'qwen3-omni-flash-realtime',
        name: 'Qwen3-Omni Flash Realtime',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'video'],
        },
      },
      'qwen2-5-vl-7b-instruct': {
        id: 'qwen2-5-vl-7b-instruct',
        name: 'Qwen2.5-VL 7B Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'qwen3.6-flash': {
        id: 'qwen3.6-flash',
        name: 'Qwen3.6 Flash',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen3.8-flash': {
        id: 'qwen3.8-flash',
        name: 'Qwen3.8 Flash',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen2-5-14b-instruct': {
        id: 'qwen2-5-14b-instruct',
        name: 'Qwen2.5 14B Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen3.6-max-preview': {
        id: 'qwen3.6-max-preview',
        name: 'Qwen3.6 Max Preview',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen-plus-character-ja': {
        id: 'qwen-plus-character-ja',
        name: 'Qwen Plus Character (Japanese)',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen3.8-max': {
        id: 'qwen3.8-max',
        name: 'Qwen3.8 Max',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'qwen3-8b': {
        id: 'qwen3-8b',
        name: 'Qwen3 8B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen3-235b-a22b': {
        id: 'qwen3-235b-a22b',
        name: 'Qwen3 235B-A22B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen3.7-plus': {
        id: 'qwen3.7-plus',
        name: 'Qwen3.7 Plus',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen-omni-turbo': {
        id: 'qwen-omni-turbo',
        name: 'Qwen-Omni Turbo',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'video'],
        },
      },
      'qwen3-coder-480b-a35b-instruct': {
        id: 'qwen3-coder-480b-a35b-instruct',
        name: 'Qwen3-Coder 480B-A35B Instruct',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen2-5-32b-instruct': {
        id: 'qwen2-5-32b-instruct',
        name: 'Qwen2.5 32B Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen3-vl-235b-a22b': {
        id: 'qwen3-vl-235b-a22b',
        name: 'Qwen3-VL 235B-A22B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'qwen3.5-plus': {
        id: 'qwen3.5-plus',
        name: 'Qwen3.5 Plus',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen-mt-plus': {
        id: 'qwen-mt-plus',
        name: 'Qwen-MT Plus',
        limit: {
          context: 16384,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qvq-max': {
        id: 'qvq-max',
        name: 'QVQ Max',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
    },
  },
  'google-vertex': {
    name: 'Vertex',
    models: {
      'gemini-2.5-flash-tts': {
        id: 'gemini-2.5-flash-tts',
        name: 'Gemini 2.5 Flash TTS',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gemini-3.1-pro-preview-customtools': {
        id: 'gemini-3.1-pro-preview-customtools',
        name: 'Gemini 3.1 Pro Preview Custom Tools',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'gemini-2.5-pro-tts': {
        id: 'gemini-2.5-pro-tts',
        name: 'Gemini 2.5 Pro TTS',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text'],
        },
      },
      'claude-sonnet-4@20250514': {
        id: 'claude-sonnet-4@20250514',
        name: 'Claude Sonnet 4',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gemini-2.5-flash-image': {
        id: 'gemini-2.5-flash-image',
        name: 'Nano Banana',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'claude-opus-4-5@20251101': {
        id: 'claude-opus-4-5@20251101',
        name: 'Claude Opus 4.5',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gemini-3-pro-image': {
        id: 'gemini-3-pro-image',
        name: 'Nano Banana Pro',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gemini-3.1-pro-preview': {
        id: 'gemini-3.1-pro-preview',
        name: 'Gemini 3.1 Pro Preview',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'gemini-2.5-flash-lite': {
        id: 'gemini-2.5-flash-lite',
        name: 'Gemini 2.5 Flash-Lite',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'video', 'pdf'],
        },
      },
      'claude-sonnet-4-6@default': {
        id: 'claude-sonnet-4-6@default',
        name: 'Claude Sonnet 4.6',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gemini-3.6-flash': {
        id: 'gemini-3.6-flash',
        name: 'Gemini 3.6 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'claude-fable-5@default': {
        id: 'claude-fable-5@default',
        name: 'Claude Fable 5',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gemini-3.1-flash-lite': {
        id: 'gemini-3.1-flash-lite',
        name: 'Gemini 3.1 Flash Lite',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'claude-opus-4-6@default': {
        id: 'claude-opus-4-6@default',
        name: 'Claude Opus 4.6',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-opus-4@20250514': {
        id: 'claude-opus-4@20250514',
        name: 'Claude Opus 4',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-haiku-4-5@20251001': {
        id: 'claude-haiku-4-5@20251001',
        name: 'Claude Haiku 4.5',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-sonnet-5@default': {
        id: 'claude-sonnet-5@default',
        name: 'Claude Sonnet 5',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gemini-3.5-flash': {
        id: 'gemini-3.5-flash',
        name: 'Gemini 3.5 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'gemini-3.1-flash-lite-preview': {
        id: 'gemini-3.1-flash-lite-preview',
        name: 'Gemini 3.1 Flash Lite Preview',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'claude-opus-4-1@20250805': {
        id: 'claude-opus-4-1@20250805',
        name: 'Claude Opus 4.1',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gemini-embedding-001': {
        id: 'gemini-embedding-001',
        name: 'Gemini Embedding 001',
        limit: {
          context: 2048,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gemini-3.1-flash-image': {
        id: 'gemini-3.1-flash-image',
        name: 'Nano Banana 2',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'gemini-3.5-flash-lite': {
        id: 'gemini-3.5-flash-lite',
        name: 'Gemini 3.5 Flash Lite',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'claude-fable-5-1@default': {
        id: 'claude-fable-5-1@default',
        name: 'Claude Fable 5.1',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-opus-4-7@default': {
        id: 'claude-opus-4-7@default',
        name: 'Claude Opus 4.7',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gemini-flash-lite-latest': {
        id: 'gemini-flash-lite-latest',
        name: 'Gemini Flash-Lite Latest',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'claude-opus-5@default': {
        id: 'claude-opus-5@default',
        name: 'Claude Opus 5',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gemini-3-flash-preview': {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash Preview',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'gemini-3.8-flash': {
        id: 'gemini-3.8-flash',
        name: 'Gemini 3.8 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'gemini-3.7-flash': {
        id: 'gemini-3.7-flash',
        name: 'Gemini 3.7 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'gemini-2.5-pro': {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'video', 'pdf'],
        },
      },
      'gemini-flash-latest': {
        id: 'gemini-flash-latest',
        name: 'Gemini Flash Latest',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'gemini-2.5-flash': {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'video', 'pdf'],
        },
      },
      'claude-opus-4-8@default': {
        id: 'claude-opus-4-8@default',
        name: 'Claude Opus 4.8',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-sonnet-4-5@20250929': {
        id: 'claude-sonnet-4-5@20250929',
        name: 'Claude Sonnet 4.5',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'qwen/qwen3-235b-a22b-instruct-2507-maas': {
        id: 'qwen/qwen3-235b-a22b-instruct-2507-maas',
        name: 'Qwen3 235B A22B Instruct',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek-ai/deepseek-v3.1-maas': {
        id: 'deepseek-ai/deepseek-v3.1-maas',
        name: 'DeepSeek V3.1',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text', 'pdf'],
        },
      },
      'deepseek-ai/deepseek-v3.2-maas': {
        id: 'deepseek-ai/deepseek-v3.2-maas',
        name: 'DeepSeek V3.2',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text', 'pdf'],
        },
      },
      'zai-org/glm-5.2-maas': {
        id: 'zai-org/glm-5.2-maas',
        name: 'GLM-5.2',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/glm-5-maas': {
        id: 'zai-org/glm-5-maas',
        name: 'GLM-5',
        limit: {
          context: 202752,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/glm-4.7-maas': {
        id: 'zai-org/glm-4.7-maas',
        name: 'GLM-4.7',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'pdf'],
        },
      },
      'meta/llama-4-maverick-17b-128e-instruct-maas': {
        id: 'meta/llama-4-maverick-17b-128e-instruct-maas',
        name: 'Llama 4 Maverick 17B 128E Instruct',
        limit: {
          context: 524288,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'meta/llama-3.3-70b-instruct-maas': {
        id: 'meta/llama-3.3-70b-instruct-maas',
        name: 'Llama 3.3 70B Instruct',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/gpt-oss-120b-maas': {
        id: 'openai/gpt-oss-120b-maas',
        name: 'GPT OSS 120B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/gpt-oss-20b-maas': {
        id: 'openai/gpt-oss-20b-maas',
        name: 'GPT OSS 20B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'moonshotai/kimi-k2-thinking-maas': {
        id: 'moonshotai/kimi-k2-thinking-maas',
        name: 'Kimi K2 Thinking',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'xai/grok-4.20-reasoning': {
        id: 'xai/grok-4.20-reasoning',
        name: 'Grok 4.20 (Reasoning)',
        limit: {
          context: 2000000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'xai/grok-4.3': {
        id: 'xai/grok-4.3',
        name: 'Grok 4.3',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'xai/grok-4.20-non-reasoning': {
        id: 'xai/grok-4.20-non-reasoning',
        name: 'Grok 4.20 (Non-Reasoning)',
        limit: {
          context: 2000000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'xai/grok-4.1-fast-non-reasoning': {
        id: 'xai/grok-4.1-fast-non-reasoning',
        name: 'Grok 4.1 Fast',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'xai/grok-4.1-fast-reasoning': {
        id: 'xai/grok-4.1-fast-reasoning',
        name: 'Grok 4.1 Fast (Reasoning)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'xai/grok-4.6': {
        id: 'xai/grok-4.6',
        name: 'Grok 4.6',
        limit: {
          context: 524288,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
    },
  },
  'amazon-bedrock': {
    name: 'Amazon Bedrock',
    models: {
      'moonshotai.kimi-k2.5': {
        id: 'moonshotai.kimi-k2.5',
        name: 'Kimi K2.5',
        limit: {
          context: 262143,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'global.anthropic.claude-haiku-4-5-20251001-v1:0': {
        id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        name: 'Claude Haiku 4.5 (Global)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'us.anthropic.claude-opus-5': {
        id: 'us.anthropic.claude-opus-5',
        name: 'Claude Opus 5 (US)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'eu.amazon.nova-pro-v1:0': {
        id: 'eu.amazon.nova-pro-v1:0',
        name: 'Nova Pro (EU)',
        limit: {
          context: 300000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'us.writer.palmyra-x4-v1:0': {
        id: 'us.writer.palmyra-x4-v1:0',
        name: 'Palmyra X4 (US)',
        limit: {
          context: 122880,
        },
        modalities: {
          input: ['text'],
        },
      },
      'us.anthropic.claude-opus-4-6-v1': {
        id: 'us.anthropic.claude-opus-4-6-v1',
        name: 'Claude Opus 4.6 (US)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'google.gemma-4-31b': {
        id: 'google.gemma-4-31b',
        name: 'Gemma 4 31B IT',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'us.xai.grok-4.6': {
        id: 'us.xai.grok-4.6',
        name: 'Grok 4.6 (US)',
        limit: {
          context: 500000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'eu.mistral.pixtral-large-2502-v1:0': {
        id: 'eu.mistral.pixtral-large-2502-v1:0',
        name: 'Pixtral Large (25.02) (EU)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'qwen.qwen3-coder-next': {
        id: 'qwen.qwen3-coder-next',
        name: 'Qwen3 Coder Next',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'global.openai.gpt-5.6-luna': {
        id: 'global.openai.gpt-5.6-luna',
        name: 'GPT-5.6 Luna (Global)',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'global.anthropic.claude-opus-4-6-v1': {
        id: 'global.anthropic.claude-opus-4-6-v1',
        name: 'Claude Opus 4.6 (Global)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai.gpt-5.5': {
        id: 'openai.gpt-5.5',
        name: 'GPT-5.5',
        limit: {
          context: 272000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'us-gov.openai.gpt-oss-20b-1:0': {
        id: 'us-gov.openai.gpt-oss-20b-1:0',
        name: 'gpt-oss-20b (GovCloud)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen.qwen3-coder-30b-a3b-v1:0': {
        id: 'qwen.qwen3-coder-30b-a3b-v1:0',
        name: 'Qwen3-Coder 30B-A3B Instruct',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'global.anthropic.claude-sonnet-4-5-20250929-v1:0': {
        id: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
        name: 'Claude Sonnet 4.5 (Global)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'qwen.qwen3-235b-a22b-2507-v1:0': {
        id: 'qwen.qwen3-235b-a22b-2507-v1:0',
        name: 'Qwen3 235B-A22B Instruct 2507',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'mistral.ministral-3-3b-instruct': {
        id: 'mistral.ministral-3-3b-instruct',
        name: 'Ministral 3 3B',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'us-gov.openai.gpt-oss-120b-1:0': {
        id: 'us-gov.openai.gpt-oss-120b-1:0',
        name: 'gpt-oss-120b (GovCloud)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'global.anthropic.claude-sonnet-4-6': {
        id: 'global.anthropic.claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6 (Global)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai.gpt-5.4': {
        id: 'openai.gpt-5.4',
        name: 'GPT-5.4',
        limit: {
          context: 272000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'mistral.pixtral-large-2502-v1:0': {
        id: 'mistral.pixtral-large-2502-v1:0',
        name: 'Pixtral Large (25.02)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'mistral.mistral-large-3-675b-instruct': {
        id: 'mistral.mistral-large-3-675b-instruct',
        name: 'Mistral Large 3',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'anthropic.claude-opus-4-5-20251101-v1:0': {
        id: 'anthropic.claude-opus-4-5-20251101-v1:0',
        name: 'Claude Opus 4.5',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'us.amazon.nova-micro-v1:0': {
        id: 'us.amazon.nova-micro-v1:0',
        name: 'Nova Micro (US)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'jp.anthropic.claude-opus-4-7': {
        id: 'jp.anthropic.claude-opus-4-7',
        name: 'Claude Opus 4.7 (JP)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'eu.anthropic.claude-sonnet-5': {
        id: 'eu.anthropic.claude-sonnet-5',
        name: 'Claude Sonnet 5 (EU)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'apac.amazon.nova-micro-v1:0': {
        id: 'apac.amazon.nova-micro-v1:0',
        name: 'Nova Micro (APAC)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'nvidia.nemotron-nano-9b-v2': {
        id: 'nvidia.nemotron-nano-9b-v2',
        name: 'NVIDIA Nemotron Nano 9B v2',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'au.anthropic.claude-sonnet-4-6': {
        id: 'au.anthropic.claude-sonnet-4-6',
        name: 'AU Anthropic Claude Sonnet 4.6',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'anthropic.claude-opus-4-7': {
        id: 'anthropic.claude-opus-4-7',
        name: 'Claude Opus 4.7',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'mistral.ministral-3-8b-instruct': {
        id: 'mistral.ministral-3-8b-instruct',
        name: 'Ministral 3 8B',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'au.anthropic.claude-sonnet-4-5-20250929-v1:0': {
        id: 'au.anthropic.claude-sonnet-4-5-20250929-v1:0',
        name: 'Claude Sonnet 4.5 (AU)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'us.openai.gpt-5.6-sol': {
        id: 'us.openai.gpt-5.6-sol',
        name: 'GPT-5.6 Sol (US)',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'eu.amazon.nova-lite-v1:0': {
        id: 'eu.amazon.nova-lite-v1:0',
        name: 'Nova Lite (EU)',
        limit: {
          context: 300000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'anthropic.claude-opus-5': {
        id: 'anthropic.claude-opus-5',
        name: 'Claude Opus 5',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'eu.anthropic.claude-opus-4-6-v1': {
        id: 'eu.anthropic.claude-opus-4-6-v1',
        name: 'Claude Opus 4.6 (EU)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'apac.amazon.nova-pro-v1:0': {
        id: 'apac.amazon.nova-pro-v1:0',
        name: 'Nova Pro (APAC)',
        limit: {
          context: 300000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'anthropic.claude-sonnet-4-6': {
        id: 'anthropic.claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'apac.amazon.nova-lite-v1:0': {
        id: 'apac.amazon.nova-lite-v1:0',
        name: 'Nova Lite (APAC)',
        limit: {
          context: 300000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'mistral.voxtral-mini-3b-2507': {
        id: 'mistral.voxtral-mini-3b-2507',
        name: 'Voxtral Mini 3B 2507',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text', 'audio'],
        },
      },
      'google.gemma-4-26b-a4b': {
        id: 'google.gemma-4-26b-a4b',
        name: 'Gemma 4 26B A4B IT',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'nvidia.nemotron-nano-12b-v2': {
        id: 'nvidia.nemotron-nano-12b-v2',
        name: 'NVIDIA Nemotron Nano 12B v2 VL BF16',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'nvidia.nemotron-nano-3-30b': {
        id: 'nvidia.nemotron-nano-3-30b',
        name: 'NVIDIA Nemotron Nano 3 30B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'eu.anthropic.claude-opus-4-5-20251101-v1:0': {
        id: 'eu.anthropic.claude-opus-4-5-20251101-v1:0',
        name: 'Claude Opus 4.5 (EU)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'minimax.minimax-m2.1': {
        id: 'minimax.minimax-m2.1',
        name: 'MiniMax-M2.1',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta.llama3-3-70b-instruct-v1:0': {
        id: 'meta.llama3-3-70b-instruct-v1:0',
        name: 'Llama 3.3 70B Instruct',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek.v3-v1:0': {
        id: 'deepseek.v3-v1:0',
        name: 'DeepSeek-V3.1',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      'eu.anthropic.claude-opus-5': {
        id: 'eu.anthropic.claude-opus-5',
        name: 'Claude Opus 5 (EU)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'anthropic.claude-sonnet-5': {
        id: 'anthropic.claude-sonnet-5',
        name: 'Claude Sonnet 5',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'us.writer.palmyra-x5-v1:0': {
        id: 'us.writer.palmyra-x5-v1:0',
        name: 'Palmyra X5 (US)',
        limit: {
          context: 1040000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'google.gemma-4-e2b': {
        id: 'google.gemma-4-e2b',
        name: 'Gemma 4 E2B IT',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'video'],
        },
      },
      'us.meta.llama4-maverick-17b-instruct-v1:0': {
        id: 'us.meta.llama4-maverick-17b-instruct-v1:0',
        name: 'Llama 4 Maverick 17B Instruct (US)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'meta.llama3-1-8b-instruct-v1:0': {
        id: 'meta.llama3-1-8b-instruct-v1:0',
        name: 'Llama 3.1 8B Instruct',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'minimax.minimax-m2': {
        id: 'minimax.minimax-m2',
        name: 'MiniMax-M2',
        limit: {
          context: 204608,
        },
        modalities: {
          input: ['text'],
        },
      },
      'global.anthropic.claude-opus-5': {
        id: 'global.anthropic.claude-opus-5',
        name: 'Claude Opus 5 (Global)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'eu.anthropic.claude-sonnet-4-20250514-v1:0': {
        id: 'eu.anthropic.claude-sonnet-4-20250514-v1:0',
        name: 'Claude Sonnet 4 (EU)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'qwen.qwen3-32b-v1:0': {
        id: 'qwen.qwen3-32b-v1:0',
        name: 'Qwen3 32B',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text'],
        },
      },
      'writer.palmyra-x4-v1:0': {
        id: 'writer.palmyra-x4-v1:0',
        name: 'Palmyra X4',
        limit: {
          context: 122880,
        },
        modalities: {
          input: ['text'],
        },
      },
      'us.amazon.nova-pro-v1:0': {
        id: 'us.amazon.nova-pro-v1:0',
        name: 'Nova Pro (US)',
        limit: {
          context: 300000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'google.gemma-3-12b-it': {
        id: 'google.gemma-3-12b-it',
        name: 'Gemma 3 12B IT',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'au.anthropic.claude-opus-4-8': {
        id: 'au.anthropic.claude-opus-4-8',
        name: 'Claude Opus 4.8 (AU)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'jp.anthropic.claude-haiku-4-5-20251001-v1:0': {
        id: 'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
        name: 'Claude Haiku 4.5 (JP)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'eu.amazon.nova-2-lite-v1:0': {
        id: 'eu.amazon.nova-2-lite-v1:0',
        name: 'Nova 2 Lite (EU)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'eu.anthropic.claude-opus-4-8': {
        id: 'eu.anthropic.claude-opus-4-8',
        name: 'Claude Opus 4.8 (EU)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'jp.anthropic.claude-opus-5': {
        id: 'jp.anthropic.claude-opus-5',
        name: 'Claude Opus 5 (JP)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'mistral.ministral-3-14b-instruct': {
        id: 'mistral.ministral-3-14b-instruct',
        name: 'Ministral 14B 3.0',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'openai.gpt-oss-safeguard-20b': {
        id: 'openai.gpt-oss-safeguard-20b',
        name: 'GPT OSS Safeguard 20B',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'global.anthropic.claude-sonnet-4-20250514-v1:0': {
        id: 'global.anthropic.claude-sonnet-4-20250514-v1:0',
        name: 'Claude Sonnet 4 (Global)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'global.amazon.nova-2-lite-v1:0': {
        id: 'global.amazon.nova-2-lite-v1:0',
        name: 'Nova 2 Lite (Global)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'eu.amazon.nova-micro-v1:0': {
        id: 'eu.amazon.nova-micro-v1:0',
        name: 'Nova Micro (EU)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai.gpt-5.6-luna': {
        id: 'openai.gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'anthropic.claude-opus-4-6-v1': {
        id: 'anthropic.claude-opus-4-6-v1',
        name: 'Claude Opus 4.6',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai.gpt-oss-20b-1:0': {
        id: 'openai.gpt-oss-20b-1:0',
        name: 'gpt-oss-20b',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'us.amazon.nova-premier-v1:0': {
        id: 'us.amazon.nova-premier-v1:0',
        name: 'Nova Premier (US)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'qwen.qwen3-vl-235b-a22b': {
        id: 'qwen.qwen3-vl-235b-a22b',
        name: 'Qwen3 VL 235B A22B Instruct',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'amazon.nova-2-lite-v1:0': {
        id: 'amazon.nova-2-lite-v1:0',
        name: 'Nova 2 Lite',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'global.xai.grok-4.6': {
        id: 'global.xai.grok-4.6',
        name: 'Grok 4.6 (Global)',
        limit: {
          context: 500000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'global.anthropic.claude-opus-4-5-20251101-v1:0': {
        id: 'global.anthropic.claude-opus-4-5-20251101-v1:0',
        name: 'Claude Opus 4.5 (Global)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'amazon.nova-lite-v1:0': {
        id: 'amazon.nova-lite-v1:0',
        name: 'Nova Lite',
        limit: {
          context: 300000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'anthropic.claude-opus-4-8': {
        id: 'anthropic.claude-opus-4-8',
        name: 'Claude Opus 4.8',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'us.amazon.nova-2-lite-v1:0': {
        id: 'us.amazon.nova-2-lite-v1:0',
        name: 'Nova 2 Lite (US)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'us.openai.gpt-5.6-terra': {
        id: 'us.openai.gpt-5.6-terra',
        name: 'GPT-5.6 Terra (US)',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'us.meta.llama3-3-70b-instruct-v1:0': {
        id: 'us.meta.llama3-3-70b-instruct-v1:0',
        name: 'Llama 3.3 70B Instruct (US)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'us.meta.llama3-1-70b-instruct-v1:0': {
        id: 'us.meta.llama3-1-70b-instruct-v1:0',
        name: 'Llama 3.1 70B Instruct (US)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'amazon.nova-pro-v1:0': {
        id: 'amazon.nova-pro-v1:0',
        name: 'Nova Pro',
        limit: {
          context: 300000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'us.anthropic.claude-opus-4-7': {
        id: 'us.anthropic.claude-opus-4-7',
        name: 'Claude Opus 4.7 (US)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'au.anthropic.claude-opus-4-6-v1': {
        id: 'au.anthropic.claude-opus-4-6-v1',
        name: 'AU Anthropic Claude Opus 4.6',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'writer.palmyra-x5-v1:0': {
        id: 'writer.palmyra-x5-v1:0',
        name: 'Palmyra X5',
        limit: {
          context: 1040000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'global.openai.gpt-5.6-sol': {
        id: 'global.openai.gpt-5.6-sol',
        name: 'GPT-5.6 Sol (Global)',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'openai.gpt-5.6-sol': {
        id: 'openai.gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'global.anthropic.claude-opus-4-8': {
        id: 'global.anthropic.claude-opus-4-8',
        name: 'Claude Opus 4.8 (Global)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'minimax.minimax-m2.5': {
        id: 'minimax.minimax-m2.5',
        name: 'MiniMax-M2.5',
        limit: {
          context: 196608,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai.gpt-oss-120b-1:0': {
        id: 'openai.gpt-oss-120b-1:0',
        name: 'gpt-oss-120b',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'eu.anthropic.claude-opus-4-7': {
        id: 'eu.anthropic.claude-opus-4-7',
        name: 'Claude Opus 4.7 (EU)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'us.meta.llama4-scout-17b-instruct-v1:0': {
        id: 'us.meta.llama4-scout-17b-instruct-v1:0',
        name: 'Llama 4 Scout 17B Instruct (US)',
        limit: {
          context: 10000000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'us.openai.gpt-5.6-luna': {
        id: 'us.openai.gpt-5.6-luna',
        name: 'GPT-5.6 Luna (US)',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'us.anthropic.claude-sonnet-4-20250514-v1:0': {
        id: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
        name: 'Claude Sonnet 4 (US)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'moonshot.kimi-k2-thinking': {
        id: 'moonshot.kimi-k2-thinking',
        name: 'Kimi K2 Thinking',
        limit: {
          context: 262143,
        },
        modalities: {
          input: ['text'],
        },
      },
      'anthropic.claude-haiku-4-5-20251001-v1:0': {
        id: 'anthropic.claude-haiku-4-5-20251001-v1:0',
        name: 'Claude Haiku 4.5',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'deepseek.r1-v1:0': {
        id: 'deepseek.r1-v1:0',
        name: 'DeepSeek-R1',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'mistral.magistral-small-2509': {
        id: 'mistral.magistral-small-2509',
        name: 'Magistral Small 1.2',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'us.anthropic.claude-fable-5': {
        id: 'us.anthropic.claude-fable-5',
        name: 'Claude Fable 5 (US)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'eu.anthropic.claude-fable-5': {
        id: 'eu.anthropic.claude-fable-5',
        name: 'Claude Fable 5 (EU)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'us.openai.gpt-6-astra': {
        id: 'us.openai.gpt-6-astra',
        name: 'GPT-6 Astra (US)',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'us.anthropic.claude-fable-5-1': {
        id: 'us.anthropic.claude-fable-5-1',
        name: 'Claude Fable 5.1 (US)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'meta.llama4-scout-17b-instruct-v1:0': {
        id: 'meta.llama4-scout-17b-instruct-v1:0',
        name: 'Llama 4 Scout 17B Instruct',
        limit: {
          context: 10000000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'jp.amazon.nova-2-lite-v1:0': {
        id: 'jp.amazon.nova-2-lite-v1:0',
        name: 'Nova 2 Lite (JP)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'google.gemma-3-27b-it': {
        id: 'google.gemma-3-27b-it',
        name: 'Gemma 3 27B IT',
        limit: {
          context: 202752,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'amazon.nova-micro-v1:0': {
        id: 'amazon.nova-micro-v1:0',
        name: 'Nova Micro',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'us.mistral.pixtral-large-2502-v1:0': {
        id: 'us.mistral.pixtral-large-2502-v1:0',
        name: 'Pixtral Large (25.02) (US)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'anthropic.claude-fable-5': {
        id: 'anthropic.claude-fable-5',
        name: 'Claude Fable 5',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'xai.grok-4.6': {
        id: 'xai.grok-4.6',
        name: 'Grok 4.6',
        limit: {
          context: 500000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'global.anthropic.claude-fable-5': {
        id: 'global.anthropic.claude-fable-5',
        name: 'Claude Fable 5 (Global)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'au.anthropic.claude-haiku-4-5-20251001-v1:0': {
        id: 'au.anthropic.claude-haiku-4-5-20251001-v1:0',
        name: 'Claude Haiku 4.5 (AU)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'eu.anthropic.claude-sonnet-4-6': {
        id: 'eu.anthropic.claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6 (EU)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'in.openai.gpt-5.6-terra': {
        id: 'in.openai.gpt-5.6-terra',
        name: 'GPT-5.6 Terra (India)',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'jp.anthropic.claude-opus-4-8': {
        id: 'jp.anthropic.claude-opus-4-8',
        name: 'Claude Opus 4.8 (JP)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'eu.anthropic.claude-haiku-4-5-20251001-v1:0': {
        id: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
        name: 'Claude Haiku 4.5 (EU)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'qwen.qwen3-next-80b-a3b': {
        id: 'qwen.qwen3-next-80b-a3b',
        name: 'Qwen3-Next 80B-A3B Instruct',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'us.anthropic.claude-sonnet-5': {
        id: 'us.anthropic.claude-sonnet-5',
        name: 'Claude Sonnet 5 (US)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'anthropic.claude-sonnet-4-5-20250929-v1:0': {
        id: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
        name: 'Claude Sonnet 4.5',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'us.amazon.nova-lite-v1:0': {
        id: 'us.amazon.nova-lite-v1:0',
        name: 'Nova Lite (US)',
        limit: {
          context: 300000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'global.anthropic.claude-opus-4-7': {
        id: 'global.anthropic.claude-opus-4-7',
        name: 'Claude Opus 4.7 (Global)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'qwen.qwen3-coder-480b-a35b-v1:0': {
        id: 'qwen.qwen3-coder-480b-a35b-v1:0',
        name: 'Qwen3-Coder 480B-A35B Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai.gpt-5.6-terra': {
        id: 'openai.gpt-5.6-terra',
        name: 'GPT-5.6 Terra',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'nvidia.nemotron-super-3-120b': {
        id: 'nvidia.nemotron-super-3-120b',
        name: 'NVIDIA Nemotron 3 Super 120B A12B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai.glm-4.7-flash': {
        id: 'zai.glm-4.7-flash',
        name: 'GLM-4.7-Flash',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'google.gemma-3-4b-it': {
        id: 'google.gemma-3-4b-it',
        name: 'Gemma 3 4B IT',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'global.openai.gpt-5.6-terra': {
        id: 'global.openai.gpt-5.6-terra',
        name: 'GPT-5.6 Terra (Global)',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'zai.glm-5': {
        id: 'zai.glm-5',
        name: 'GLM-5',
        limit: {
          context: 202752,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai.gpt-oss-safeguard-120b': {
        id: 'openai.gpt-oss-safeguard-120b',
        name: 'GPT OSS Safeguard 120B',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'mistral.devstral-2-123b': {
        id: 'mistral.devstral-2-123b',
        name: 'Devstral 2 123B',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai.gpt-6-astra': {
        id: 'openai.gpt-6-astra',
        name: 'GPT-6 Astra',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'us.anthropic.claude-opus-4-1-20250805-v1:0': {
        id: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
        name: 'Claude Opus 4.1 (US)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'us.anthropic.claude-sonnet-4-6': {
        id: 'us.anthropic.claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6 (US)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'mistral.voxtral-small-24b-2507': {
        id: 'mistral.voxtral-small-24b-2507',
        name: 'Voxtral Small 24B 2507',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text', 'audio'],
        },
      },
      'openai.gpt-oss-20b': {
        id: 'openai.gpt-oss-20b',
        name: 'gpt-oss-20b',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta.llama4-maverick-17b-instruct-v1:0': {
        id: 'meta.llama4-maverick-17b-instruct-v1:0',
        name: 'Llama 4 Maverick 17B Instruct',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'zai.glm-4.7': {
        id: 'zai.glm-4.7',
        name: 'GLM-4.7',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'ca.amazon.nova-lite-v1:0': {
        id: 'ca.amazon.nova-lite-v1:0',
        name: 'Nova Lite (CA)',
        limit: {
          context: 300000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'us.anthropic.claude-opus-4-5-20251101-v1:0': {
        id: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
        name: 'Claude Opus 4.5 (US)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'au.anthropic.claude-opus-4-7': {
        id: 'au.anthropic.claude-opus-4-7',
        name: 'Claude Opus 4.7 (AU)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'jp.anthropic.claude-sonnet-4-6': {
        id: 'jp.anthropic.claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6 (JP)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0': {
        id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        name: 'Claude Sonnet 4.5 (US)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'us.deepseek.r1-v1:0': {
        id: 'us.deepseek.r1-v1:0',
        name: 'DeepSeek-R1 (US)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'us.anthropic.claude-opus-4-8': {
        id: 'us.anthropic.claude-opus-4-8',
        name: 'Claude Opus 4.8 (US)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'au.anthropic.claude-opus-5': {
        id: 'au.anthropic.claude-opus-5',
        name: 'Claude Opus 5 (AU)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'anthropic.claude-opus-4-1-20250805-v1:0': {
        id: 'anthropic.claude-opus-4-1-20250805-v1:0',
        name: 'Claude Opus 4.1',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'apac.anthropic.claude-sonnet-4-20250514-v1:0': {
        id: 'apac.anthropic.claude-sonnet-4-20250514-v1:0',
        name: 'Claude Sonnet 4 (APAC)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'jp.anthropic.claude-sonnet-5': {
        id: 'jp.anthropic.claude-sonnet-5',
        name: 'Claude Sonnet 5 (JP)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'au.anthropic.claude-sonnet-5': {
        id: 'au.anthropic.claude-sonnet-5',
        name: 'Claude Sonnet 5 (AU)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'xai.grok-4.3': {
        id: 'xai.grok-4.3',
        name: 'Grok 4.3',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'openai.gpt-oss-120b': {
        id: 'openai.gpt-oss-120b',
        name: 'gpt-oss-120b',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta.llama3-1-70b-instruct-v1:0': {
        id: 'meta.llama3-1-70b-instruct-v1:0',
        name: 'Llama 3.1 70B Instruct',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'global.anthropic.claude-fable-5-1': {
        id: 'global.anthropic.claude-fable-5-1',
        name: 'Claude Fable 5.1 (Global)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'us.anthropic.claude-haiku-4-5-20251001-v1:0': {
        id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        name: 'Claude Haiku 4.5 (US)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'anthropic.claude-fable-5-1': {
        id: 'anthropic.claude-fable-5-1',
        name: 'Claude Fable 5.1',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'global.anthropic.claude-sonnet-5': {
        id: 'global.anthropic.claude-sonnet-5',
        name: 'Claude Sonnet 5 (Global)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'us.meta.llama3-1-8b-instruct-v1:0': {
        id: 'us.meta.llama3-1-8b-instruct-v1:0',
        name: 'Llama 3.1 8B Instruct (US)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'jp.anthropic.claude-sonnet-4-5-20250929-v1:0': {
        id: 'jp.anthropic.claude-sonnet-4-5-20250929-v1:0',
        name: 'Claude Sonnet 4.5 (JP)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'global.openai.gpt-6-astra': {
        id: 'global.openai.gpt-6-astra',
        name: 'GPT-6 Astra (Global)',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'in.openai.gpt-5.6-luna': {
        id: 'in.openai.gpt-5.6-luna',
        name: 'GPT-5.6 Luna (India)',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'eu.anthropic.claude-sonnet-4-5-20250929-v1:0': {
        id: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
        name: 'Claude Sonnet 4.5 (EU)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'deepseek.v3.2': {
        id: 'deepseek.v3.2',
        name: 'DeepSeek V3.2',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
    },
  },
  openrouter: {
    name: 'OpenRouter',
    models: {
      'qwen/qwen3.7-max': {
        id: 'qwen/qwen3.7-max',
        name: 'Qwen3.7 Max',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-coder-plus': {
        id: 'qwen/qwen3-coder-plus',
        name: 'Qwen3 Coder Plus',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-next-80b-a3b-thinking': {
        id: 'qwen/qwen3-next-80b-a3b-thinking',
        name: 'Qwen3-Next 80B-A3B (Thinking)',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-235b-a22b-thinking-2507': {
        id: 'qwen/qwen3-235b-a22b-thinking-2507',
        name: 'Qwen3 235B A22B Thinking 2507',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3.5-9b': {
        id: 'qwen/qwen3.5-9b',
        name: 'Qwen3.5 9B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3-next-80b-a3b-instruct': {
        id: 'qwen/qwen3-next-80b-a3b-instruct',
        name: 'Qwen3-Next 80B-A3B Instruct',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-coder-flash': {
        id: 'qwen/qwen3-coder-flash',
        name: 'Qwen3 Coder Flash',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-14b': {
        id: 'qwen/qwen3-14b',
        name: 'Qwen3 14B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3.6-plus': {
        id: 'qwen/qwen3.6-plus',
        name: 'Qwen3.6 Plus',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3.5-27b': {
        id: 'qwen/qwen3.5-27b',
        name: 'Qwen3.5 27B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3.8-27b': {
        id: 'qwen/qwen3.8-27b',
        name: 'Qwen3.8 27B',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3.5-35b-a3b': {
        id: 'qwen/qwen3.5-35b-a3b',
        name: 'Qwen3.5 35B-A3B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3.5-plus-20260420': {
        id: 'qwen/qwen3.5-plus-20260420',
        name: 'Qwen3.5 Plus 2026-04-20',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3-32b': {
        id: 'qwen/qwen3-32b',
        name: 'Qwen3 32B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3.5-plus-02-15': {
        id: 'qwen/qwen3.5-plus-02-15',
        name: 'Qwen3.5 Plus 2026-02-15',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen-plus-2025-07-28': {
        id: 'qwen/qwen-plus-2025-07-28',
        name: 'Qwen Plus 0728',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-coder': {
        id: 'qwen/qwen3-coder',
        name: 'Qwen3 Coder 480B A35B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen2.5-vl-72b-instruct': {
        id: 'qwen/qwen2.5-vl-72b-instruct',
        name: 'Qwen2.5 VL 72B Instruct',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'qwen/qwen3-coder-next': {
        id: 'qwen/qwen3-coder-next',
        name: 'Qwen3 Coder Next',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-coder-30b-a3b-instruct': {
        id: 'qwen/qwen3-coder-30b-a3b-instruct',
        name: 'Qwen3-Coder 30B-A3B Instruct',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-235b-a22b-2507': {
        id: 'qwen/qwen3-235b-a22b-2507',
        name: 'Qwen3 235B A22B Instruct 2507',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3.5-flash-02-23': {
        id: 'qwen/qwen3.5-flash-02-23',
        name: 'Qwen3.5-Flash',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3.5-397b-a17b': {
        id: 'qwen/qwen3.5-397b-a17b',
        name: 'Qwen3.5 397B-A17B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3-vl-8b-thinking': {
        id: 'qwen/qwen3-vl-8b-thinking',
        name: 'Qwen3 VL 8B Thinking',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['image', 'text'],
        },
      },
      'qwen/qwen3.6-27b': {
        id: 'qwen/qwen3.6-27b',
        name: 'Qwen3.6 27B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3.7-flash': {
        id: 'qwen/qwen3.7-flash',
        name: 'Qwen3.7 Flash',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3-30b-a3b-thinking-2507': {
        id: 'qwen/qwen3-30b-a3b-thinking-2507',
        name: 'Qwen3 30B A3B Thinking 2507',
        limit: {
          context: 81920,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3.6-35b-a3b': {
        id: 'qwen/qwen3.6-35b-a3b',
        name: 'Qwen3.6 35B-A3B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3-max-thinking': {
        id: 'qwen/qwen3-max-thinking',
        name: 'Qwen3 Max Thinking',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3.8-max-0902': {
        id: 'qwen/qwen3.8-max-0902',
        name: 'Qwen3.8 Max 0902',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3-max': {
        id: 'qwen/qwen3-max',
        name: 'Qwen3 Max',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-vl-8b-instruct': {
        id: 'qwen/qwen3-vl-8b-instruct',
        name: 'Qwen3 VL 8B Instruct',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['image', 'text'],
        },
      },
      'qwen/qwen3.8-2.4t-a95b': {
        id: 'qwen/qwen3.8-2.4t-a95b',
        name: 'Qwen3.8 2.4T A95B',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-vl-30b-a3b-instruct': {
        id: 'qwen/qwen3-vl-30b-a3b-instruct',
        name: 'Qwen3 VL 30B A3B Instruct',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'qwen/qwen-plus': {
        id: 'qwen/qwen-plus',
        name: 'Qwen Plus',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3.5-122b-a10b': {
        id: 'qwen/qwen3.5-122b-a10b',
        name: 'Qwen3.5 122B-A10B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3.8-27b:free': {
        id: 'qwen/qwen3.8-27b:free',
        name: 'Qwen3.8 27B (free)',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen-2.5-coder-32b-instruct': {
        id: 'qwen/qwen-2.5-coder-32b-instruct',
        name: 'Qwen2.5 Coder 32B Instruct',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-30b-a3b-instruct-2507': {
        id: 'qwen/qwen3-30b-a3b-instruct-2507',
        name: 'Qwen3 30B A3B Instruct 2507',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3.6-flash': {
        id: 'qwen/qwen3.6-flash',
        name: 'Qwen3.6 Flash',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3-30b-a3b': {
        id: 'qwen/qwen3-30b-a3b',
        name: 'Qwen3 30B A3B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen-2.5-7b-instruct': {
        id: 'qwen/qwen-2.5-7b-instruct',
        name: 'Qwen2.5 7B Instruct',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3.8-flash': {
        id: 'qwen/qwen3.8-flash',
        name: 'Qwen3.8 Flash',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3-vl-30b-a3b-thinking': {
        id: 'qwen/qwen3-vl-30b-a3b-thinking',
        name: 'Qwen3 VL 30B A3B Thinking',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'qwen/qwen3.6-max-preview': {
        id: 'qwen/qwen3.6-max-preview',
        name: 'Qwen3.6 Max Preview',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen-2.5-72b-instruct': {
        id: 'qwen/qwen-2.5-72b-instruct',
        name: 'Qwen2.5 72B Instruct',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-8b': {
        id: 'qwen/qwen3-8b',
        name: 'Qwen3 8B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-235b-a22b': {
        id: 'qwen/qwen3-235b-a22b',
        name: 'Qwen3 235B-A22B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-vl-235b-a22b-thinking': {
        id: 'qwen/qwen3-vl-235b-a22b-thinking',
        name: 'Qwen3 VL 235B A22B Thinking',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'qwen/qwen3-vl-235b-a22b-instruct': {
        id: 'qwen/qwen3-vl-235b-a22b-instruct',
        name: 'Qwen3 VL 235B A22B Instruct',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'qwen/qwen3.7-plus': {
        id: 'qwen/qwen3.7-plus',
        name: 'Qwen3.7 Plus',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'qwen/qwen3-vl-32b-instruct': {
        id: 'qwen/qwen3-vl-32b-instruct',
        name: 'Qwen3 VL 32B Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'baidu/ernie-4.5-vl-424b-a47b': {
        id: 'baidu/ernie-4.5-vl-424b-a47b',
        name: 'ERNIE 4.5 VL 424B A47B ',
        limit: {
          context: 123000,
        },
        modalities: {
          input: ['image', 'text'],
        },
      },
      'unbiased/pareto': {
        id: 'unbiased/pareto',
        name: 'Pareto',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'aion-labs/aion-2.0': {
        id: 'aion-labs/aion-2.0',
        name: 'Aion-2.0',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'aion-labs/aion-rp-llama-3.1-8b': {
        id: 'aion-labs/aion-rp-llama-3.1-8b',
        name: 'Aion-RP 1.0 (8B)',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text'],
        },
      },
      'aion-labs/aion-3.0': {
        id: 'aion-labs/aion-3.0',
        name: 'Aion-3.0',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'aion-labs/aion-3.0-mini': {
        id: 'aion-labs/aion-3.0-mini',
        name: 'Aion-3.0-Mini',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      '~anthropic/claude-fable-latest': {
        id: '~anthropic/claude-fable-latest',
        name: 'Claude Fable Latest',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      '~anthropic/claude-opus-latest': {
        id: '~anthropic/claude-opus-latest',
        name: 'Claude Opus Latest',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      '~anthropic/claude-haiku-latest': {
        id: '~anthropic/claude-haiku-latest',
        name: 'Claude Haiku Latest',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      '~anthropic/claude-sonnet-latest': {
        id: '~anthropic/claude-sonnet-latest',
        name: 'Claude Sonnet Latest',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'morph/morph-v3-large': {
        id: 'morph/morph-v3-large',
        name: 'Morph V3 Large',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'morph/morph-v3-fast': {
        id: 'morph/morph-v3-fast',
        name: 'Morph V3 Fast',
        limit: {
          context: 81920,
        },
        modalities: {
          input: ['text'],
        },
      },
      'undi95/remm-slerp-l2-13b': {
        id: 'undi95/remm-slerp-l2-13b',
        name: 'ReMM SLERP 13B',
        limit: {
          context: 6144,
        },
        modalities: {
          input: ['text'],
        },
      },
      '~deepseek/deepseek-v4-flash-latest': {
        id: '~deepseek/deepseek-v4-flash-latest',
        name: 'DeepSeek V4 Flash Latest',
        limit: {
          context: 1310720,
        },
        modalities: {
          input: ['text'],
        },
      },
      '~deepseek/deepseek-pro-latest': {
        id: '~deepseek/deepseek-pro-latest',
        name: 'DeepSeek Pro Latest',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      '~deepseek/deepseek-flash-latest': {
        id: '~deepseek/deepseek-flash-latest',
        name: 'DeepSeek Flash Latest',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'dots-studio/dots-3-note-preview:free': {
        id: 'dots-studio/dots-3-note-preview:free',
        name: 'Dots3-Note Preview (free)',
        limit: {
          context: 512000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      '~x-ai/grok-latest': {
        id: '~x-ai/grok-latest',
        name: 'Grok Latest',
        limit: {
          context: 500000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'meituan/longcat-2.0': {
        id: 'meituan/longcat-2.0',
        name: 'LongCat 2.0',
        limit: {
          context: 1048756,
        },
        modalities: {
          input: ['text'],
        },
      },
      'poolside/laguna-xs-2.1': {
        id: 'poolside/laguna-xs-2.1',
        name: 'Laguna XS 2.1',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'poolside/laguna-xs-2.1:free': {
        id: 'poolside/laguna-xs-2.1:free',
        name: 'Laguna XS 2.1 (free)',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'poolside/laguna-s-2.1:free': {
        id: 'poolside/laguna-s-2.1:free',
        name: 'Laguna S 2.1 (free)',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'poolside/laguna-s-2.1': {
        id: 'poolside/laguna-s-2.1',
        name: 'Laguna S 2.1',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'kwaipilot/kat-coder-pro-v2': {
        id: 'kwaipilot/kat-coder-pro-v2',
        name: 'KAT-Coder-Pro V2',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'kwaipilot/kat-coder-pro-v2.5': {
        id: 'kwaipilot/kat-coder-pro-v2.5',
        name: 'KAT-Coder-Pro V2.5',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'stepfun/step-3.7-flash': {
        id: 'stepfun/step-3.7-flash',
        name: 'Step 3.7 Flash',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'stepfun/step-3.5-flash': {
        id: 'stepfun/step-3.5-flash',
        name: 'Step 3.5 Flash',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'mistralai/ministral-14b-2512': {
        id: 'mistralai/ministral-14b-2512',
        name: 'Ministral 3 14B 2512',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'mistralai/mistral-large': {
        id: 'mistralai/mistral-large',
        name: 'Mistral Large',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'pdf'],
        },
      },
      'mistralai/codestral-2508': {
        id: 'mistralai/codestral-2508',
        name: 'Codestral 2508',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text', 'pdf'],
        },
      },
      'mistralai/mistral-medium-3-5': {
        id: 'mistralai/mistral-medium-3-5',
        name: 'Mistral Medium 3.5',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'mistralai/devstral-2512': {
        id: 'mistralai/devstral-2512',
        name: 'Devstral 2',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'pdf'],
        },
      },
      'mistralai/mistral-large-2407': {
        id: 'mistralai/mistral-large-2407',
        name: 'Mistral Large 2407',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'pdf'],
        },
      },
      'mistralai/mistral-small-3.2-24b-instruct': {
        id: 'mistralai/mistral-small-3.2-24b-instruct',
        name: 'Mistral Small 3.2 24B',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['image', 'text'],
        },
      },
      'mistralai/mixtral-8x22b-instruct': {
        id: 'mistralai/mixtral-8x22b-instruct',
        name: 'Mixtral 8x22B Instruct',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['text', 'pdf'],
        },
      },
      'mistralai/mistral-saba': {
        id: 'mistralai/mistral-saba',
        name: 'Saba',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text', 'pdf'],
        },
      },
      'mistralai/ministral-3b-2512': {
        id: 'mistralai/ministral-3b-2512',
        name: 'Ministral 3 3B 2512',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'mistralai/mistral-nemo': {
        id: 'mistralai/mistral-nemo',
        name: 'Mistral Nemo',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'mistralai/mistral-medium-3': {
        id: 'mistralai/mistral-medium-3',
        name: 'Mistral Medium 3',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'mistralai/mistral-small-24b-instruct-2501': {
        id: 'mistralai/mistral-small-24b-instruct-2501',
        name: 'Mistral Small 3',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text'],
        },
      },
      'mistralai/mistral-small-3.1-24b-instruct': {
        id: 'mistralai/mistral-small-3.1-24b-instruct',
        name: 'Mistral Small 3.1 24B',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'mistralai/mistral-small-2603': {
        id: 'mistralai/mistral-small-2603',
        name: 'Mistral Small 4',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'mistralai/ministral-8b-2512': {
        id: 'mistralai/ministral-8b-2512',
        name: 'Ministral 3 8B 2512',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'mistralai/voxtral-small-24b-2507': {
        id: 'mistralai/voxtral-small-24b-2507',
        name: 'Voxtral Small 24B 2507',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text', 'audio', 'pdf'],
        },
      },
      'mistralai/mistral-medium-3.1': {
        id: 'mistralai/mistral-medium-3.1',
        name: 'Mistral Medium 3.1',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'xiaomi/mimo-v2.5': {
        id: 'xiaomi/mimo-v2.5',
        name: 'MiMo-V2.5',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'video'],
        },
      },
      'xiaomi/mimo-v2.5-pro': {
        id: 'xiaomi/mimo-v2.5-pro',
        name: 'MiMo-V2.5-Pro',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'minimax/minimax-m2.1': {
        id: 'minimax/minimax-m2.1',
        name: 'MiniMax-M2.1',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'minimax/minimax-m2': {
        id: 'minimax/minimax-m2',
        name: 'MiniMax-M2',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'minimax/minimax-m2.7': {
        id: 'minimax/minimax-m2.7',
        name: 'MiniMax-M2.7',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'minimax/minimax-m2.5': {
        id: 'minimax/minimax-m2.5',
        name: 'MiniMax-M2.5',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'minimax/minimax-m3': {
        id: 'minimax/minimax-m3',
        name: 'MiniMax-M3',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'minimax/minimax-m2-her': {
        id: 'minimax/minimax-m2-her',
        name: 'MiniMax-M2 Her',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['text'],
        },
      },
      'minimax/minimax-m1': {
        id: 'minimax/minimax-m1',
        name: 'MiniMax M1',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'minimax/minimax-01': {
        id: 'minimax/minimax-01',
        name: 'MiniMax-01',
        limit: {
          context: 1000192,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'nvidia/nemotron-3.5-lightning:free': {
        id: 'nvidia/nemotron-3.5-lightning:free',
        name: 'Nemotron 3.5 Lightning (free)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'nvidia/nemotron-3.5-content-safety': {
        id: 'nvidia/nemotron-3.5-content-safety',
        name: 'Nemotron 3.5 Content Safety',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'nvidia/nemotron-3.5-lightning': {
        id: 'nvidia/nemotron-3.5-lightning',
        name: 'Nemotron 3.5 Lightning 30B A3B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': {
        id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
        name: 'Nemotron 3 Nano Omni (free)',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio'],
        },
      },
      'nvidia/nemotron-3-super-120b-a12b': {
        id: 'nvidia/nemotron-3-super-120b-a12b',
        name: 'Nemotron 3 Super 120B A12B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'nvidia/nemotron-3-ultra-550b-a55b:free': {
        id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        name: 'Nemotron 3 Ultra (free)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'nvidia/nemotron-3-super-120b-a12b:free': {
        id: 'nvidia/nemotron-3-super-120b-a12b:free',
        name: 'Nemotron 3 Super (free)',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'nvidia/nemotron-3.5-content-safety:free': {
        id: 'nvidia/nemotron-3.5-content-safety:free',
        name: 'Nemotron 3.5 Content Safety (free)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'nvidia/nemotron-3-ultra-550b-a55b': {
        id: 'nvidia/nemotron-3-ultra-550b-a55b',
        name: 'Nemotron 3 Ultra 550B A55B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'nvidia/nemotron-3-nano-30b-a3b': {
        id: 'nvidia/nemotron-3-nano-30b-a3b',
        name: 'Nemotron 3 Nano 30B A3B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'anthropic/claude-opus-4.8': {
        id: 'anthropic/claude-opus-4.8',
        name: 'Claude Opus 4.8',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'anthropic/claude-opus-4.7': {
        id: 'anthropic/claude-opus-4.7',
        name: 'Claude Opus 4.7',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'anthropic/claude-opus-5': {
        id: 'anthropic/claude-opus-5',
        name: 'Claude Opus 5',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'anthropic/claude-opus-4.1': {
        id: 'anthropic/claude-opus-4.1',
        name: 'Claude Opus 4.1 (latest)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'anthropic/claude-sonnet-4.6': {
        id: 'anthropic/claude-sonnet-4.6',
        name: 'Claude Sonnet 4.6',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'anthropic/claude-3-haiku': {
        id: 'anthropic/claude-3-haiku',
        name: 'Claude 3 Haiku',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'anthropic/claude-haiku-4.5': {
        id: 'anthropic/claude-haiku-4.5',
        name: 'Claude Haiku 4.5 (latest)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'anthropic/claude-opus-4.6': {
        id: 'anthropic/claude-opus-4.6',
        name: 'Claude Opus 4.6',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'anthropic/claude-fable-5': {
        id: 'anthropic/claude-fable-5',
        name: 'Claude Fable 5',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'anthropic/claude-opus-4': {
        id: 'anthropic/claude-opus-4',
        name: 'Claude Opus 4',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['image', 'text', 'pdf'],
        },
      },
      'anthropic/claude-sonnet-4.5': {
        id: 'anthropic/claude-sonnet-4.5',
        name: 'Claude Sonnet 4.5 (latest)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'anthropic/claude-opus-4.5': {
        id: 'anthropic/claude-opus-4.5',
        name: 'Claude Opus 4.5 (latest)',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'anthropic/claude-sonnet-4': {
        id: 'anthropic/claude-sonnet-4',
        name: 'Claude Sonnet 4',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['image', 'text', 'pdf'],
        },
      },
      'anthropic/claude-sonnet-5': {
        id: 'anthropic/claude-sonnet-5',
        name: 'Claude Sonnet 5',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'anthropic/claude-fable-5.1': {
        id: 'anthropic/claude-fable-5.1',
        name: 'Claude Fable 5.1',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'google/gemma-4-26b-a4b-it': {
        id: 'google/gemma-4-26b-a4b-it',
        name: 'Gemma 4 26B A4B IT',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['image', 'text', 'video'],
        },
      },
      'google/gemini-3.1-pro-preview-customtools': {
        id: 'google/gemini-3.1-pro-preview-customtools',
        name: 'Gemini 3.1 Pro Preview Custom Tools',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'google/gemini-3.1-flash-lite-image': {
        id: 'google/gemini-3.1-flash-lite-image',
        name: 'Nano Banana 2 Lite',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'google/gemma-3-4b-it': {
        id: 'google/gemma-3-4b-it',
        name: 'Gemma 3 4B IT',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'google/lyria-3-clip-preview': {
        id: 'google/lyria-3-clip-preview',
        name: 'Lyria 3 Clip Preview',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'google/gemini-2.5-flash-image': {
        id: 'google/gemini-2.5-flash-image',
        name: 'Nano Banana',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'google/gemini-3-pro-image': {
        id: 'google/gemini-3-pro-image',
        name: 'Nano Banana Pro',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'google/gemini-3.1-pro-preview': {
        id: 'google/gemini-3.1-pro-preview',
        name: 'Gemini 3.1 Pro Preview',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'google/gemini-2.5-flash-lite': {
        id: 'google/gemini-2.5-flash-lite',
        name: 'Gemini 2.5 Flash-Lite',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'video', 'pdf'],
        },
      },
      'google/gemini-3.6-flash': {
        id: 'google/gemini-3.6-flash',
        name: 'Gemini 3.6 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'google/gemini-3.1-flash-lite': {
        id: 'google/gemini-3.1-flash-lite',
        name: 'Gemini 3.1 Flash Lite',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'google/gemini-3.5-flash': {
        id: 'google/gemini-3.5-flash',
        name: 'Gemini 3.5 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'google/gemini-3.1-flash-lite-preview': {
        id: 'google/gemini-3.1-flash-lite-preview',
        name: 'Gemini 3.1 Flash Lite Preview',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'google/gemma-3-27b-it': {
        id: 'google/gemma-3-27b-it',
        name: 'Gemma 3 27B IT',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'google/gemini-3.1-flash-image': {
        id: 'google/gemini-3.1-flash-image',
        name: 'Nano Banana 2',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['image', 'text'],
        },
      },
      'google/gemini-3.5-flash-lite': {
        id: 'google/gemini-3.5-flash-lite',
        name: 'Gemini 3.5 Flash Lite',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'google/gemini-2.5-pro-preview': {
        id: 'google/gemini-2.5-pro-preview',
        name: 'Gemini 2.5 Pro Preview 06-05',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['pdf', 'image', 'text', 'audio'],
        },
      },
      'google/gemini-3-pro-image-preview': {
        id: 'google/gemini-3-pro-image-preview',
        name: 'Nano Banana Pro Preview',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'google/gemma-4-31b-it:free': {
        id: 'google/gemma-4-31b-it:free',
        name: 'Gemma 4 31B (free)',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['image', 'text', 'video'],
        },
      },
      'google/gemma-4-31b-it': {
        id: 'google/gemma-4-31b-it',
        name: 'Gemma 4 31B IT',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['image', 'text', 'video'],
        },
      },
      'google/gemini-3-flash-preview': {
        id: 'google/gemini-3-flash-preview',
        name: 'Gemini 3 Flash Preview',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'google/gemini-3.8-flash': {
        id: 'google/gemini-3.8-flash',
        name: 'Gemini 3.8 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'google/lyria-3-pro-preview': {
        id: 'google/lyria-3-pro-preview',
        name: 'Lyria 3 Pro Preview',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'google/gemini-3.7-flash': {
        id: 'google/gemini-3.7-flash',
        name: 'Gemini 3.7 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'google/gemini-2.5-pro': {
        id: 'google/gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'video', 'pdf'],
        },
      },
      'google/gemini-3.1-flash-image-preview': {
        id: 'google/gemini-3.1-flash-image-preview',
        name: 'Nano Banana 2 Preview',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['image', 'text'],
        },
      },
      'google/gemini-2.5-flash': {
        id: 'google/gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'video', 'pdf'],
        },
      },
      'google/gemma-3-12b-it': {
        id: 'google/gemma-3-12b-it',
        name: 'Gemma 3 12B IT',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'google/gemma-4-26b-a4b-it:free': {
        id: 'google/gemma-4-26b-a4b-it:free',
        name: 'Gemma 4 26B A4B  (free)',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['image', 'text', 'video'],
        },
      },
      'google/gemma-2-27b-it': {
        id: 'google/gemma-2-27b-it',
        name: 'Gemma 2 27B',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'relace/relace-apply-3': {
        id: 'relace/relace-apply-3',
        name: 'Relace Apply 3',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'relace/relace-search': {
        id: 'relace/relace-search',
        name: 'Relace Search',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'nex-agi/nex-n2.5-mini:free': {
        id: 'nex-agi/nex-n2.5-mini:free',
        name: 'Nex-N2.5-Mini (free)',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'nex-agi/nex-n2.5-pro:free': {
        id: 'nex-agi/nex-n2.5-pro:free',
        name: 'Nex-N2.5-Pro (free)',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'thinkingmachines/inkling-small': {
        id: 'thinkingmachines/inkling-small',
        name: 'Inkling Small',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'audio'],
        },
      },
      'thinkingmachines/inkling-small:free': {
        id: 'thinkingmachines/inkling-small:free',
        name: 'Inkling Small (free)',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'audio'],
        },
      },
      'thinkingmachines/inkling:free': {
        id: 'thinkingmachines/inkling:free',
        name: 'Inkling (free)',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'audio'],
        },
      },
      'thinkingmachines/inkling': {
        id: 'thinkingmachines/inkling',
        name: 'Inkling',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'audio'],
        },
      },
      'gryphe/mythomax-l2-13b': {
        id: 'gryphe/mythomax-l2-13b',
        name: 'MythoMax 13B',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta/muse-spark-1.3': {
        id: 'meta/muse-spark-1.3',
        name: 'Muse Spark 1.3',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf', 'audio'],
        },
      },
      'meta/muse-spark-1.2': {
        id: 'meta/muse-spark-1.2',
        name: 'Muse Spark 1.2',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf', 'audio'],
        },
      },
      'meta/muse-spark-1.2-contributor': {
        id: 'meta/muse-spark-1.2-contributor',
        name: 'Muse Spark 1.2 Contributor',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf', 'audio'],
        },
      },
      'meta/muse-spark-1.3-contributor': {
        id: 'meta/muse-spark-1.3-contributor',
        name: 'Muse Spark 1.3 Contributor',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf', 'audio'],
        },
      },
      'meta/muse-spark-1.1': {
        id: 'meta/muse-spark-1.1',
        name: 'Muse Spark 1.1',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf', 'audio'],
        },
      },
      'meta/muse-glimmer-30b': {
        id: 'meta/muse-glimmer-30b',
        name: 'Muse Glimmer 30B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'perceptron/perceptron-mk1': {
        id: 'perceptron/perceptron-mk1',
        name: 'Perceptron Mk1',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'thedrummer/skyfall-36b-v2': {
        id: 'thedrummer/skyfall-36b-v2',
        name: 'Skyfall 36B V2',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text'],
        },
      },
      'thedrummer/unslopnemo-12b': {
        id: 'thedrummer/unslopnemo-12b',
        name: 'UnslopNemo 12B',
        limit: {
          context: 1024000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'thedrummer/cydonia-24b-v4.1': {
        id: 'thedrummer/cydonia-24b-v4.1',
        name: 'Cydonia 24B V4.1',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'bytedance/ui-tars-1.5-7b': {
        id: 'bytedance/ui-tars-1.5-7b',
        name: 'UI-TARS 7B ',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['image', 'text'],
        },
      },
      'bytedance-seed/seed-1.6-flash': {
        id: 'bytedance-seed/seed-1.6-flash',
        name: 'Seed 1.6 Flash',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['image', 'text', 'video'],
        },
      },
      'bytedance-seed/seed-2-1-turbo': {
        id: 'bytedance-seed/seed-2-1-turbo',
        name: 'Seed 2.1 Turbo',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'bytedance-seed/seed-2.0-code': {
        id: 'bytedance-seed/seed-2.0-code',
        name: 'Seed 2.0 Code',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'bytedance-seed/seed-1.6': {
        id: 'bytedance-seed/seed-1.6',
        name: 'Seed 1.6',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['image', 'text', 'video'],
        },
      },
      'bytedance-seed/seed-2.0-mini': {
        id: 'bytedance-seed/seed-2.0-mini',
        name: 'Seed 2.0 Mini',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'bytedance-seed/seed-2.0-lite': {
        id: 'bytedance-seed/seed-2.0-lite',
        name: 'Seed 2.0 Lite',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'inception/mercury-2.5': {
        id: 'inception/mercury-2.5',
        name: 'Mercury 2.5',
        limit: {
          context: 260000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'inception/mercury-2': {
        id: 'inception/mercury-2',
        name: 'Mercury 2',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'writer/palmyra-x5': {
        id: 'writer/palmyra-x5',
        name: 'Palmyra X5',
        limit: {
          context: 1040000,
        },
        modalities: {
          input: ['text'],
        },
      },
      '~google/gemini-pro-latest': {
        id: '~google/gemini-pro-latest',
        name: 'Gemini Pro Latest',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['audio', 'pdf', 'image', 'text', 'video'],
        },
      },
      '~google/gemini-flash-latest': {
        id: '~google/gemini-flash-latest',
        name: 'Gemini Flash Latest',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf', 'audio'],
        },
      },
      'microsoft/phi-4': {
        id: 'microsoft/phi-4',
        name: 'Phi 4',
        limit: {
          context: 16384,
        },
        modalities: {
          input: ['text'],
        },
      },
      'microsoft/wizardlm-2-8x22b': {
        id: 'microsoft/wizardlm-2-8x22b',
        name: 'WizardLM-2 8x22B',
        limit: {
          context: 65535,
        },
        modalities: {
          input: ['text'],
        },
      },
      'sakana/fugu-ultra': {
        id: 'sakana/fugu-ultra',
        name: 'Fugu Ultra',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'sakana/fugu-max': {
        id: 'sakana/fugu-max',
        name: 'Fugu Max',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'sakana/sakana-namazu': {
        id: 'sakana/sakana-namazu',
        name: 'Sakana Namazu',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'sakana/fugu-ultra-v2': {
        id: 'sakana/fugu-ultra-v2',
        name: 'Fugu Ultra v2',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      '~moonshotai/kimi-latest': {
        id: '~moonshotai/kimi-latest',
        name: 'Kimi Latest',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'ibm-granite/granite-4.2-8b': {
        id: 'ibm-granite/granite-4.2-8b',
        name: 'Granite 4.2 8B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'ibm-granite/granite-4.0-h-micro': {
        id: 'ibm-granite/granite-4.0-h-micro',
        name: 'Granite 4.0 Micro',
        limit: {
          context: 131000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-chat-v3.1': {
        id: 'deepseek/deepseek-chat-v3.1',
        name: 'DeepSeek V3.1',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-v4-flash-vision-exp': {
        id: 'deepseek/deepseek-v4-flash-vision-exp',
        name: 'DeepSeek V4 Flash Vision Exp',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'deepseek/deepseek-v4-pro-0813': {
        id: 'deepseek/deepseek-v4-pro-0813',
        name: 'DeepSeek V4 Pro 0813',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-v4-flash-0731': {
        id: 'deepseek/deepseek-v4-flash-0731',
        name: 'DeepSeek V4 Flash 0731',
        limit: {
          context: 1310720,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-v4-flash': {
        id: 'deepseek/deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-v4-flash-0731:free': {
        id: 'deepseek/deepseek-v4-flash-0731:free',
        name: 'DeepSeek V4 Flash 0731 (free)',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-v4.1-flash': {
        id: 'deepseek/deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'deepseek/deepseek-r1': {
        id: 'deepseek/deepseek-r1',
        name: 'DeepSeek-R1',
        limit: {
          context: 64000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-chat': {
        id: 'deepseek/deepseek-chat',
        name: 'DeepSeek Chat',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-r1-0528': {
        id: 'deepseek/deepseek-r1-0528',
        name: 'R1 0528',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-v3.2': {
        id: 'deepseek/deepseek-v3.2',
        name: 'DeepSeek V3.2',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-r1-distill-llama-70b': {
        id: 'deepseek/deepseek-r1-distill-llama-70b',
        name: 'R1 Distill Llama 70B',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-v3.2-exp': {
        id: 'deepseek/deepseek-v3.2-exp',
        name: 'DeepSeek V3.2 Exp',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-v3.1-terminus': {
        id: 'deepseek/deepseek-v3.1-terminus',
        name: 'DeepSeek V3.1 Terminus',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-v4-pro': {
        id: 'deepseek/deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-chat-v3-0324': {
        id: 'deepseek/deepseek-chat-v3-0324',
        name: 'DeepSeek V3 0324',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      '~openai/gpt-terra-latest': {
        id: '~openai/gpt-terra-latest',
        name: 'GPT Terra Latest',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['pdf', 'image', 'text'],
        },
      },
      '~openai/gpt-sol-latest': {
        id: '~openai/gpt-sol-latest',
        name: 'GPT Sol Latest',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['pdf', 'image', 'text'],
        },
      },
      '~openai/gpt-luna-latest': {
        id: '~openai/gpt-luna-latest',
        name: 'GPT Luna Latest',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['pdf', 'image', 'text'],
        },
      },
      '~openai/gpt-astra-latest': {
        id: '~openai/gpt-astra-latest',
        name: 'GPT Astra Latest',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['pdf', 'image', 'text'],
        },
      },
      '~openai/gpt-mini-latest': {
        id: '~openai/gpt-mini-latest',
        name: 'GPT Mini Latest',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['pdf', 'image', 'text'],
        },
      },
      'amazon/nova-2-lite-v1': {
        id: 'amazon/nova-2-lite-v1',
        name: 'Nova 2 Lite',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'amazon/nova-micro-v1': {
        id: 'amazon/nova-micro-v1',
        name: 'Nova Micro 1.0',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'amazon/nova-pro-v1': {
        id: 'amazon/nova-pro-v1',
        name: 'Nova Pro 1.0',
        limit: {
          context: 300000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'amazon/nova-premier-v1': {
        id: 'amazon/nova-premier-v1',
        name: 'Nova Premier 1.0',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'amazon/nova-lite-v1': {
        id: 'amazon/nova-lite-v1',
        name: 'Nova Lite 1.0',
        limit: {
          context: 300000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'inclusionai/ling-3.0-flash': {
        id: 'inclusionai/ling-3.0-flash',
        name: 'Ling 3.0 Flash',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'inclusionai/ling-3.0-flash-fin': {
        id: 'inclusionai/ling-3.0-flash-fin',
        name: 'Ling 3.0 Flash Fin',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'inclusionai/ling-3.0-flash-fin:free': {
        id: 'inclusionai/ling-3.0-flash-fin:free',
        name: 'Ling 3.0 Flash Fin (free)',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'inclusionai/ling-3.0-flash-sante:free': {
        id: 'inclusionai/ling-3.0-flash-sante:free',
        name: 'Ling 3.0 Flash Sante (free)',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'inclusionai/ling-3.0-flash-vl:free': {
        id: 'inclusionai/ling-3.0-flash-vl:free',
        name: 'Ling 3.0 Flash VL (free)',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'inclusionai/ling-3.0-flash-vl': {
        id: 'inclusionai/ling-3.0-flash-vl',
        name: 'Ling 3.0 Flash VL',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'anthracite-org/magnum-v4-72b': {
        id: 'anthracite-org/magnum-v4-72b',
        name: 'Magnum v4 72B',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text'],
        },
      },
      'mancer/weaver': {
        id: 'mancer/weaver',
        name: 'Weaver (alpha)',
        limit: {
          context: 8000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openrouter/free': {
        id: 'openrouter/free',
        name: 'Free Models Router',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'openrouter/pareto-code': {
        id: 'openrouter/pareto-code',
        name: 'Pareto Code Router',
        limit: {
          context: 2000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openrouter/bodybuilder': {
        id: 'openrouter/bodybuilder',
        name: 'Body Builder (beta)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openrouter/fusion': {
        id: 'openrouter/fusion',
        name: 'Fusion',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openrouter/auto': {
        id: 'openrouter/auto',
        name: 'Auto Router',
        limit: {
          context: 2000000,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'pdf', 'video'],
        },
      },
      'sao10k/l3.3-euryale-70b': {
        id: 'sao10k/l3.3-euryale-70b',
        name: 'Llama 3.3 Euryale 70B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'sao10k/l3-lunaris-8b': {
        id: 'sao10k/l3-lunaris-8b',
        name: 'Llama 3 8B Lunaris',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'sao10k/l3.1-euryale-70b': {
        id: 'sao10k/l3.1-euryale-70b',
        name: 'Llama 3.1 Euryale 70B v2.2',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'x-ai/grok-4.20-multi-agent': {
        id: 'x-ai/grok-4.20-multi-agent',
        name: 'Grok 4.20 Multi-Agent',
        limit: {
          context: 2000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'x-ai/grok-4.3': {
        id: 'x-ai/grok-4.3',
        name: 'Grok 4.3',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'x-ai/grok-4.20': {
        id: 'x-ai/grok-4.20',
        name: 'Grok 4.20',
        limit: {
          context: 2000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'x-ai/grok-4.5': {
        id: 'x-ai/grok-4.5',
        name: 'Grok 4.5',
        limit: {
          context: 500000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'x-ai/grok-build-0.1': {
        id: 'x-ai/grok-build-0.1',
        name: 'Grok Build 0.1',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'x-ai/grok-4.6': {
        id: 'x-ai/grok-4.6',
        name: 'Grok 4.6',
        limit: {
          context: 500000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'meta-llama/llama-3.1-8b-instruct': {
        id: 'meta-llama/llama-3.1-8b-instruct',
        name: 'Llama-3.1-8B-Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta-llama/llama-guard-4-12b': {
        id: 'meta-llama/llama-guard-4-12b',
        name: 'Llama Guard 4 12B',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['image', 'text'],
        },
      },
      'meta-llama/llama-3.2-3b-instruct': {
        id: 'meta-llama/llama-3.2-3b-instruct',
        name: 'Llama 3.2 3B Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta-llama/llama-3.2-1b-instruct': {
        id: 'meta-llama/llama-3.2-1b-instruct',
        name: 'Llama 3.2 1B Instruct',
        limit: {
          context: 60000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta-llama/llama-4-maverick': {
        id: 'meta-llama/llama-4-maverick',
        name: 'Llama 4 Maverick',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'meta-llama/llama-4-scout': {
        id: 'meta-llama/llama-4-scout',
        name: 'Llama 4 Scout',
        limit: {
          context: 1310720,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'meta-llama/llama-3.1-70b-instruct': {
        id: 'meta-llama/llama-3.1-70b-instruct',
        name: 'Llama-3.1-70B-Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta-llama/llama-3.3-70b-instruct': {
        id: 'meta-llama/llama-3.3-70b-instruct',
        name: 'Llama-3.3-70B-Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'nousresearch/hermes-3-llama-3.1-70b': {
        id: 'nousresearch/hermes-3-llama-3.1-70b',
        name: 'Hermes 3 70B Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'nousresearch/hermes-3-llama-3.1-405b': {
        id: 'nousresearch/hermes-3-llama-3.1-405b',
        name: 'Hermes 3 405B Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'nousresearch/hermes-4-405b': {
        id: 'nousresearch/hermes-4-405b',
        name: 'Hermes 4 405B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/o4-mini-high': {
        id: 'openai/o4-mini-high',
        name: 'o4 Mini High',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['image', 'text', 'pdf'],
        },
      },
      'openai/gpt-5-nano': {
        id: 'openai/gpt-5-nano',
        name: 'GPT-5 Nano',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-4.1-nano': {
        id: 'openai/gpt-4.1-nano',
        name: 'GPT-4.1 nano',
        limit: {
          context: 1047576,
        },
        modalities: {
          input: ['image', 'text', 'pdf'],
        },
      },
      'openai/gpt-4o-2024-05-13': {
        id: 'openai/gpt-4o-2024-05-13',
        name: 'GPT-4o (2024-05-13)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-5-pro': {
        id: 'openai/gpt-5-pro',
        name: 'GPT-5 Pro',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['image', 'text', 'pdf'],
        },
      },
      'openai/gpt-4o-mini-2024-07-18': {
        id: 'openai/gpt-4o-mini-2024-07-18',
        name: 'GPT-4o-mini (2024-07-18)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/o3-mini-high': {
        id: 'openai/o3-mini-high',
        name: 'o3 Mini High',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'pdf'],
        },
      },
      'openai/gpt-5.1-codex-mini': {
        id: 'openai/gpt-5.1-codex-mini',
        name: 'GPT-5.1 Codex mini',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'openai/gpt-6-astra-pro': {
        id: 'openai/gpt-6-astra-pro',
        name: 'GPT-6 Astra Pro',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['pdf', 'image', 'text'],
        },
      },
      'openai/gpt-audio-mini': {
        id: 'openai/gpt-audio-mini',
        name: 'GPT Audio Mini',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'audio'],
        },
      },
      'openai/gpt-5.1-codex': {
        id: 'openai/gpt-5.1-codex',
        name: 'GPT-5.1 Codex',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'openai/gpt-5.6-sol': {
        id: 'openai/gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-4o-2024-08-06': {
        id: 'openai/gpt-4o-2024-08-06',
        name: 'GPT-4o (2024-08-06)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-5.2-codex': {
        id: 'openai/gpt-5.2-codex',
        name: 'GPT-5.2 Codex',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'openai/gpt-6-astra': {
        id: 'openai/gpt-6-astra',
        name: 'GPT-6 Astra',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-5.2-chat': {
        id: 'openai/gpt-5.2-chat',
        name: 'GPT-5.2 Chat',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['pdf', 'image', 'text'],
        },
      },
      'openai/gpt-5.6-luna-pro': {
        id: 'openai/gpt-5.6-luna-pro',
        name: 'GPT-5.6 Luna Pro',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-5.2-pro': {
        id: 'openai/gpt-5.2-pro',
        name: 'GPT-5.2 Pro',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['image', 'text', 'pdf'],
        },
      },
      'openai/gpt-4.1-mini': {
        id: 'openai/gpt-4.1-mini',
        name: 'GPT-4.1 mini',
        limit: {
          context: 1047576,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-5.4': {
        id: 'openai/gpt-5.4',
        name: 'GPT-5.4',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-oss-20b': {
        id: 'openai/gpt-oss-20b',
        name: 'GPT OSS 20B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/gpt-4-turbo': {
        id: 'openai/gpt-4-turbo',
        name: 'GPT-4 Turbo',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'openai/gpt-5-image': {
        id: 'openai/gpt-5-image',
        name: 'GPT-5 Image',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['image', 'text', 'pdf'],
        },
      },
      'openai/gpt-5.6-sol-pro': {
        id: 'openai/gpt-5.6-sol-pro',
        name: 'GPT-5.6 Sol Pro',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-oss-safeguard-20b': {
        id: 'openai/gpt-oss-safeguard-20b',
        name: 'GPT OSS Safeguard 20B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/gpt-5.1': {
        id: 'openai/gpt-5.1',
        name: 'GPT-5.1',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['image', 'text', 'pdf'],
        },
      },
      'openai/gpt-5.1-codex-max': {
        id: 'openai/gpt-5.1-codex-max',
        name: 'GPT-5.1 Codex Max',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'openai/gpt-5.4-image-2': {
        id: 'openai/gpt-5.4-image-2',
        name: 'GPT-5.4 Image 2',
        limit: {
          context: 272000,
        },
        modalities: {
          input: ['image', 'text', 'pdf'],
        },
      },
      'openai/gpt-3.5-turbo-0613': {
        id: 'openai/gpt-3.5-turbo-0613',
        name: 'GPT-3.5 Turbo (older v0613)',
        limit: {
          context: 4095,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/gpt-audio': {
        id: 'openai/gpt-audio',
        name: 'GPT Audio',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'audio'],
        },
      },
      'openai/o1': {
        id: 'openai/o1',
        name: 'o1',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-4o': {
        id: 'openai/gpt-4o',
        name: 'GPT-4o',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-5.6-luna': {
        id: 'openai/gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-5.3-codex': {
        id: 'openai/gpt-5.3-codex',
        name: 'GPT-5.3 Codex',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-4o-mini': {
        id: 'openai/gpt-4o-mini',
        name: 'GPT-4o mini',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/o1-pro': {
        id: 'openai/o1-pro',
        name: 'o1-pro',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-4.1': {
        id: 'openai/gpt-4.1',
        name: 'GPT-4.1',
        limit: {
          context: 1047576,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-5.4-nano': {
        id: 'openai/gpt-5.4-nano',
        name: 'GPT-5.4 nano',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['pdf', 'image', 'text'],
        },
      },
      'openai/gpt-5.6-terra-pro': {
        id: 'openai/gpt-5.6-terra-pro',
        name: 'GPT-5.6 Terra Pro',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-5.5-pro': {
        id: 'openai/gpt-5.5-pro',
        name: 'GPT-5.5 Pro',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-chat-latest': {
        id: 'openai/gpt-chat-latest',
        name: 'GPT Chat Latest',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-5.4-mini': {
        id: 'openai/gpt-5.4-mini',
        name: 'GPT-5.4 mini',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['pdf', 'image', 'text'],
        },
      },
      'openai/gpt-3.5-turbo-16k': {
        id: 'openai/gpt-3.5-turbo-16k',
        name: 'GPT-3.5 Turbo 16k',
        limit: {
          context: 16385,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/gpt-5-image-mini': {
        id: 'openai/gpt-5-image-mini',
        name: 'GPT-5 Image Mini',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['pdf', 'image', 'text'],
        },
      },
      'openai/gpt-3.5-turbo': {
        id: 'openai/gpt-3.5-turbo',
        name: 'GPT-3.5-turbo',
        limit: {
          context: 16385,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/gpt-5-mini': {
        id: 'openai/gpt-5-mini',
        name: 'GPT-5 Mini',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-oss-120b': {
        id: 'openai/gpt-oss-120b',
        name: 'GPT OSS 120B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/gpt-5.4-pro': {
        id: 'openai/gpt-5.4-pro',
        name: 'GPT-5.4 Pro',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-3.5-turbo-instruct': {
        id: 'openai/gpt-3.5-turbo-instruct',
        name: 'GPT-3.5 Turbo Instruct',
        limit: {
          context: 4095,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/gpt-5.6-terra': {
        id: 'openai/gpt-5.6-terra',
        name: 'GPT-5.6 Terra',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-4': {
        id: 'openai/gpt-4',
        name: 'GPT-4',
        limit: {
          context: 8191,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/gpt-5.2': {
        id: 'openai/gpt-5.2',
        name: 'GPT-5.2',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['pdf', 'image', 'text'],
        },
      },
      'openai/gpt-5': {
        id: 'openai/gpt-5',
        name: 'GPT-5',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/o4-mini': {
        id: 'openai/o4-mini',
        name: 'o4-mini',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['image', 'text', 'pdf'],
        },
      },
      'openai/o3-mini': {
        id: 'openai/o3-mini',
        name: 'o3-mini',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'pdf'],
        },
      },
      'openai/o3': {
        id: 'openai/o3',
        name: 'o3',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/o3-pro': {
        id: 'openai/o3-pro',
        name: 'o3-pro',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'pdf', 'image'],
        },
      },
      'openai/gpt-5.5': {
        id: 'openai/gpt-5.5',
        name: 'GPT-5.5',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'openai/gpt-4o-2024-11-20': {
        id: 'openai/gpt-4o-2024-11-20',
        name: 'GPT-4o (2024-11-20)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      '~z-ai/glm-flash-latest': {
        id: '~z-ai/glm-flash-latest',
        name: 'GLM Flash Latest',
        limit: {
          context: 1310720,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      '~z-ai/glm-latest': {
        id: '~z-ai/glm-latest',
        name: 'GLM Latest',
        limit: {
          context: 1310720,
        },
        modalities: {
          input: ['text'],
        },
      },
      'moonshotai/kimi-k2-0905': {
        id: 'moonshotai/kimi-k2-0905',
        name: 'Kimi K2 0905',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'moonshotai/kimi-k2.6': {
        id: 'moonshotai/kimi-k2.6',
        name: 'Kimi K2.6',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'moonshotai/kimi-k2.7-code': {
        id: 'moonshotai/kimi-k2.7-code',
        name: 'Kimi K2.7 Code',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'moonshotai/kimi-k2-thinking': {
        id: 'moonshotai/kimi-k2-thinking',
        name: 'Kimi K2 Thinking',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'moonshotai/kimi-k3': {
        id: 'moonshotai/kimi-k3',
        name: 'Kimi K3',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'moonshotai/kimi-k2': {
        id: 'moonshotai/kimi-k2',
        name: 'Kimi K2 0711',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'moonshotai/kimi-k2.5': {
        id: 'moonshotai/kimi-k2.5',
        name: 'Kimi K2.5',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'inference-net/schematron-v2-small': {
        id: 'inference-net/schematron-v2-small',
        name: 'Schematron V2 Small',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'inference-net/schematron-v2-turbo': {
        id: 'inference-net/schematron-v2-turbo',
        name: 'Schematron V2 Turbo',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'cohere/north-mini-code:free': {
        id: 'cohere/north-mini-code:free',
        name: 'North Mini Code (free)',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'cohere/command-r-plus-08-2024': {
        id: 'cohere/command-r-plus-08-2024',
        name: 'Command R+',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'cohere/command-a': {
        id: 'cohere/command-a',
        name: 'Command A',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'cohere/command-r7b-12-2024': {
        id: 'cohere/command-r7b-12-2024',
        name: 'Command R7B',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'cohere/command-r-08-2024': {
        id: 'cohere/command-r-08-2024',
        name: 'Command R',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'upstage/solar-pro-3': {
        id: 'upstage/solar-pro-3',
        name: 'Solar Pro 3',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'upstage/solar-pro4': {
        id: 'upstage/solar-pro4',
        name: 'Solar Pro 4',
        limit: {
          context: 524288,
        },
        modalities: {
          input: ['text'],
        },
      },
      'arcee-ai/trinity-large-thinking': {
        id: 'arcee-ai/trinity-large-thinking',
        name: 'Trinity Large Thinking',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'tencent/hy3': {
        id: 'tencent/hy3',
        name: 'Hy3',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'tencent/hy4-preview': {
        id: 'tencent/hy4-preview',
        name: 'Hy4 preview',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'tencent/hy-mt2-30b-a3b': {
        id: 'tencent/hy-mt2-30b-a3b',
        name: 'Hy-MT2-30B-A3B',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'tencent/hy-mt2-7b': {
        id: 'tencent/hy-mt2-7b',
        name: 'Hy-MT2-7B',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'tencent/hy-mt2-1.8b': {
        id: 'tencent/hy-mt2-1.8b',
        name: 'Hy-MT2-1.8B',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'tencent/hy3-preview': {
        id: 'tencent/hy3-preview',
        name: 'Hy3 preview',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'tencent/hunyuan-a13b-instruct': {
        id: 'tencent/hunyuan-a13b-instruct',
        name: 'Hunyuan A13B Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'liquid/lfm-2.5-2.6b:free': {
        id: 'liquid/lfm-2.5-2.6b:free',
        name: 'LFM2.5-2.6B (free)',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['text'],
        },
      },
      'z-ai/glm-4.7': {
        id: 'z-ai/glm-4.7',
        name: 'GLM-4.7',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'z-ai/glm-4.5-air': {
        id: 'z-ai/glm-4.5-air',
        name: 'GLM-4.5-Air',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'z-ai/glm-4.6': {
        id: 'z-ai/glm-4.6',
        name: 'GLM-4.6',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'z-ai/glm-4.6v': {
        id: 'z-ai/glm-4.6v',
        name: 'GLM-4.6V',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'z-ai/glm-5.2': {
        id: 'z-ai/glm-5.2',
        name: 'GLM-5.2',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'z-ai/glm-5.3-flash': {
        id: 'z-ai/glm-5.3-flash',
        name: 'GLM-5.3-Flash',
        limit: {
          context: 1310720,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'z-ai/glm-4.5': {
        id: 'z-ai/glm-4.5',
        name: 'GLM-4.5',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'z-ai/glm-4.5v': {
        id: 'z-ai/glm-4.5v',
        name: 'GLM-4.5V',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'z-ai/glm-5.2:free': {
        id: 'z-ai/glm-5.2:free',
        name: 'GLM 5.2 (free)',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text'],
        },
      },
      'z-ai/glm-5': {
        id: 'z-ai/glm-5',
        name: 'GLM-5',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'z-ai/glm-5.1': {
        id: 'z-ai/glm-5.1',
        name: 'GLM-5.1',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'z-ai/glm-5-turbo': {
        id: 'z-ai/glm-5-turbo',
        name: 'GLM-5-Turbo',
        limit: {
          context: 202752,
        },
        modalities: {
          input: ['text'],
        },
      },
      'z-ai/glm-5.3': {
        id: 'z-ai/glm-5.3',
        name: 'GLM-5.3',
        limit: {
          context: 1310720,
        },
        modalities: {
          input: ['text'],
        },
      },
      'z-ai/glm-5v-turbo': {
        id: 'z-ai/glm-5v-turbo',
        name: 'GLM-5V-Turbo',
        limit: {
          context: 202752,
        },
        modalities: {
          input: ['image', 'text', 'video'],
        },
      },
      'z-ai/glm-4.7-flash': {
        id: 'z-ai/glm-4.7-flash',
        name: 'GLM-4.7-Flash',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'cognitivecomputations/dolphin-mistral-24b-venice-edition': {
        id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition',
        name: 'Uncensored',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'perplexity/sonar-pro-search': {
        id: 'perplexity/sonar-pro-search',
        name: 'Sonar Pro Search',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'perplexity/sonar': {
        id: 'perplexity/sonar',
        name: 'Sonar',
        limit: {
          context: 127072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'perplexity/sonar-reasoning-pro': {
        id: 'perplexity/sonar-reasoning-pro',
        name: 'Sonar Reasoning Pro',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'perplexity/sonar-pro': {
        id: 'perplexity/sonar-pro',
        name: 'Sonar Pro',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'perplexity/sonar-deep-research': {
        id: 'perplexity/sonar-deep-research',
        name: 'Sonar Deep Research',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'rekaai/reka-edge': {
        id: 'rekaai/reka-edge',
        name: 'Reka Edge',
        limit: {
          context: 16384,
        },
        modalities: {
          input: ['image', 'text', 'video'],
        },
      },
      'rekaai/reka-flash-3': {
        id: 'rekaai/reka-flash-3',
        name: 'Reka Flash 3',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['text'],
        },
      },
    },
  },
  google: {
    name: 'Google',
    models: {
      'gemma-4-26b-a4b-it': {
        id: 'gemma-4-26b-a4b-it',
        name: 'Gemma 4 26B A4B IT',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gemini-3.1-pro-preview-customtools': {
        id: 'gemini-3.1-pro-preview-customtools',
        name: 'Gemini 3.1 Pro Preview Custom Tools',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'gemini-3.1-flash-lite-image': {
        id: 'gemini-3.1-flash-lite-image',
        name: 'Nano Banana 2 Lite',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'lyria-3-clip-preview': {
        id: 'lyria-3-clip-preview',
        name: 'Lyria 3 Clip Preview',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gemini-2.5-flash-image': {
        id: 'gemini-2.5-flash-image',
        name: 'Nano Banana',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'deep-research-max-preview-04-2026': {
        id: 'deep-research-max-preview-04-2026',
        name: 'Deep Research Max Preview (Apr-21-2026)',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'gemini-3-pro-image': {
        id: 'gemini-3-pro-image',
        name: 'Nano Banana Pro',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gemini-3.1-pro-preview': {
        id: 'gemini-3.1-pro-preview',
        name: 'Gemini 3.1 Pro Preview',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'deep-research-preview-04-2026': {
        id: 'deep-research-preview-04-2026',
        name: 'Deep Research Preview (Apr-21-2026)',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'gemini-2.5-flash-lite': {
        id: 'gemini-2.5-flash-lite',
        name: 'Gemini 2.5 Flash-Lite',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'video', 'pdf'],
        },
      },
      'gemini-2.5-computer-use-preview-10-2025': {
        id: 'gemini-2.5-computer-use-preview-10-2025',
        name: 'Gemini 2.5 Computer Use Preview 10-2025',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gemini-3.6-flash': {
        id: 'gemini-3.6-flash',
        name: 'Gemini 3.6 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'gemini-3.1-flash-lite': {
        id: 'gemini-3.1-flash-lite',
        name: 'Gemini 3.1 Flash Lite',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'gemini-3.1-flash-live-preview': {
        id: 'gemini-3.1-flash-live-preview',
        name: 'Gemini 3.1 Flash Live Preview',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio'],
        },
      },
      'gemini-2.5-pro-preview-tts': {
        id: 'gemini-2.5-pro-preview-tts',
        name: 'Gemini 2.5 Pro Preview TTS',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gemini-3.5-flash': {
        id: 'gemini-3.5-flash',
        name: 'Gemini 3.5 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'veo-3.1-generate-preview': {
        id: 'veo-3.1-generate-preview',
        name: 'Veo 3.1',
        limit: {
          context: 480,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gemini-3.1-flash-lite-preview': {
        id: 'gemini-3.1-flash-lite-preview',
        name: 'Gemini 3.1 Flash Lite Preview',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'veo-3.1-fast-generate-preview': {
        id: 'veo-3.1-fast-generate-preview',
        name: 'Veo 3.1 fast',
        limit: {
          context: 480,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'gemini-2.5-flash-preview-tts': {
        id: 'gemini-2.5-flash-preview-tts',
        name: 'Gemini 2.5 Flash Preview TTS',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gemini-embedding-001': {
        id: 'gemini-embedding-001',
        name: 'Gemini Embedding 001',
        limit: {
          context: 2048,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gemini-3.1-flash-image': {
        id: 'gemini-3.1-flash-image',
        name: 'Nano Banana 2',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'gemini-3.5-flash-lite': {
        id: 'gemini-3.5-flash-lite',
        name: 'Gemini 3.5 Flash Lite',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'gemini-3-pro-image-preview': {
        id: 'gemini-3-pro-image-preview',
        name: 'Nano Banana Pro',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gemini-3.1-flash-tts-preview': {
        id: 'gemini-3.1-flash-tts-preview',
        name: 'Gemini 3.1 Flash TTS Preview',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'veo-3.1-lite-generate-preview': {
        id: 'veo-3.1-lite-generate-preview',
        name: 'Veo 3.1 lite',
        limit: {
          context: 480,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gemini-flash-lite-latest': {
        id: 'gemini-flash-lite-latest',
        name: 'Gemini Flash-Lite Latest',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'gemma-4-31b-it': {
        id: 'gemma-4-31b-it',
        name: 'Gemma 4 31B IT',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gemini-embedding-2': {
        id: 'gemini-embedding-2',
        name: 'Gemini Embedding 2',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'video', 'pdf'],
        },
      },
      'gemini-3-flash-preview': {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash Preview',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'gemini-3.8-flash': {
        id: 'gemini-3.8-flash',
        name: 'Gemini 3.8 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'gemini-3.5-live-translate-preview': {
        id: 'gemini-3.5-live-translate-preview',
        name: 'Gemini 3.5 Live Translate Preview',
        limit: {
          context: 16384,
        },
        modalities: {
          input: ['audio'],
        },
      },
      'lyria-3-pro-preview': {
        id: 'lyria-3-pro-preview',
        name: 'Lyria 3 Pro Preview',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gemini-3.7-flash': {
        id: 'gemini-3.7-flash',
        name: 'Gemini 3.7 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'gemini-2.5-pro': {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'video', 'pdf'],
        },
      },
      'gemini-flash-latest': {
        id: 'gemini-flash-latest',
        name: 'Gemini Flash Latest',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio', 'pdf'],
        },
      },
      'gemini-3.1-flash-image-preview': {
        id: 'gemini-3.1-flash-image-preview',
        name: 'Nano Banana 2',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gemini-omni-flash-preview': {
        id: 'gemini-omni-flash-preview',
        name: 'Gemini Omni Flash Preview',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'gemini-2.5-flash': {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'video', 'pdf'],
        },
      },
    },
  },
  deepseek: {
    name: 'DeepSeek',
    models: {
      'deepseek-v4-flash-vision-exp': {
        id: 'deepseek-v4-flash-vision-exp',
        name: 'DeepSeek V4 Flash Vision Exp',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'deepseek-v4-pro': {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek-flash': {
        id: 'deepseek-flash',
        name: 'DeepSeek V4.1 Flash',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
    },
  },
  groq: {
    name: 'Groq',
    models: {
      'whisper-large-v3': {
        id: 'whisper-large-v3',
        name: 'Whisper',
        limit: {
          context: 0,
        },
        modalities: {
          input: ['audio'],
        },
      },
      'whisper-large-v3-turbo': {
        id: 'whisper-large-v3-turbo',
        name: 'Whisper Large V3 Turbo',
        limit: {
          context: 0,
        },
        modalities: {
          input: ['audio'],
        },
      },
      'llama-3.1-8b-instant': {
        id: 'llama-3.1-8b-instant',
        name: 'Llama 3.1 8B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'allam-2-7b': {
        id: 'allam-2-7b',
        name: 'ALLaM-2-7b',
        limit: {
          context: 4096,
        },
        modalities: {
          input: ['text'],
        },
      },
      'llama-3.3-70b-versatile': {
        id: 'llama-3.3-70b-versatile',
        name: 'Llama 3.3 70B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3.8-27b': {
        id: 'qwen/qwen3.8-27b',
        name: 'Qwen3.8 27B',
        limit: {
          context: 131042,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'qwen/qwen3.6-27b': {
        id: 'qwen/qwen3.6-27b',
        name: 'Qwen3.6 27B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'groq/compound': {
        id: 'groq/compound',
        name: 'Compound',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'groq/compound-mini': {
        id: 'groq/compound-mini',
        name: 'Compound Mini',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta-llama/llama-prompt-guard-2-86m': {
        id: 'meta-llama/llama-prompt-guard-2-86m',
        name: 'Prompt Guard 2 86M',
        limit: {
          context: 512,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta-llama/llama-prompt-guard-2-22m': {
        id: 'meta-llama/llama-prompt-guard-2-22m',
        name: 'Llama Prompt Guard 2 22M',
        limit: {
          context: 512,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/gpt-oss-20b': {
        id: 'openai/gpt-oss-20b',
        name: 'GPT OSS 20B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/gpt-oss-safeguard-20b': {
        id: 'openai/gpt-oss-safeguard-20b',
        name: 'Safety GPT OSS 20B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/gpt-oss-120b': {
        id: 'openai/gpt-oss-120b',
        name: 'GPT OSS 120B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'canopylabs/orpheus-v1-english': {
        id: 'canopylabs/orpheus-v1-english',
        name: 'Canopy Labs Orpheus V1 English',
        limit: {
          context: 4000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'canopylabs/orpheus-arabic-saudi': {
        id: 'canopylabs/orpheus-arabic-saudi',
        name: 'Canopy Labs Orpheus Arabic Saudi',
        limit: {
          context: 4000,
        },
        modalities: {
          input: ['text'],
        },
      },
    },
  },
  togetherai: {
    name: 'Together AI',
    models: {
      'essentialai/Rnj-1-Instruct': {
        id: 'essentialai/Rnj-1-Instruct',
        name: 'Rnj-1 Instruct',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek-ai/DeepSeek-V3-1': {
        id: 'deepseek-ai/DeepSeek-V3-1',
        name: 'DeepSeek V3.1',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek-ai/DeepSeek-V3': {
        id: 'deepseek-ai/DeepSeek-V3',
        name: 'DeepSeek-V3',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek-ai/DeepSeek-V4-Flash-0731': {
        id: 'deepseek-ai/DeepSeek-V4-Flash-0731',
        name: 'DeepSeek V4 Flash 0731',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek-ai/DeepSeek-V4.1-Flash': {
        id: 'deepseek-ai/DeepSeek-V4.1-Flash',
        name: 'DeepSeek V4.1 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'deepseek-ai/DeepSeek-V4-Pro-0813': {
        id: 'deepseek-ai/DeepSeek-V4-Pro-0813',
        name: 'DeepSeek V4 Pro 0813',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek-ai/DeepSeek-R1': {
        id: 'deepseek-ai/DeepSeek-R1',
        name: 'DeepSeek-R1',
        limit: {
          context: 163839,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek-ai/DeepSeek-V4-Pro': {
        id: 'deepseek-ai/DeepSeek-V4-Pro',
        name: 'DeepSeek V4 Pro',
        limit: {
          context: 512000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'pearl-ai/gemma-4-31b-it': {
        id: 'pearl-ai/gemma-4-31b-it',
        name: 'Pearl AI Gemma 4 31B Instruct',
        limit: {
          context: 32000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'nvidia/nemotron-3-ultra-550b-a55b': {
        id: 'nvidia/nemotron-3-ultra-550b-a55b',
        name: 'Nemotron 3 Ultra 550B A55B',
        limit: {
          context: 512300,
        },
        modalities: {
          input: ['text'],
        },
      },
      'google/gemma-4-31B-it': {
        id: 'google/gemma-4-31B-it',
        name: 'Gemma 4 31B Instruct',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'google/gemma-3n-E4B-it': {
        id: 'google/gemma-3n-E4B-it',
        name: 'Gemma 3N E4B Instruct',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/GLM-5.1': {
        id: 'zai-org/GLM-5.1',
        name: 'GLM-5.1',
        limit: {
          context: 202752,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/GLM-5.3': {
        id: 'zai-org/GLM-5.3',
        name: 'GLM-5.3',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/GLM-5.2': {
        id: 'zai-org/GLM-5.2',
        name: 'GLM-5.2',
        limit: {
          context: 512000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/GLM-5': {
        id: 'zai-org/GLM-5',
        name: 'GLM-5',
        limit: {
          context: 202752,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/GLM-5.3-Flash': {
        id: 'zai-org/GLM-5.3-Flash',
        name: 'GLM-5.3-Flash',
        limit: {
          context: 1048575,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'LiquidAI/LFM2-24B-A2B': {
        id: 'LiquidAI/LFM2-24B-A2B',
        name: 'LFM2-24B-A2B',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text'],
        },
      },
      'thinkingmachines/Inkling': {
        id: 'thinkingmachines/Inkling',
        name: 'Inkling',
        limit: {
          context: 524288,
        },
        modalities: {
          input: ['text', 'image', 'audio'],
        },
      },
      'Qwen/Qwen3.7-Max': {
        id: 'Qwen/Qwen3.7-Max',
        name: 'Qwen3.7 Max',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'Qwen/Qwen3-235B-A22B-Instruct-2507-tput': {
        id: 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput',
        name: 'Qwen3 235B A22B Instruct 2507 FP8',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'Qwen/Qwen3.6-Plus': {
        id: 'Qwen/Qwen3.6-Plus',
        name: 'Qwen3.6 Plus',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'Qwen/Qwen3.5-9B': {
        id: 'Qwen/Qwen3.5-9B',
        name: 'Qwen3.5 9B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'Qwen/Qwen3.5-397B-A17B': {
        id: 'Qwen/Qwen3.5-397B-A17B',
        name: 'Qwen3.5 397B A17B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8': {
        id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8',
        name: 'Qwen3 Coder 480B A35B Instruct',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'Qwen/Qwen2.5-7B-Instruct-Turbo': {
        id: 'Qwen/Qwen2.5-7B-Instruct-Turbo',
        name: 'Qwen 2.5 7B Instruct Turbo',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text'],
        },
      },
      'Qwen/Qwen3-Coder-Next-FP8': {
        id: 'Qwen/Qwen3-Coder-Next-FP8',
        name: 'Qwen3 Coder Next FP8',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepcogito/cogito-v2-1-671b': {
        id: 'deepcogito/cogito-v2-1-671b',
        name: 'Cogito v2.1 671B',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      'MiniMaxAI/MiniMax-M2.5': {
        id: 'MiniMaxAI/MiniMax-M2.5',
        name: 'MiniMax-M2.5',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'MiniMaxAI/MiniMax-M3': {
        id: 'MiniMaxAI/MiniMax-M3',
        name: 'MiniMax-M3',
        limit: {
          context: 524288,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'MiniMaxAI/MiniMax-M2.7': {
        id: 'MiniMaxAI/MiniMax-M2.7',
        name: 'MiniMax-M2.7',
        limit: {
          context: 202752,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta-llama/Llama-3.3-70B-Instruct-Turbo': {
        id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        name: 'Llama 3.3 70B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta-llama/Meta-Llama-3-8B-Instruct-Lite': {
        id: 'meta-llama/Meta-Llama-3-8B-Instruct-Lite',
        name: 'Meta Llama 3 8B Instruct Lite',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/gpt-oss-20b': {
        id: 'openai/gpt-oss-20b',
        name: 'GPT OSS 20B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/gpt-oss-120b': {
        id: 'openai/gpt-oss-120b',
        name: 'GPT OSS 120B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'moonshotai/Kimi-K2.5': {
        id: 'moonshotai/Kimi-K2.5',
        name: 'Kimi K2.5',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'moonshotai/Kimi-K2.7-Code': {
        id: 'moonshotai/Kimi-K2.7-Code',
        name: 'Kimi K2.7 Code',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'moonshotai/Kimi-K2.6': {
        id: 'moonshotai/Kimi-K2.6',
        name: 'Kimi K2.6',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'moonshotai/Kimi-K3': {
        id: 'moonshotai/Kimi-K3',
        name: 'Kimi K3',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
    },
  },
  'fireworks-ai': {
    name: 'Fireworks AI',
    models: {
      'accounts/fireworks/routers/kimi-latest': {
        id: 'accounts/fireworks/routers/kimi-latest',
        name: 'Kimi Latest',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'accounts/fireworks/routers/qwen-max-latest': {
        id: 'accounts/fireworks/routers/qwen-max-latest',
        name: 'Qwen Max Latest (Qwen3.8 Max)',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'accounts/fireworks/routers/kimi-k3-fast': {
        id: 'accounts/fireworks/routers/kimi-k3-fast',
        name: 'Kimi K3 Fast',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'accounts/fireworks/routers/glm-flash-latest': {
        id: 'accounts/fireworks/routers/glm-flash-latest',
        name: 'GLM Flash Latest (GLM 5.3 Flash)',
        limit: {
          context: 1048573,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'accounts/fireworks/routers/minimax-latest': {
        id: 'accounts/fireworks/routers/minimax-latest',
        name: 'MiniMax Latest',
        limit: {
          context: 512000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'accounts/fireworks/routers/glm-fast-latest': {
        id: 'accounts/fireworks/routers/glm-fast-latest',
        name: 'GLM 5.3 Fast (Latest)',
        limit: {
          context: 1048572,
        },
        modalities: {
          input: ['text'],
        },
      },
      'accounts/fireworks/routers/deepseek-pro-latest': {
        id: 'accounts/fireworks/routers/deepseek-pro-latest',
        name: 'DeepSeek Pro Latest',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'accounts/fireworks/routers/glm-5p3-fast': {
        id: 'accounts/fireworks/routers/glm-5p3-fast',
        name: 'GLM 5.3 Fast',
        limit: {
          context: 1048572,
        },
        modalities: {
          input: ['text'],
        },
      },
      'accounts/fireworks/routers/glm-latest': {
        id: 'accounts/fireworks/routers/glm-latest',
        name: 'GLM Latest',
        limit: {
          context: 1048573,
        },
        modalities: {
          input: ['text'],
        },
      },
      'accounts/fireworks/routers/kimi-fast-latest': {
        id: 'accounts/fireworks/routers/kimi-fast-latest',
        name: 'Kimi Fast Latest',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'accounts/fireworks/routers/glm-5p2-fast': {
        id: 'accounts/fireworks/routers/glm-5p2-fast',
        name: 'GLM 5.2 Fast',
        limit: {
          context: 1048575,
        },
        modalities: {
          input: ['text'],
        },
      },
      'accounts/fireworks/routers/deepseek-flash-latest': {
        id: 'accounts/fireworks/routers/deepseek-flash-latest',
        name: 'DeepSeek Flash Latest',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'accounts/fireworks/models/qwen3p7-plus': {
        id: 'accounts/fireworks/models/qwen3p7-plus',
        name: 'Qwen 3.7 Plus',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'accounts/fireworks/models/deepseek-v4-flash-vision-exp': {
        id: 'accounts/fireworks/models/deepseek-v4-flash-vision-exp',
        name: 'DeepSeek V4 Flash Vision Exp',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'accounts/fireworks/models/deepseek-v4-pro-0813': {
        id: 'accounts/fireworks/models/deepseek-v4-pro-0813',
        name: 'DeepSeek V4 Pro 0813',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'accounts/fireworks/models/deepseek-v4-flash-0731': {
        id: 'accounts/fireworks/models/deepseek-v4-flash-0731',
        name: 'DeepSeek V4 Flash 0731',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'accounts/fireworks/models/minimax-m3': {
        id: 'accounts/fireworks/models/minimax-m3',
        name: 'MiniMax-M3',
        limit: {
          context: 512000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'accounts/fireworks/models/deepseek-v4p1-flash': {
        id: 'accounts/fireworks/models/deepseek-v4p1-flash',
        name: 'DeepSeek V4.1 Flash',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'accounts/fireworks/models/kimi-k2p6': {
        id: 'accounts/fireworks/models/kimi-k2p6',
        name: 'Kimi K2.6',
        limit: {
          context: 262000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'accounts/fireworks/models/nemotron-3-ultra-nvfp4': {
        id: 'accounts/fireworks/models/nemotron-3-ultra-nvfp4',
        name: 'Nemotron 3 Ultra 550B A55B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'accounts/fireworks/models/kimi-k3': {
        id: 'accounts/fireworks/models/kimi-k3',
        name: 'Kimi K3',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'accounts/fireworks/models/glm-5p3': {
        id: 'accounts/fireworks/models/glm-5p3',
        name: 'GLM 5.3',
        limit: {
          context: 1048573,
        },
        modalities: {
          input: ['text'],
        },
      },
      'accounts/fireworks/models/kimi-k2p7-code': {
        id: 'accounts/fireworks/models/kimi-k2p7-code',
        name: 'Kimi K2.7 Code',
        limit: {
          context: 262000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'accounts/fireworks/models/glm-5p3-flash': {
        id: 'accounts/fireworks/models/glm-5p3-flash',
        name: 'GLM 5.3 Flash',
        limit: {
          context: 1048573,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'accounts/fireworks/models/minimax-m2p7': {
        id: 'accounts/fireworks/models/minimax-m2p7',
        name: 'MiniMax-M2.7',
        limit: {
          context: 196608,
        },
        modalities: {
          input: ['text'],
        },
      },
      'accounts/fireworks/models/qwen3p8-2p4t-a95b': {
        id: 'accounts/fireworks/models/qwen3p8-2p4t-a95b',
        name: 'Qwen3.8 2.4T A95B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'accounts/fireworks/models/muse-glimmer-30b': {
        id: 'accounts/fireworks/models/muse-glimmer-30b',
        name: 'Muse Glimmer 30B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'accounts/fireworks/models/inkling': {
        id: 'accounts/fireworks/models/inkling',
        name: 'Inkling',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'audio'],
        },
      },
      'accounts/fireworks/models/deepseek-v4-pro': {
        id: 'accounts/fireworks/models/deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'accounts/fireworks/models/gpt-oss-120b': {
        id: 'accounts/fireworks/models/gpt-oss-120b',
        name: 'GPT OSS 120B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'accounts/fireworks/models/glm-5p2': {
        id: 'accounts/fireworks/models/glm-5p2',
        name: 'GLM 5.2',
        limit: {
          context: 1048575,
        },
        modalities: {
          input: ['text'],
        },
      },
      'accounts/fireworks/models/qwen3p8-max': {
        id: 'accounts/fireworks/models/qwen3p8-max',
        name: 'Qwen3.8 Max',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b': {
        id: 'accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b',
        name: 'Nemotron 3.5 Lightning 30B A3B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
    },
  },
  mistral: {
    name: 'Mistral',
    models: {
      'pixtral-12b': {
        id: 'pixtral-12b',
        name: 'Pixtral 12B',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'devstral-small-2507': {
        id: 'devstral-small-2507',
        name: 'Devstral Small',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'mistral-small-2506': {
        id: 'mistral-small-2506',
        name: 'Mistral Small 3.2',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'magistral-small': {
        id: 'magistral-small',
        name: 'Magistral Small',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'devstral-2512': {
        id: 'devstral-2512',
        name: 'Devstral 2',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'mistral-embed': {
        id: 'mistral-embed',
        name: 'Mistral Embed',
        limit: {
          context: 8000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'devstral-small-2505': {
        id: 'devstral-small-2505',
        name: 'Devstral Small 2505',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'labs-devstral-small-2512': {
        id: 'labs-devstral-small-2512',
        name: 'Devstral Small 2',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'magistral-medium-latest': {
        id: 'magistral-medium-latest',
        name: 'Magistral Medium (latest)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-glm-5-3': {
        id: 'zai-glm-5-3',
        name: 'GLM-5.3',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'open-mixtral-8x22b': {
        id: 'open-mixtral-8x22b',
        name: 'Mixtral 8x22B',
        limit: {
          context: 64000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'open-mixtral-8x7b': {
        id: 'open-mixtral-8x7b',
        name: 'Mixtral 8x7B',
        limit: {
          context: 32000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'open-mistral-7b': {
        id: 'open-mistral-7b',
        name: 'Mistral 7B',
        limit: {
          context: 8000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'mistral-medium-latest': {
        id: 'mistral-medium-latest',
        name: 'Mistral Medium (latest)',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'devstral-medium-2507': {
        id: 'devstral-medium-2507',
        name: 'Devstral Medium',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'mistral-medium-2604': {
        id: 'mistral-medium-2604',
        name: 'Mistral Medium 3.5',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'mistral-large-2512': {
        id: 'mistral-large-2512',
        name: 'Mistral Large 3',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'devstral-medium-latest': {
        id: 'devstral-medium-latest',
        name: 'Devstral 2 (latest)',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'voxtral-small-latest': {
        id: 'voxtral-small-latest',
        name: 'Voxtral Small (latest)',
        limit: {
          context: 32000,
        },
        modalities: {
          input: ['text', 'audio'],
        },
      },
      'ministral-8b-latest': {
        id: 'ministral-8b-latest',
        name: 'Ministral 8B (latest)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'mistral-nemo': {
        id: 'mistral-nemo',
        name: 'Mistral Nemo',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'voxtral-mini-tts-latest': {
        id: 'voxtral-mini-tts-latest',
        name: 'Voxtral Mini TTS (latest)',
        limit: {
          context: 0,
        },
        modalities: {
          input: ['text'],
        },
      },
      'mistral-small-latest': {
        id: 'mistral-small-latest',
        name: 'Mistral Small (latest)',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'open-mistral-nemo': {
        id: 'open-mistral-nemo',
        name: 'Open Mistral Nemo',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'mistral-large-latest': {
        id: 'mistral-large-latest',
        name: 'Mistral Large (latest)',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'voxtral-mini-latest': {
        id: 'voxtral-mini-latest',
        name: 'Voxtral Mini (latest)',
        limit: {
          context: 0,
        },
        modalities: {
          input: ['audio'],
        },
      },
      'mistral-large-2411': {
        id: 'mistral-large-2411',
        name: 'Mistral Large 2.1',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'devstral-latest': {
        id: 'devstral-latest',
        name: 'Devstral 2',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-glm-5-2': {
        id: 'zai-glm-5-2',
        name: 'GLM-5.2',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'mistral-small-2603': {
        id: 'mistral-small-2603',
        name: 'Mistral Small 4',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'mistral-medium-2505': {
        id: 'mistral-medium-2505',
        name: 'Mistral Medium 3',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'codestral-latest': {
        id: 'codestral-latest',
        name: 'Codestral (latest)',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'ministral-3b-latest': {
        id: 'ministral-3b-latest',
        name: 'Ministral 3B (latest)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'mistral-medium-2508': {
        id: 'mistral-medium-2508',
        name: 'Mistral Medium 3.1',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'pixtral-large-latest': {
        id: 'pixtral-large-latest',
        name: 'Pixtral Large (latest)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
    },
  },
  xai: {
    name: 'xAI',
    models: {
      'grok-4.3': {
        id: 'grok-4.3',
        name: 'Grok 4.3',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'grok-4.20-0309-reasoning': {
        id: 'grok-4.20-0309-reasoning',
        name: 'Grok 4.20 (Reasoning)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'grok-4.20-multi-agent-0309': {
        id: 'grok-4.20-multi-agent-0309',
        name: 'Grok 4.20 Multi-Agent',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'grok-imagine-image': {
        id: 'grok-imagine-image',
        name: 'Grok Imagine Image',
        limit: {
          context: 16000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'grok-imagine-video': {
        id: 'grok-imagine-video',
        name: 'Grok Imagine Video',
        limit: {
          context: 1024,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'grok-4.5': {
        id: 'grok-4.5',
        name: 'Grok 4.5',
        limit: {
          context: 500000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'grok-build-0.1': {
        id: 'grok-build-0.1',
        name: 'Grok Build 0.1',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'grok-imagine-video-1.5': {
        id: 'grok-imagine-video-1.5',
        name: 'Grok Imagine Video 1.5',
        limit: {
          context: 1024,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'pdf'],
        },
      },
      'grok-4.6': {
        id: 'grok-4.6',
        name: 'Grok 4.6',
        limit: {
          context: 500000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'grok-4.20-0309-non-reasoning': {
        id: 'grok-4.20-0309-non-reasoning',
        name: 'Grok 4.20 (Non-Reasoning)',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
    },
  },
  cerebras: {
    name: 'Cerebras',
    models: {
      'gpt-oss-120b': {
        id: 'gpt-oss-120b',
        name: 'GPT OSS 120B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen-3.8-27b': {
        id: 'qwen-3.8-27b',
        name: 'Qwen3.8 27B',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
    },
  },
  deepinfra: {
    name: 'Deep Infra',
    models: {
      'ByteDance/Seed-2.0-mini': {
        id: 'ByteDance/Seed-2.0-mini',
        name: 'Seed 2.0 Mini',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'ByteDance/Seed-2.0-code': {
        id: 'ByteDance/Seed-2.0-code',
        name: 'Seed 2.0 Code',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'ByteDance/Seed-2.0-pro': {
        id: 'ByteDance/Seed-2.0-pro',
        name: 'Seed 2.0 Pro',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'stepfun-ai/Step-3.7-Flash': {
        id: 'stepfun-ai/Step-3.7-Flash',
        name: 'Step 3.7 Flash',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'deepseek-ai/DeepSeek-V3': {
        id: 'deepseek-ai/DeepSeek-V3',
        name: 'DeepSeek-V3',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek-ai/DeepSeek-V4-Flash': {
        id: 'deepseek-ai/DeepSeek-V4-Flash',
        name: 'DeepSeek V4 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek-ai/DeepSeek-V3-0324': {
        id: 'deepseek-ai/DeepSeek-V3-0324',
        name: 'DeepSeek V3 0324',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp': {
        id: 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp',
        name: 'DeepSeek V4 Flash Vision Exp',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'deepseek-ai/DeepSeek-V4-Flash-0731': {
        id: 'deepseek-ai/DeepSeek-V4-Flash-0731',
        name: 'DeepSeek V4 Flash 0731',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek-ai/DeepSeek-V3.1': {
        id: 'deepseek-ai/DeepSeek-V3.1',
        name: 'DeepSeek-V3.1',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek-ai/DeepSeek-R1-0528': {
        id: 'deepseek-ai/DeepSeek-R1-0528',
        name: 'DeepSeek-R1-0528',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek-ai/DeepSeek-V4.1-Flash': {
        id: 'deepseek-ai/DeepSeek-V4.1-Flash',
        name: 'DeepSeek V4.1 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'deepseek-ai/DeepSeek-V4-Pro-0813': {
        id: 'deepseek-ai/DeepSeek-V4-Pro-0813',
        name: 'DeepSeek V4 Pro 0813',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek-ai/DeepSeek-V3.2': {
        id: 'deepseek-ai/DeepSeek-V3.2',
        name: 'DeepSeek-V3.2',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek-ai/DeepSeek-V4-Pro': {
        id: 'deepseek-ai/DeepSeek-V4-Pro',
        name: 'DeepSeek V4 Pro',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning': {
        id: 'nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning',
        name: 'Nemotron 3 Nano Omni 30B A3B Reasoning',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio'],
        },
      },
      'nvidia/Llama-3.3-Nemotron-Super-49B-v1.5': {
        id: 'nvidia/Llama-3.3-Nemotron-Super-49B-v1.5',
        name: 'Llama 3.3 Nemotron Super 49B v1.5',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'nvidia/Nemotron-3-Nano-30B-A3B': {
        id: 'nvidia/Nemotron-3-Nano-30B-A3B',
        name: 'Nemotron 3 Nano 30B A3B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'google/gemma-3-4b-it': {
        id: 'google/gemma-3-4b-it',
        name: 'Gemma 3 4B IT',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'google/gemma-4-31B-it': {
        id: 'google/gemma-4-31B-it',
        name: 'Gemma 4 31B IT',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'google/gemma-4-E4B-it': {
        id: 'google/gemma-4-E4B-it',
        name: 'Gemma 4 E4B IT',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image', 'audio'],
        },
      },
      'google/gemma-3-27b-it': {
        id: 'google/gemma-3-27b-it',
        name: 'Gemma 3 27B IT',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'google/gemma-4-26B-A4B-it': {
        id: 'google/gemma-4-26B-A4B-it',
        name: 'Gemma 4 26B A4B IT',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'google/gemma-3-12b-it': {
        id: 'google/gemma-3-12b-it',
        name: 'Gemma 3 12B IT',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'zai-org/GLM-5.1': {
        id: 'zai-org/GLM-5.1',
        name: 'GLM-5.1',
        limit: {
          context: 202752,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/GLM-5.3': {
        id: 'zai-org/GLM-5.3',
        name: 'GLM-5.3',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/GLM-5.2': {
        id: 'zai-org/GLM-5.2',
        name: 'GLM-5.2',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/GLM-4.7-Flash': {
        id: 'zai-org/GLM-4.7-Flash',
        name: 'GLM-4.7-Flash',
        limit: {
          context: 202752,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/GLM-4.7': {
        id: 'zai-org/GLM-4.7',
        name: 'GLM-4.7',
        limit: {
          context: 202752,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/GLM-5': {
        id: 'zai-org/GLM-5',
        name: 'GLM-5',
        limit: {
          context: 202752,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/GLM-4.6': {
        id: 'zai-org/GLM-4.6',
        name: 'GLM-4.6',
        limit: {
          context: 202752,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/GLM-5.3-Flash': {
        id: 'zai-org/GLM-5.3-Flash',
        name: 'GLM-5.3-Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'thinkingmachines/Inkling-Small': {
        id: 'thinkingmachines/Inkling-Small',
        name: 'Inkling Small',
        limit: {
          context: 524288,
        },
        modalities: {
          input: ['text', 'image', 'audio'],
        },
      },
      'thinkingmachines/Inkling': {
        id: 'thinkingmachines/Inkling',
        name: 'Inkling',
        limit: {
          context: 524288,
        },
        modalities: {
          input: ['text', 'image', 'audio'],
        },
      },
      'Qwen/Qwen3.7-Max': {
        id: 'Qwen/Qwen3.7-Max',
        name: 'Qwen3.7 Max',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'Qwen/Qwen3.8-27B': {
        id: 'Qwen/Qwen3.8-27B',
        name: 'Qwen3.8 27B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'Qwen/Qwen3.5-27B': {
        id: 'Qwen/Qwen3.5-27B',
        name: 'Qwen3.5 27B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio'],
        },
      },
      'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo': {
        id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo',
        name: 'Qwen3 Coder 480B A35B Instruct Turbo',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'Qwen/Qwen3.8-Max': {
        id: 'Qwen/Qwen3.8-Max',
        name: 'Qwen3.8 Max',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text', 'image', 'video', 'pdf'],
        },
      },
      'Qwen/Qwen3.5-9B': {
        id: 'Qwen/Qwen3.5-9B',
        name: 'Qwen3.5 9B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'Qwen/Qwen3-30B-A3B': {
        id: 'Qwen/Qwen3-30B-A3B',
        name: 'Qwen3 30B A3B',
        limit: {
          context: 40960,
        },
        modalities: {
          input: ['text'],
        },
      },
      'Qwen/Qwen3.5-122B-A10B': {
        id: 'Qwen/Qwen3.5-122B-A10B',
        name: 'Qwen3.5 122B-A10B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio'],
        },
      },
      'Qwen/Qwen3.8-2.4T-A95B': {
        id: 'Qwen/Qwen3.8-2.4T-A95B',
        name: 'Qwen3.8 2.4T A95B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'Qwen/Qwen3-235B-A22B-Instruct-2507': {
        id: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
        name: 'Qwen3 235B-A22B Instruct 2507',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'Qwen/Qwen3.8-Flash': {
        id: 'Qwen/Qwen3.8-Flash',
        name: 'Qwen3.8 Flash',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'Qwen/Qwen3-VL-235B-A22B-Instruct': {
        id: 'Qwen/Qwen3-VL-235B-A22B-Instruct',
        name: 'Qwen3 VL 235B A22B Instruct',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'Qwen/Qwen3-Next-80B-A3B-Instruct': {
        id: 'Qwen/Qwen3-Next-80B-A3B-Instruct',
        name: 'Qwen3-Next 80B-A3B Instruct',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'Qwen/Qwen3.5-397B-A17B': {
        id: 'Qwen/Qwen3.5-397B-A17B',
        name: 'Qwen 3.5 397B A17B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'Qwen/Qwen3.5-35B-A3B': {
        id: 'Qwen/Qwen3.5-35B-A3B',
        name: 'Qwen 3.5 35B A3B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'Qwen/Qwen3-32B': {
        id: 'Qwen/Qwen3-32B',
        name: 'Qwen3 32B',
        limit: {
          context: 40960,
        },
        modalities: {
          input: ['text'],
        },
      },
      'Qwen/Qwen3.6-27B': {
        id: 'Qwen/Qwen3.6-27B',
        name: 'Qwen3.6 27B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video', 'audio'],
        },
      },
      'Qwen/Qwen3.6-35B-A3B': {
        id: 'Qwen/Qwen3.6-35B-A3B',
        name: 'Qwen3.6 35B A3B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'Qwen/Qwen3-Max': {
        id: 'Qwen/Qwen3-Max',
        name: 'Qwen3 Max',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'MiniMaxAI/MiniMax-M2.5': {
        id: 'MiniMaxAI/MiniMax-M2.5',
        name: 'MiniMax M2.5',
        limit: {
          context: 196608,
        },
        modalities: {
          input: ['text'],
        },
      },
      'MiniMaxAI/MiniMax-M3': {
        id: 'MiniMaxAI/MiniMax-M3',
        name: 'MiniMax-M3',
        limit: {
          context: 524288,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'MiniMaxAI/MiniMax-M2.7': {
        id: 'MiniMaxAI/MiniMax-M2.7',
        name: 'MiniMax-M2.7',
        limit: {
          context: 196608,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta-llama/Llama-4-Scout-17B-16E-Instruct': {
        id: 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
        name: 'Llama 4 Scout 17B',
        limit: {
          context: 327680,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'meta-llama/Llama-3.3-70B-Instruct-Turbo': {
        id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        name: 'Llama 3.3 70B Turbo',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8': {
        id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
        name: 'Llama 4 Maverick 17B FP8',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'openai/gpt-oss-20b': {
        id: 'openai/gpt-oss-20b',
        name: 'GPT OSS 20B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/gpt-oss-120b': {
        id: 'openai/gpt-oss-120b',
        name: 'GPT OSS 120B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'moonshotai/Kimi-K2.5': {
        id: 'moonshotai/Kimi-K2.5',
        name: 'Kimi K2.5',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'moonshotai/Kimi-K2.7-Code': {
        id: 'moonshotai/Kimi-K2.7-Code',
        name: 'Kimi K2.7 Code',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'moonshotai/Kimi-K2.6': {
        id: 'moonshotai/Kimi-K2.6',
        name: 'Kimi K2.6',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'moonshotai/Kimi-K3': {
        id: 'moonshotai/Kimi-K3',
        name: 'Kimi K3',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'tencent/Hy3': {
        id: 'tencent/Hy3',
        name: 'Hy3',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'XiaomiMiMo/MiMo-V2.5-Pro': {
        id: 'XiaomiMiMo/MiMo-V2.5-Pro',
        name: 'MiMo-V2.5-Pro',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'audio'],
        },
      },
      'XiaomiMiMo/MiMo-V2.5': {
        id: 'XiaomiMiMo/MiMo-V2.5',
        name: 'MiMo-V2.5',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'audio', 'video'],
        },
      },
    },
  },
  perplexity: {
    name: 'Perplexity',
    models: {
      sonar: {
        id: 'sonar',
        name: 'Sonar',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'sonar-reasoning-pro': {
        id: 'sonar-reasoning-pro',
        name: 'Sonar Reasoning Pro',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'sonar-pro': {
        id: 'sonar-pro',
        name: 'Sonar Pro',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'sonar-deep-research': {
        id: 'sonar-deep-research',
        name: 'Perplexity Sonar Deep Research',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
    },
  },
  moonshotai: {
    name: 'Moonshot AI',
    models: {
      'kimi-k2.7-code-highspeed': {
        id: 'kimi-k2.7-code-highspeed',
        name: 'Kimi K2.7 Code HighSpeed',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'kimi-k2.6': {
        id: 'kimi-k2.6',
        name: 'Kimi K2.6',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'kimi-k2.7-code': {
        id: 'kimi-k2.7-code',
        name: 'Kimi K2.7 Code',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'kimi-k3': {
        id: 'kimi-k3',
        name: 'Kimi K3',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
    },
  },
  nebius: {
    name: 'Nebius Token Factory',
    models: {
      'deepseek-ai/DeepSeek-V4-Flash-0731': {
        id: 'deepseek-ai/DeepSeek-V4-Flash-0731',
        name: 'DeepSeek V4 Flash 0731',
        limit: {
          context: 1024000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek-ai/DeepSeek-V4-Pro': {
        id: 'deepseek-ai/DeepSeek-V4-Pro',
        name: 'DeepSeek V4 Pro',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'nvidia/Nemotron-3_5-Lightning': {
        id: 'nvidia/Nemotron-3_5-Lightning',
        name: 'Nemotron 3.5 Lightning 30B A3B',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'nvidia/Nemotron-3-Ultra-550b-a55b': {
        id: 'nvidia/Nemotron-3-Ultra-550b-a55b',
        name: 'Nemotron 3 Ultra 550B A55B',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'nvidia/nemotron-3-super-120b-a12b': {
        id: 'nvidia/nemotron-3-super-120b-a12b',
        name: 'Nemotron-3-Super-120B-A12B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'google/gemma-3-27b-it': {
        id: 'google/gemma-3-27b-it',
        name: 'Gemma-3-27b-it',
        limit: {
          context: 110000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'zai-org/GLM-5.2': {
        id: 'zai-org/GLM-5.2',
        name: 'GLM-5.2',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/GLM-5.3-Flash': {
        id: 'zai-org/GLM-5.3-Flash',
        name: 'GLM-5.3-Flash',
        limit: {
          context: 1024000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'Qwen/Qwen3-30B-A3B-Instruct-2507': {
        id: 'Qwen/Qwen3-30B-A3B-Instruct-2507',
        name: 'Qwen3-30B-A3B-Instruct-2507',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'Qwen/Qwen3-235B-A22B-Instruct-2507': {
        id: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
        name: 'Qwen3 235B A22B Instruct 2507',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'Qwen/Qwen3.5-397B-A17B': {
        id: 'Qwen/Qwen3.5-397B-A17B',
        name: 'Qwen3.5-397B-A17B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'Qwen/Qwen3-Embedding-8B': {
        id: 'Qwen/Qwen3-Embedding-8B',
        name: 'Qwen3-Embedding-8B',
        limit: {
          context: 40960,
        },
        modalities: {
          input: ['text'],
        },
      },
      'NousResearch/Hermes-4-405B': {
        id: 'NousResearch/Hermes-4-405B',
        name: 'Hermes-4-405B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'MiniMaxAI/MiniMax-M3': {
        id: 'MiniMaxAI/MiniMax-M3',
        name: 'MiniMax-M3',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/gpt-oss-120b': {
        id: 'openai/gpt-oss-120b',
        name: 'gpt-oss-120b',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'moonshotai/Kimi-K2.7-Code': {
        id: 'moonshotai/Kimi-K2.7-Code',
        name: 'Kimi K2.7 Code',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'moonshotai/Kimi-K3': {
        id: 'moonshotai/Kimi-K3',
        name: 'Kimi K3',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
    },
  },
  'novita-ai': {
    name: 'NovitaAI',
    models: {
      'paddlepaddle/paddleocr-vl': {
        id: 'paddlepaddle/paddleocr-vl',
        name: 'PaddleOCR-VL',
        limit: {
          context: 16384,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'qwen/qwen3.7-max': {
        id: 'qwen/qwen3.7-max',
        name: 'Qwen3.7-Max',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-omni-30b-a3b-instruct': {
        id: 'qwen/qwen3-omni-30b-a3b-instruct',
        name: 'Qwen3 Omni 30B A3B Instruct',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['text', 'video', 'audio', 'image'],
        },
      },
      'qwen/qwen3-30b-a3b-fp8': {
        id: 'qwen/qwen3-30b-a3b-fp8',
        name: 'Qwen3 30B A3B',
        limit: {
          context: 40960,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-next-80b-a3b-thinking': {
        id: 'qwen/qwen3-next-80b-a3b-thinking',
        name: 'Qwen3 Next 80B A3B Thinking',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-235b-a22b-thinking-2507': {
        id: 'qwen/qwen3-235b-a22b-thinking-2507',
        name: 'Qwen3 235B A22b Thinking 2507',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-next-80b-a3b-instruct': {
        id: 'qwen/qwen3-next-80b-a3b-instruct',
        name: 'Qwen3 Next 80B A3B Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3.5-27b': {
        id: 'qwen/qwen3.5-27b',
        name: 'Qwen3.5-27B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3.5-35b-a3b': {
        id: 'qwen/qwen3.5-35b-a3b',
        name: 'Qwen3.5-35B-A3B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3-235b-a22b-fp8': {
        id: 'qwen/qwen3-235b-a22b-fp8',
        name: 'Qwen3 235B A22B',
        limit: {
          context: 40960,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-4b-fp8': {
        id: 'qwen/qwen3-4b-fp8',
        name: 'Qwen3 4B',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen2.5-vl-72b-instruct': {
        id: 'qwen/qwen2.5-vl-72b-instruct',
        name: 'Qwen2.5 VL 72B Instruct',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3-coder-next': {
        id: 'qwen/qwen3-coder-next',
        name: 'Qwen3 Coder Next',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-coder-30b-a3b-instruct': {
        id: 'qwen/qwen3-coder-30b-a3b-instruct',
        name: 'Qwen3 Coder 30b A3B Instruct',
        limit: {
          context: 160000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3.5-397b-a17b': {
        id: 'qwen/qwen3.5-397b-a17b',
        name: 'Qwen3.5-397B-A17B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3-max': {
        id: 'qwen/qwen3-max',
        name: 'Qwen3 Max',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-vl-8b-instruct': {
        id: 'qwen/qwen3-vl-8b-instruct',
        name: 'qwen/qwen3-vl-8b-instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3-8b-fp8': {
        id: 'qwen/qwen3-8b-fp8',
        name: 'Qwen3 8B',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-vl-30b-a3b-instruct': {
        id: 'qwen/qwen3-vl-30b-a3b-instruct',
        name: 'qwen/qwen3-vl-30b-a3b-instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'video', 'image'],
        },
      },
      'qwen/qwen3.5-122b-a10b': {
        id: 'qwen/qwen3.5-122b-a10b',
        name: 'Qwen3.5-122B-A10B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3-32b-fp8': {
        id: 'qwen/qwen3-32b-fp8',
        name: 'Qwen3 32B',
        limit: {
          context: 40960,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-vl-30b-a3b-thinking': {
        id: 'qwen/qwen3-vl-30b-a3b-thinking',
        name: 'qwen/qwen3-vl-30b-a3b-thinking',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen2.5-7b-instruct': {
        id: 'qwen/qwen2.5-7b-instruct',
        name: 'Qwen2.5 7B Instruct',
        limit: {
          context: 32000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen-2.5-72b-instruct': {
        id: 'qwen/qwen-2.5-72b-instruct',
        name: 'Qwen 2.5 72B Instruct',
        limit: {
          context: 32000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-vl-235b-a22b-thinking': {
        id: 'qwen/qwen3-vl-235b-a22b-thinking',
        name: 'Qwen3 VL 235B A22B Thinking',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3-vl-235b-a22b-instruct': {
        id: 'qwen/qwen3-vl-235b-a22b-instruct',
        name: 'Qwen3 VL 235B A22B Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'qwen/qwen3-235b-a22b-instruct-2507': {
        id: 'qwen/qwen3-235b-a22b-instruct-2507',
        name: 'Qwen3 235B A22B Instruct 2507',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-coder-480b-a35b-instruct': {
        id: 'qwen/qwen3-coder-480b-a35b-instruct',
        name: 'Qwen3 Coder 480B A35B Instruct',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'qwen/qwen3-omni-30b-a3b-thinking': {
        id: 'qwen/qwen3-omni-30b-a3b-thinking',
        name: 'Qwen3 Omni 30B A3B Thinking',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['text', 'audio', 'video', 'image'],
        },
      },
      'qwen/qwen-mt-plus': {
        id: 'qwen/qwen-mt-plus',
        name: 'Qwen MT Plus',
        limit: {
          context: 16384,
        },
        modalities: {
          input: ['text'],
        },
      },
      'baidu/ernie-4.5-300b-a47b-paddle': {
        id: 'baidu/ernie-4.5-300b-a47b-paddle',
        name: 'ERNIE 4.5 300B A47B',
        limit: {
          context: 123000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'baidu/ernie-4.5-vl-28b-a3b': {
        id: 'baidu/ernie-4.5-vl-28b-a3b',
        name: 'ERNIE 4.5 VL 28B A3B',
        limit: {
          context: 30000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'baidu/ernie-4.5-vl-424b-a47b': {
        id: 'baidu/ernie-4.5-vl-424b-a47b',
        name: 'ERNIE 4.5 VL 424B A47B',
        limit: {
          context: 123000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'baidu/ernie-4.5-21B-a3b-thinking': {
        id: 'baidu/ernie-4.5-21B-a3b-thinking',
        name: 'ERNIE-4.5-21B-A3B-Thinking',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'baidu/ernie-4.5-21B-a3b': {
        id: 'baidu/ernie-4.5-21B-a3b',
        name: 'ERNIE 4.5 21B A3B',
        limit: {
          context: 120000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'baidu/ernie-4.5-vl-28b-a3b-thinking': {
        id: 'baidu/ernie-4.5-vl-28b-a3b-thinking',
        name: 'ERNIE-4.5-VL-28B-A3B-Thinking',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'kwaipilot/kat-coder-pro': {
        id: 'kwaipilot/kat-coder-pro',
        name: 'Kat Coder Pro',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'mistralai/mistral-nemo': {
        id: 'mistralai/mistral-nemo',
        name: 'Mistral Nemo',
        limit: {
          context: 60288,
        },
        modalities: {
          input: ['text'],
        },
      },
      'minimax/minimax-m2.1': {
        id: 'minimax/minimax-m2.1',
        name: 'Minimax M2.1',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'minimax/minimax-m2': {
        id: 'minimax/minimax-m2',
        name: 'MiniMax-M2',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'minimax/minimax-m2.7-highspeed': {
        id: 'minimax/minimax-m2.7-highspeed',
        name: 'MiniMax-M2.7-highspeed',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'minimax/minimax-m2.7': {
        id: 'minimax/minimax-m2.7',
        name: 'MiniMax M2.7',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'minimax/minimax-m2.5': {
        id: 'minimax/minimax-m2.5',
        name: 'MiniMax M2.5',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'minimax/minimax-m2.5-highspeed': {
        id: 'minimax/minimax-m2.5-highspeed',
        name: 'MiniMax M2.5 Highspeed',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'google/gemma-4-26b-a4b-it': {
        id: 'google/gemma-4-26b-a4b-it',
        name: 'Gemma 4 26B A4B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'google/gemma-3-27b-it': {
        id: 'google/gemma-3-27b-it',
        name: 'Gemma 3 27B',
        limit: {
          context: 98304,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'google/gemma-4-31b-it': {
        id: 'google/gemma-4-31b-it',
        name: 'Gemma 4 31B',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'google/gemma-3-12b-it': {
        id: 'google/gemma-3-12b-it',
        name: 'Gemma 3 12B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'zai-org/glm-4.7': {
        id: 'zai-org/glm-4.7',
        name: 'GLM-4.7',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/glm-4.5-air': {
        id: 'zai-org/glm-4.5-air',
        name: 'GLM 4.5 Air',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/glm-4.6': {
        id: 'zai-org/glm-4.6',
        name: 'GLM 4.6',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/glm-4.6v': {
        id: 'zai-org/glm-4.6v',
        name: 'GLM 4.6V',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'video', 'image'],
        },
      },
      'zai-org/glm-5.2': {
        id: 'zai-org/glm-5.2',
        name: 'GLM-5.2',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/autoglm-phone-9b-multilingual': {
        id: 'zai-org/autoglm-phone-9b-multilingual',
        name: 'AutoGLM-Phone-9B-Multilingual',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'zai-org/glm-4.5': {
        id: 'zai-org/glm-4.5',
        name: 'GLM-4.5',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/glm-4.5v': {
        id: 'zai-org/glm-4.5v',
        name: 'GLM 4.5V',
        limit: {
          context: 65536,
        },
        modalities: {
          input: ['text', 'video', 'image'],
        },
      },
      'zai-org/glm-5': {
        id: 'zai-org/glm-5',
        name: 'GLM-5',
        limit: {
          context: 202800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/glm-5.1': {
        id: 'zai-org/glm-5.1',
        name: 'GLM-5.1',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'zai-org/glm-4.7-flash': {
        id: 'zai-org/glm-4.7-flash',
        name: 'GLM-4.7-Flash',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gryphe/mythomax-l2-13b': {
        id: 'gryphe/mythomax-l2-13b',
        name: 'Mythomax L2 13B',
        limit: {
          context: 4096,
        },
        modalities: {
          input: ['text'],
        },
      },
      'microsoft/wizardlm-2-8x22b': {
        id: 'microsoft/wizardlm-2-8x22b',
        name: 'Wizardlm 2 8x22B',
        limit: {
          context: 65535,
        },
        modalities: {
          input: ['text'],
        },
      },
      'minimaxai/minimax-m1-80k': {
        id: 'minimaxai/minimax-m1-80k',
        name: 'MiniMax M1',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-ocr': {
        id: 'deepseek/deepseek-ocr',
        name: 'DeepSeek-OCR',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'deepseek/deepseek-v4-flash': {
        id: 'deepseek/deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-prover-v2-671b': {
        id: 'deepseek/deepseek-prover-v2-671b',
        name: 'Deepseek Prover V2 671B',
        limit: {
          context: 160000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-r1-0528': {
        id: 'deepseek/deepseek-r1-0528',
        name: 'DeepSeek R1 0528',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-v3.2': {
        id: 'deepseek/deepseek-v3.2',
        name: 'Deepseek V3.2',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-r1-distill-qwen-32b': {
        id: 'deepseek/deepseek-r1-distill-qwen-32b',
        name: 'DeepSeek R1 Distill Qwen 32B',
        limit: {
          context: 64000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-r1-distill-llama-70b': {
        id: 'deepseek/deepseek-r1-distill-llama-70b',
        name: 'DeepSeek R1 Distill LLama 70B',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-r1-turbo': {
        id: 'deepseek/deepseek-r1-turbo',
        name: 'DeepSeek R1 (Turbo)\t',
        limit: {
          context: 64000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-r1-0528-qwen3-8b': {
        id: 'deepseek/deepseek-r1-0528-qwen3-8b',
        name: 'DeepSeek R1 0528 Qwen3 8B',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-v3.2-exp': {
        id: 'deepseek/deepseek-v3.2-exp',
        name: 'Deepseek V3.2 Exp',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-v3.1-terminus': {
        id: 'deepseek/deepseek-v3.1-terminus',
        name: 'Deepseek V3.1 Terminus',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-v3-turbo': {
        id: 'deepseek/deepseek-v3-turbo',
        name: 'DeepSeek V3 (Turbo)\t',
        limit: {
          context: 64000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-v3-0324': {
        id: 'deepseek/deepseek-v3-0324',
        name: 'DeepSeek V3 0324',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-v4-pro': {
        id: 'deepseek/deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-ocr-2': {
        id: 'deepseek/deepseek-ocr-2',
        name: 'deepseek/deepseek-ocr-2',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'deepseek/deepseek-r1-distill-qwen-14b': {
        id: 'deepseek/deepseek-r1-distill-qwen-14b',
        name: 'DeepSeek R1 Distill Qwen 14B',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text'],
        },
      },
      'deepseek/deepseek-v3.1': {
        id: 'deepseek/deepseek-v3.1',
        name: 'DeepSeek V3.1',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'inclusionai/ring-2.6-1t': {
        id: 'inclusionai/ring-2.6-1t',
        name: 'Ring-2.6-1T',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'inclusionai/ling-2.6-1t': {
        id: 'inclusionai/ling-2.6-1t',
        name: 'Ling-2.6-1T',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'inclusionai/ling-2.6-flash': {
        id: 'inclusionai/ling-2.6-flash',
        name: 'Ling-2.6-flash',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'xiaomimimo/mimo-v2-flash': {
        id: 'xiaomimimo/mimo-v2-flash',
        name: 'XiaomiMiMo/MiMo-V2-Flash',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'xiaomimimo/mimo-v2-pro': {
        id: 'xiaomimimo/mimo-v2-pro',
        name: 'MiMo-V2-Pro',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'xiaomimimo/mimo-v2.5-pro': {
        id: 'xiaomimimo/mimo-v2.5-pro',
        name: 'MiMo-V2.5-Pro',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta-llama/llama-3.1-8b-instruct': {
        id: 'meta-llama/llama-3.1-8b-instruct',
        name: 'Llama 3.1 8B Instruct',
        limit: {
          context: 16384,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta-llama/llama-4-maverick-17b-128e-instruct-fp8': {
        id: 'meta-llama/llama-4-maverick-17b-128e-instruct-fp8',
        name: 'Llama 4 Maverick Instruct',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'meta-llama/llama-3.2-3b-instruct': {
        id: 'meta-llama/llama-3.2-3b-instruct',
        name: 'Llama 3.2 3B Instruct',
        limit: {
          context: 32768,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta-llama/llama-3-8b-instruct': {
        id: 'meta-llama/llama-3-8b-instruct',
        name: 'Llama 3 8B Instruct',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta-llama/llama-4-scout-17b-16e-instruct': {
        id: 'meta-llama/llama-4-scout-17b-16e-instruct',
        name: 'Llama 4 Scout Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'meta-llama/llama-3.3-70b-instruct': {
        id: 'meta-llama/llama-3.3-70b-instruct',
        name: 'Llama 3.3 70B Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'meta-llama/llama-3-70b-instruct': {
        id: 'meta-llama/llama-3-70b-instruct',
        name: 'Llama3 70B Instruct',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'nousresearch/hermes-2-pro-llama-3-8b': {
        id: 'nousresearch/hermes-2-pro-llama-3-8b',
        name: 'Hermes 2 Pro Llama 3 8B',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'openai/gpt-oss-20b': {
        id: 'openai/gpt-oss-20b',
        name: 'OpenAI: GPT OSS 20B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'openai/gpt-oss-120b': {
        id: 'openai/gpt-oss-120b',
        name: 'OpenAI GPT OSS 120B',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'sao10K/l3-70b-euryale-v2.1': {
        id: 'sao10K/l3-70b-euryale-v2.1',
        name: 'L3 70B Euryale V2.1\t',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'sao10K/l3-8b-lunaris': {
        id: 'sao10K/l3-8b-lunaris',
        name: 'Sao10k L3 8B Lunaris\t',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'sao10K/L3-8B-stheno-v3.2': {
        id: 'sao10K/L3-8B-stheno-v3.2',
        name: 'L3 8B Stheno V3.2',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'sao10K/l31-70b-euryale-v2.2': {
        id: 'sao10K/l31-70b-euryale-v2.2',
        name: 'L31 70B Euryale V2.2',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'moonshotai/kimi-k2-0905': {
        id: 'moonshotai/kimi-k2-0905',
        name: 'Kimi K2 0905',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'moonshotai/kimi-k2.6': {
        id: 'moonshotai/kimi-k2.6',
        name: 'Kimi K2.6',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'moonshotai/kimi-k2.7-code': {
        id: 'moonshotai/kimi-k2.7-code',
        name: 'Kimi K2.7 Code',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'moonshotai/kimi-k2-thinking': {
        id: 'moonshotai/kimi-k2-thinking',
        name: 'Kimi K2 Thinking',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text'],
        },
      },
      'moonshotai/kimi-k3': {
        id: 'moonshotai/kimi-k3',
        name: 'Kimi K3',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'moonshotai/kimi-k2-instruct': {
        id: 'moonshotai/kimi-k2-instruct',
        name: 'Kimi K2 Instruct',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'moonshotai/kimi-k2.5': {
        id: 'moonshotai/kimi-k2.5',
        name: 'Kimi K2.5',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'baichuan/baichuan-m2-32b': {
        id: 'baichuan/baichuan-m2-32b',
        name: 'baichuan-m2-32b',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
    },
  },
  minimax: {
    name: 'MiniMax (minimax.io)',
    models: {
      'MiniMax-M2': {
        id: 'MiniMax-M2',
        name: 'MiniMax-M2',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'MiniMax-M2.1': {
        id: 'MiniMax-M2.1',
        name: 'MiniMax-M2.1',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'MiniMax-M2.5': {
        id: 'MiniMax-M2.5',
        name: 'MiniMax-M2.5',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'MiniMax-M2.5-highspeed': {
        id: 'MiniMax-M2.5-highspeed',
        name: 'MiniMax-M2.5-highspeed',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'MiniMax-M3': {
        id: 'MiniMax-M3',
        name: 'MiniMax-M3',
        limit: {
          context: 1048576,
        },
        modalities: {
          input: ['text', 'image', 'video'],
        },
      },
      'MiniMax-M2.7-highspeed': {
        id: 'MiniMax-M2.7-highspeed',
        name: 'MiniMax-M2.7-highspeed',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
      'MiniMax-M2.7': {
        id: 'MiniMax-M2.7',
        name: 'MiniMax-M2.7',
        limit: {
          context: 204800,
        },
        modalities: {
          input: ['text'],
        },
      },
    },
  },
  azure: {
    name: 'Azure',
    models: {
      'claude-sonnet-4-6': {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-5-nano': {
        id: 'gpt-5-nano',
        name: 'GPT-5 Nano',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'mistral-small-2503': {
        id: 'mistral-small-2503',
        name: 'Mistral Small 3.1',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'grok-4-1-fast-non-reasoning': {
        id: 'grok-4-1-fast-non-reasoning',
        name: 'Grok 4.1 Fast (Non-Reasoning)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'ministral-3b': {
        id: 'ministral-3b',
        name: 'Ministral 3B',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-4.1-nano': {
        id: 'gpt-4.1-nano',
        name: 'GPT-4.1 nano',
        limit: {
          context: 1047576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-3.5-turbo-1106': {
        id: 'gpt-3.5-turbo-1106',
        name: 'GPT-3.5 Turbo 1106',
        limit: {
          context: 16384,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-5-codex': {
        id: 'gpt-5-codex',
        name: 'GPT-5-Codex',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5-pro': {
        id: 'gpt-5-pro',
        name: 'GPT-5 Pro',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'phi-4-mini-reasoning': {
        id: 'phi-4-mini-reasoning',
        name: 'Phi-4-mini-reasoning',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'codex-mini': {
        id: 'codex-mini',
        name: 'Codex Mini',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-5.1-codex-mini': {
        id: 'gpt-5.1-codex-mini',
        name: 'GPT-5.1 Codex Mini',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5.1-codex': {
        id: 'gpt-5.1-codex',
        name: 'GPT-5.1 Codex',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image', 'audio'],
        },
      },
      'gpt-5.6-sol': {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'phi-4-reasoning-plus': {
        id: 'phi-4-reasoning-plus',
        name: 'Phi-4-reasoning-plus',
        limit: {
          context: 32000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'claude-opus-5': {
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'kimi-k2.6': {
        id: 'kimi-k2.6',
        name: 'Kimi K2.6',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'cohere-command-a': {
        id: 'cohere-command-a',
        name: 'Command A',
        limit: {
          context: 131072,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-5.2-codex': {
        id: 'gpt-5.2-codex',
        name: 'GPT-5.2 Codex',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'llama-4-maverick-17b-128e-instruct-fp8': {
        id: 'llama-4-maverick-17b-128e-instruct-fp8',
        name: 'Llama 4 Maverick 17B 128E Instruct FP8',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'cohere-embed-v3-english': {
        id: 'cohere-embed-v3-english',
        name: 'Embed v3 English',
        limit: {
          context: 512,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-6-astra': {
        id: 'gpt-6-astra',
        name: 'GPT-6 Astra',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-opus-4-5': {
        id: 'claude-opus-4-5',
        name: 'Claude Opus 4.5',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'kimi-k2.7-code': {
        id: 'kimi-k2.7-code',
        name: 'Kimi K2.7 Code',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'cohere-embed-v-4-0': {
        id: 'cohere-embed-v-4-0',
        name: 'Embed v4',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'phi-4': {
        id: 'phi-4',
        name: 'Phi-4',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-4.1-mini': {
        id: 'gpt-4.1-mini',
        name: 'GPT-4.1 mini',
        limit: {
          context: 1047576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-3.5-turbo-0125': {
        id: 'gpt-3.5-turbo-0125',
        name: 'GPT-3.5 Turbo 0125',
        limit: {
          context: 16384,
        },
        modalities: {
          input: ['text'],
        },
      },
      'phi-4-multimodal': {
        id: 'phi-4-multimodal',
        name: 'Phi-4-multimodal',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image', 'audio'],
        },
      },
      'phi-4-mini': {
        id: 'phi-4-mini',
        name: 'Phi-4-mini',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-5.4': {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-4-turbo': {
        id: 'gpt-4-turbo',
        name: 'GPT-4 Turbo',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'grok-4-1-fast-reasoning': {
        id: 'grok-4-1-fast-reasoning',
        name: 'Grok 4.1 Fast (Reasoning)',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'claude-fable-5-1': {
        id: 'claude-fable-5-1',
        name: 'Claude Fable 5.1',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-5.1': {
        id: 'gpt-5.1',
        name: 'GPT-5.1',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image', 'audio'],
        },
      },
      'gpt-5.1-codex-max': {
        id: 'gpt-5.1-codex-max',
        name: 'GPT-5.1 Codex Max',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'claude-opus-4-6': {
        id: 'claude-opus-4-6',
        name: 'Claude Opus 4.6',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'deepseek-r1': {
        id: 'deepseek-r1',
        name: 'DeepSeek-R1',
        limit: {
          context: 163840,
        },
        modalities: {
          input: ['text'],
        },
      },
      o1: {
        id: 'o1',
        name: 'o1',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-4o': {
        id: 'gpt-4o',
        name: 'GPT-4o',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5.6-luna': {
        id: 'gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-opus-4-7': {
        id: 'claude-opus-4-7',
        name: 'Claude Opus 4.7',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'deepseek-v3.2': {
        id: 'deepseek-v3.2',
        name: 'DeepSeek-V3.2',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-4-turbo-vision': {
        id: 'gpt-4-turbo-vision',
        name: 'GPT-4 Turbo Vision',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5.3-codex': {
        id: 'gpt-5.3-codex',
        name: 'GPT-5.3 Codex',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'llama-4-scout-17b-16e-instruct': {
        id: 'llama-4-scout-17b-16e-instruct',
        name: 'Llama 4 Scout 17B 16E Instruct',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-4o-mini': {
        id: 'gpt-4o-mini',
        name: 'GPT-4o mini',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'claude-fable-5': {
        id: 'claude-fable-5',
        name: 'Claude Fable 5',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-image-1.5': {
        id: 'gpt-image-1.5',
        name: 'GPT-Image-1.5',
        limit: {
          context: 0,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-4.1': {
        id: 'gpt-4.1',
        name: 'GPT-4.1',
        limit: {
          context: 1047576,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'text-embedding-ada-002': {
        id: 'text-embedding-ada-002',
        name: 'text-embedding-ada-002',
        limit: {
          context: 8192,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-image-1': {
        id: 'gpt-image-1',
        name: 'GPT-Image-1',
        limit: {
          context: 0,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5.4-nano': {
        id: 'gpt-5.4-nano',
        name: 'GPT-5.4 Nano',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'model-router': {
        id: 'model-router',
        name: 'Model Router',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-chat-latest': {
        id: 'gpt-chat-latest',
        name: 'GPT Chat Latest',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'cohere-embed-v3-multilingual': {
        id: 'cohere-embed-v3-multilingual',
        name: 'Embed v3 Multilingual',
        limit: {
          context: 512,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-5.4-mini': {
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 Mini',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-image-2.5-sunburst': {
        id: 'gpt-image-2.5-sunburst',
        name: 'GPT Image 2.5 Sunburst',
        limit: {
          context: 0,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'grok-4.6': {
        id: 'grok-4.6',
        name: 'Grok 4.6',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'deepseek-v3.2-speciale': {
        id: 'deepseek-v3.2-speciale',
        name: 'DeepSeek-V3.2-Speciale',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-sonnet-4-5': {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'claude-opus-4-1': {
        id: 'claude-opus-4-1',
        name: 'Claude Opus 4.1',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'gpt-image-2': {
        id: 'gpt-image-2',
        name: 'GPT-Image-2',
        limit: {
          context: 0,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'kimi-k2.5': {
        id: 'kimi-k2.5',
        name: 'Kimi K2.5',
        limit: {
          context: 262144,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'phi-4-reasoning': {
        id: 'phi-4-reasoning',
        name: 'Phi-4-reasoning',
        limit: {
          context: 32000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'claude-opus-4-8': {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'deepseek-v4-pro': {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'mistral-medium-2505': {
        id: 'mistral-medium-2505',
        name: 'Mistral Medium 3',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'text-embedding-3-small': {
        id: 'text-embedding-3-small',
        name: 'text-embedding-3-small',
        limit: {
          context: 8191,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-5-mini': {
        id: 'gpt-5-mini',
        name: 'GPT-5 Mini',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5.4-pro': {
        id: 'gpt-5.4-pro',
        name: 'GPT-5.4 Pro',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'text-embedding-3-large': {
        id: 'text-embedding-3-large',
        name: 'text-embedding-3-large',
        limit: {
          context: 8191,
        },
        modalities: {
          input: ['text'],
        },
      },
      'codestral-2501': {
        id: 'codestral-2501',
        name: 'Codestral 25.01',
        limit: {
          context: 256000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-3.5-turbo-instruct': {
        id: 'gpt-3.5-turbo-instruct',
        name: 'GPT-3.5 Turbo Instruct',
        limit: {
          context: 4096,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-image-2.5-flare': {
        id: 'gpt-image-2.5-flare',
        name: 'GPT Image 2.5 Flare',
        limit: {
          context: 0,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5.6-terra': {
        id: 'gpt-5.6-terra',
        name: 'GPT-5.6 Terra',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'grok-4-20-non-reasoning': {
        id: 'grok-4-20-non-reasoning',
        name: 'Grok 4.20 (Non-Reasoning)',
        limit: {
          context: 262000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'gpt-5.2': {
        id: 'gpt-5.2',
        name: 'GPT-5.2',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5': {
        id: 'gpt-5',
        name: 'GPT-5',
        limit: {
          context: 400000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'claude-sonnet-5': {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'llama-3.3-70b-instruct': {
        id: 'llama-3.3-70b-instruct',
        name: 'Llama-3.3-70B-Instruct',
        limit: {
          context: 128000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'grok-4-20-reasoning': {
        id: 'grok-4-20-reasoning',
        name: 'Grok 4.20 (Reasoning)',
        limit: {
          context: 262000,
        },
        modalities: {
          input: ['text'],
        },
      },
      'o4-mini': {
        id: 'o4-mini',
        name: 'o4-mini',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'claude-mythos-5': {
        id: 'claude-mythos-5',
        name: 'Claude Mythos 5',
        limit: {
          context: 1000000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
      'o3-mini': {
        id: 'o3-mini',
        name: 'o3-mini',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text'],
        },
      },
      o3: {
        id: 'o3',
        name: 'o3',
        limit: {
          context: 200000,
        },
        modalities: {
          input: ['text', 'image'],
        },
      },
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        limit: {
          context: 1050000,
        },
        modalities: {
          input: ['text', 'image', 'pdf'],
        },
      },
    },
  },
}
