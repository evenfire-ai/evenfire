/**
 * Phase 7 regression test: Provider cleanup validation.
 *
 * Verifies that legacy LLMProvider methods (chat, chatWithTools, chatStream)
 * and types (OpenAITool, ClaudeTool, ToolCallHandler) have been removed,
 * while SingleTurnProvider methods remain intact.
 */

import { describe, it, expect, vi } from "vitest";
import { OpenAIProvider } from "../openai";
import { ClaudeProvider } from "../claude";

describe("Provider cleanup — legacy methods removed", () => {
  it("OpenAIProvider should NOT have chat() method", () => {
    const client = { chat: { completions: { create: vi.fn() } } };
    const provider = new OpenAIProvider(client as any, "gpt-4o");
    expect((provider as any).chat).toBeUndefined();
  });

  it("OpenAIProvider should NOT have chatWithTools() method", () => {
    const client = { chat: { completions: { create: vi.fn() } } };
    const provider = new OpenAIProvider(client as any, "gpt-4o");
    expect((provider as any).chatWithTools).toBeUndefined();
  });

  it("OpenAIProvider should NOT have chatStream() method", () => {
    const client = { chat: { completions: { create: vi.fn() } } };
    const provider = new OpenAIProvider(client as any, "gpt-4o");
    expect((provider as any).chatStream).toBeUndefined();
  });

  it("ClaudeProvider should NOT have chat() method", () => {
    const client = { messages: { create: vi.fn() } };
    const provider = new ClaudeProvider(client as any, "claude-3-5-sonnet-20241022");
    expect((provider as any).chat).toBeUndefined();
  });

  it("ClaudeProvider should NOT have chatWithTools() method", () => {
    const client = { messages: { create: vi.fn() } };
    const provider = new ClaudeProvider(client as any, "claude-3-5-sonnet-20241022");
    expect((provider as any).chatWithTools).toBeUndefined();
  });

  it("ClaudeProvider should NOT have chatStream() method", () => {
    const client = { messages: { create: vi.fn() } };
    const provider = new ClaudeProvider(client as any, "claude-3-5-sonnet-20241022");
    expect((provider as any).chatStream).toBeUndefined();
  });
});

describe("Provider cleanup — SingleTurnProvider methods survive", () => {
  it("OpenAIProvider should retain completeSingleTurn()", () => {
    const client = { chat: { completions: { create: vi.fn() } } };
    const provider = new OpenAIProvider(client as any, "gpt-4o");
    expect(typeof provider.completeSingleTurn).toBe("function");
  });

  it("OpenAIProvider should retain completeSingleTurnWithTools()", () => {
    const client = { chat: { completions: { create: vi.fn() } } };
    const provider = new OpenAIProvider(client as any, "gpt-4o");
    expect(typeof provider.completeSingleTurnWithTools).toBe("function");
  });

  it("ClaudeProvider should retain completeSingleTurn()", () => {
    const client = { messages: { create: vi.fn() } };
    const provider = new ClaudeProvider(client as any, "claude-3-5-sonnet-20241022");
    expect(typeof provider.completeSingleTurn).toBe("function");
  });

  it("ClaudeProvider should retain completeSingleTurnWithTools()", () => {
    const client = { messages: { create: vi.fn() } };
    const provider = new ClaudeProvider(client as any, "claude-3-5-sonnet-20241022");
    expect(typeof provider.completeSingleTurnWithTools).toBe("function");
  });

  it("Both providers should retain getProviderType()", () => {
    const openaiClient = { chat: { completions: { create: vi.fn() } } };
    const claudeClient = { messages: { create: vi.fn() } };
    const openai = new OpenAIProvider(openaiClient as any, "gpt-4o");
    const claude = new ClaudeProvider(claudeClient as any, "claude-3-5-sonnet-20241022");
    expect(openai.getProviderType()).toBe("openai");
    expect(claude.getProviderType()).toBe("claude");
  });
});

describe("Provider cleanup — legacy types not exported", () => {
  it("should NOT export OpenAITool from llm/index", async () => {
    const llmModule = await import("../index");
    expect((llmModule as any).OpenAITool).toBeUndefined();
  });

  it("should NOT export ClaudeTool from llm/index", async () => {
    const llmModule = await import("../index");
    expect((llmModule as any).ClaudeTool).toBeUndefined();
  });

  it("should NOT export LLMProvider from llm/index", async () => {
    const llmModule = await import("../index");
    expect((llmModule as any).LLMProvider).toBeUndefined();
  });

  it("should NOT export ToolCallHandler from llm/index", async () => {
    const llmModule = await import("../index");
    expect((llmModule as any).ToolCallHandler).toBeUndefined();
  });
});
