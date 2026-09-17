import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OPENROUTER_CAPABILITY_CACHE_MS,
  OPENROUTER_METADATA_EVIDENCE,
  OPENROUTER_PROVIDER,
  type OpenRouterMetadataReader,
  createOpenRouterImageCapabilityResolver,
} from './capabilities'
import { VISUAL_INPUT_LIMITS, VisualInputError } from './policy'

const MODEL = 'openai/gpt-4o'
const MODEL_PATH = '/model/openai/gpt-4o'
const METADATA_BYTES = VISUAL_INPUT_LIMITS.metadataBytes
const DEADLINE_MS = VISUAL_INPUT_LIMITS.validationTimeoutMs

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function metadata(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 })
}

function catalogEntry(id: string, inputModalities: unknown): unknown {
  return { data: { id, architecture: { input_modalities: inputModalities } } }
}

/** A stream that stays open until the reader cancels it, so cancellation is observable. */
function trackedStream(chunkBytes = 0): {
  stream: ReadableStream<Uint8Array>
  wasCancelled: () => boolean
} {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (chunkBytes > 0) controller.enqueue(new Uint8Array(chunkBytes))
    },
    cancel() {
      cancelled = true
    },
  })
  return { stream, wasCancelled: () => cancelled }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => {
    resolve = settle
  })
  return { promise, resolve }
}

/** Runs after every pending microtask, so an in-flight read is provably started. */
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

describe('OpenRouter image capability resolver', () => {
  it('requests the exact model path and reports supported with bounded evidence', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const readMetadata = vi.fn<OpenRouterMetadataReader>(async () =>
      metadata(catalogEntry(MODEL, ['text', 'image']))
    )
    const resolveCapability = createOpenRouterImageCapabilityResolver(MODEL, readMetadata)

    await expect(resolveCapability()).resolves.toEqual({
      status: 'supported',
      provider: 'openrouter',
      model: MODEL,
      evidence: 'openrouter-model-metadata',
    })

    expect(readMetadata).toHaveBeenCalledTimes(1)
    expect(readMetadata.mock.calls[0][0]).toBe(MODEL_PATH)
    expect(readMetadata.mock.calls[0][1]).toBeInstanceOf(AbortSignal)
    // The transport receives the path and a per-call signal only: no headers, no key.
    expect(readMetadata.mock.calls[0]).toHaveLength(2)
    expect(OPENROUTER_PROVIDER).toBe('openrouter')
    expect(OPENROUTER_METADATA_EVIDENCE).toBe('openrouter-model-metadata')
    expect(OPENROUTER_CAPABILITY_CACHE_MS).toBe(60_000)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('encodes reserved characters in the model path', async () => {
    const model = 'meta-llama/llama-3.2-3b-instruct:free'
    const readMetadata = vi.fn<OpenRouterMetadataReader>(async () =>
      metadata(catalogEntry(model, ['image']))
    )

    await expect(
      createOpenRouterImageCapabilityResolver(model, readMetadata)()
    ).resolves.toMatchObject({
      status: 'supported',
    })
    expect(readMetadata.mock.calls[0][0]).toBe('/model/meta-llama/llama-3.2-3b-instruct%3Afree')
  })

  it('refuses traversal, empty, and non-segment identifiers without reading metadata', async () => {
    const readMetadata = vi.fn<OpenRouterMetadataReader>(async () =>
      metadata(catalogEntry(MODEL, ['image']))
    )
    const rejected = [
      '../etc/passwd',
      'a/..',
      '../b',
      '.',
      'a/b/c',
      'openai',
      '/gpt-4o',
      'gpt-4o/',
      'openai/ bad',
      'openai/gpt 4o',
      `openai/gpt-4o${String.fromCharCode(0)}`,
      'openai/gpt-4oü',
    ]

    for (const model of rejected) {
      await expect(createOpenRouterImageCapabilityResolver(model, readMetadata)()).resolves.toEqual(
        {
          status: 'unknown',
        }
      )
    }
    expect(readMetadata).not.toHaveBeenCalled()
  })

  it('reports an explicit text-only modality list as unsupported and caches it', async () => {
    const readMetadata = vi.fn<OpenRouterMetadataReader>(async () =>
      metadata(catalogEntry(MODEL, ['text']))
    )
    const resolveCapability = createOpenRouterImageCapabilityResolver(MODEL, readMetadata)

    await expect(resolveCapability()).resolves.toEqual({ status: 'unsupported' })
    await expect(resolveCapability()).resolves.toEqual({ status: 'unsupported' })
    expect(readMetadata).toHaveBeenCalledTimes(1)
  })

  it('treats an alias or a neighbouring id as unknown instead of inferring identity', async () => {
    const readMetadata = vi.fn<OpenRouterMetadataReader>(async () =>
      metadata(catalogEntry('openai/gpt-4o-2024-08-06', ['image']))
    )

    await expect(createOpenRouterImageCapabilityResolver(MODEL, readMetadata)()).resolves.toEqual({
      status: 'unknown',
    })
  })

  it('returns unknown for missing or malformed catalog entries', async () => {
    const bodies = [
      '',
      'not json',
      '{}',
      '{"data":null}',
      '{"data":{}}',
      '{"data":{"architecture":{"input_modalities":["image"]}}}',
      '{"data":{"id":"other/model","architecture":{"input_modalities":["image"]}}}',
      `{"data":{"id":"${MODEL}"}}`,
      `{"data":{"id":"${MODEL}","architecture":null}}`,
      `{"data":{"id":"${MODEL}","architecture":{}}}`,
      `{"data":{"id":"${MODEL}","architecture":{"input_modalities":"image"}}}`,
      `{"data":{"id":"${MODEL}","architecture":{"input_modalities":["text",5]}}}`,
      `{"data":{"id":"${MODEL}","architecture":{"input_modalities":[null]}}}`,
    ]

    for (const body of bodies) {
      const readMetadata = vi.fn<OpenRouterMetadataReader>(
        async () => new Response(body, { status: 200 })
      )
      await expect(createOpenRouterImageCapabilityResolver(MODEL, readMetadata)()).resolves.toEqual(
        {
          status: 'unknown',
        }
      )
    }
  })

  it('returns unknown for a non-200 response or a followed redirect and releases the body', async () => {
    const failed = trackedStream()
    const readFailed = vi.fn<OpenRouterMetadataReader>(
      async () => new Response(failed.stream, { status: 503 })
    )
    await expect(createOpenRouterImageCapabilityResolver(MODEL, readFailed)()).resolves.toEqual({
      status: 'unknown',
    })
    expect(failed.wasCancelled()).toBe(true)

    const redirected = trackedStream()
    const redirectedResponse = {
      ok: true,
      status: 200,
      redirected: true,
      body: redirected.stream,
    } as unknown as Response
    const readRedirected = vi.fn<OpenRouterMetadataReader>(async () => redirectedResponse)
    await expect(createOpenRouterImageCapabilityResolver(MODEL, readRedirected)()).resolves.toEqual(
      {
        status: 'unknown',
      }
    )
    expect(redirected.wasCancelled()).toBe(true)
  })

  it('returns unknown for a response without a body', async () => {
    const readMetadata = vi.fn<OpenRouterMetadataReader>(
      async () => new Response(null, { status: 200 })
    )
    await expect(createOpenRouterImageCapabilityResolver(MODEL, readMetadata)()).resolves.toEqual({
      status: 'unknown',
    })
  })

  it('returns unknown for a body that cannot be read or decoded', async () => {
    const locked = new Response(JSON.stringify(catalogEntry(MODEL, ['image'])), { status: 200 })
    locked.body?.getReader()
    const readLocked = vi.fn<OpenRouterMetadataReader>(async () => locked)
    await expect(createOpenRouterImageCapabilityResolver(MODEL, readLocked)()).resolves.toEqual({
      status: 'unknown',
    })

    const invalidUtf8 = Uint8Array.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])
    const readInvalid = vi.fn<OpenRouterMetadataReader>(
      async () => new Response(invalidUtf8, { status: 200 })
    )
    await expect(createOpenRouterImageCapabilityResolver(MODEL, readInvalid)()).resolves.toEqual({
      status: 'unknown',
    })
  })

  it('caps the metadata body at 64 KiB and cancels an oversized read', async () => {
    const oversized = trackedStream(METADATA_BYTES + 1)
    const readOversized = vi.fn<OpenRouterMetadataReader>(
      async () => new Response(oversized.stream, { status: 200 })
    )
    await expect(createOpenRouterImageCapabilityResolver(MODEL, readOversized)()).resolves.toEqual({
      status: 'unknown',
    })
    expect(oversized.wasCancelled()).toBe(true)

    // A complete body of exactly the cap is still read.
    const base = `{"data":{"id":"${MODEL}","architecture":{"input_modalities":["image"]}}}`
    const padded = base.padEnd(METADATA_BYTES, ' ')
    expect(padded.length).toBe(METADATA_BYTES)
    const readAtCap = vi.fn<OpenRouterMetadataReader>(
      async () => new Response(padded, { status: 200 })
    )
    await expect(
      createOpenRouterImageCapabilityResolver(MODEL, readAtCap)()
    ).resolves.toMatchObject({
      status: 'supported',
    })
  })

  it('returns unknown when the per-call deadline elapses', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let observed: AbortSignal | undefined
    const readMetadata = vi.fn<OpenRouterMetadataReader>((_path, signal) => {
      observed = signal
      return new Promise<Response>(() => undefined)
    })
    const pending = createOpenRouterImageCapabilityResolver(MODEL, readMetadata)()

    expect(DEADLINE_MS).toBe(5_000)
    await vi.advanceTimersByTimeAsync(DEADLINE_MS)
    await expect(pending).resolves.toEqual({ status: 'unknown' })
    expect(observed?.aborted).toBe(true)
  })

  it('reports cancellation for an aborted caller and aborts its own in-flight read', async () => {
    const controller = new AbortController()
    let observed: AbortSignal | undefined
    const readMetadata = vi.fn<OpenRouterMetadataReader>((_path, signal) => {
      observed = signal
      return new Promise<Response>(() => undefined)
    })
    const pending = createOpenRouterImageCapabilityResolver(MODEL, readMetadata)(controller.signal)

    controller.abort()
    const failure: unknown = await pending.then(
      () => undefined,
      (reason: unknown) => reason
    )
    expect(failure).toBeInstanceOf(VisualInputError)
    expect(failure).toMatchObject({ code: 'cancelled' })
    expect(observed?.aborted).toBe(true)
  })

  it('fails an already-aborted caller before touching the transport', async () => {
    const controller = new AbortController()
    controller.abort()
    const readMetadata = vi.fn<OpenRouterMetadataReader>(async () =>
      metadata(catalogEntry(MODEL, ['image']))
    )

    await expect(
      createOpenRouterImageCapabilityResolver(MODEL, readMetadata)(controller.signal)
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(readMetadata).not.toHaveBeenCalled()
  })

  it('cancels the in-flight body when the caller aborts', async () => {
    const controller = new AbortController()
    const body = trackedStream()
    const readMetadata = vi.fn<OpenRouterMetadataReader>(
      async () => new Response(body.stream, { status: 200 })
    )
    const pending = createOpenRouterImageCapabilityResolver(MODEL, readMetadata)(controller.signal)

    await flushMicrotasks()
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(body.wasCancelled()).toBe(true)
  })

  it('does not cancel a concurrent reader when another caller aborts', async () => {
    const controller = new AbortController()
    const pending = deferred<Response>()
    let calls = 0
    const readMetadata = vi.fn<OpenRouterMetadataReader>((_path, signal) => {
      calls += 1
      if (calls > 1) return pending.promise
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    const resolveCapability = createOpenRouterImageCapabilityResolver(MODEL, readMetadata)
    const aborting = resolveCapability(controller.signal)
    const surviving = resolveCapability()

    controller.abort()
    await expect(aborting).rejects.toMatchObject({ code: 'cancelled' })

    pending.resolve(metadata(catalogEntry(MODEL, ['image'])))
    await expect(surviving).resolves.toMatchObject({ status: 'supported' })
  })

  it('gives every call its own signal and never shares the caller signal with the transport', async () => {
    const controller = new AbortController()
    const gate = deferred<void>()
    const signals: AbortSignal[] = []
    const readMetadata = vi.fn<OpenRouterMetadataReader>(async (_path, signal) => {
      signals.push(signal)
      await gate.promise
      return metadata(catalogEntry(MODEL, ['image']))
    })
    const resolveCapability = createOpenRouterImageCapabilityResolver(MODEL, readMetadata)
    const first = resolveCapability(controller.signal)
    const second = resolveCapability(controller.signal)

    // Concurrent readers never share an in-flight read.
    expect(readMetadata).toHaveBeenCalledTimes(2)
    expect(signals[0]).not.toBe(controller.signal)
    expect(signals[1]).not.toBe(controller.signal)
    expect(signals[0]).not.toBe(signals[1])

    gate.resolve(undefined)
    await expect(first).resolves.toMatchObject({ status: 'supported' })
    await expect(second).resolves.toMatchObject({ status: 'supported' })
  })

  it('serves a cached answer for 60 seconds and refreshes afterwards', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const readMetadata = vi.fn<OpenRouterMetadataReader>(async () =>
      metadata(catalogEntry(MODEL, ['image']))
    )
    const resolveCapability = createOpenRouterImageCapabilityResolver(MODEL, readMetadata)

    await resolveCapability()
    vi.advanceTimersByTime(59_999)
    await resolveCapability()
    expect(readMetadata).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1)
    await resolveCapability()
    expect(readMetadata).toHaveBeenCalledTimes(2)
  })

  it('never caches an unknown answer', async () => {
    const readMetadata = vi.fn<OpenRouterMetadataReader>(
      async () => new Response(null, { status: 500 })
    )
    const resolveCapability = createOpenRouterImageCapabilityResolver(MODEL, readMetadata)

    await expect(resolveCapability()).resolves.toEqual({ status: 'unknown' })
    await expect(resolveCapability()).resolves.toEqual({ status: 'unknown' })
    expect(readMetadata).toHaveBeenCalledTimes(2)
  })

  it('binds each resolver to its own model and cache', async () => {
    const readA = vi.fn<OpenRouterMetadataReader>(async () =>
      metadata(catalogEntry('openai/gpt-4o', ['image']))
    )
    const readB = vi.fn<OpenRouterMetadataReader>(async () =>
      metadata(catalogEntry('anthropic/claude-sonnet-4', ['text']))
    )
    const resolveA = createOpenRouterImageCapabilityResolver('openai/gpt-4o', readA)
    const resolveB = createOpenRouterImageCapabilityResolver('anthropic/claude-sonnet-4', readB)

    await expect(resolveA()).resolves.toMatchObject({ status: 'supported', model: 'openai/gpt-4o' })
    await expect(resolveB()).resolves.toEqual({ status: 'unsupported' })
    await expect(resolveA()).resolves.toMatchObject({ status: 'supported' })
    expect(readA).toHaveBeenCalledTimes(1)
    expect(readB).toHaveBeenCalledTimes(1)
    expect(readB.mock.calls[0][0]).toBe('/model/anthropic/claude-sonnet-4')
  })
})
