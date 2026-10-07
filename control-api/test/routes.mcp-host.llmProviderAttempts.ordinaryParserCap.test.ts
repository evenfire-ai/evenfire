import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import {
  AUTHORIZE_TEXT_BODY_BYTES,
  createMcpHostLlmProviderAttemptRoutes,
} from '../src/routes/mcp-host/llmProviderAttempts.routes.js'

// selectAuthorizeBudget only sends declared lengths <= AUTHORIZE_TEXT_BODY_BYTES
// to the uncharged parser, so no HTTP request can exceed its limit through the
// route; the limit is defense in depth and can only be pinned at construction.
describe('authorize ordinary parser cap', () => {
  it('builds the uncharged parser with the text envelope and the retained one with the visual envelope', () => {
    const json = vi.spyOn(express, 'json')
    try {
      createMcpHostLlmProviderAttemptRoutes({ getResource: vi.fn() } as never)
      expect(json).toHaveBeenCalledTimes(2)
      const limits = json.mock.calls
        .map(([options]) => options?.limit as number)
        .sort((a, b) => a - b)
      expect(AUTHORIZE_TEXT_BODY_BYTES).toBe(8_404_992)
      expect(limits[0]).toBe(8_404_992)
      expect(limits[1]).toBeGreaterThan(8_404_992)
      for (const [options] of json.mock.calls) expect(options?.inflate).toBe(false)
    } finally {
      json.mockRestore()
    }
  })
})
