import { describe, it, expect } from "vitest";
import {
  FinishReason,
  ConversationState,
  type RespondResult,
  type ToolCall,
  type PendingApproval,
  type LoopResult,
  type ToolCompletionResponse,
  type ChatMessage,
} from "../types";

describe("FinishReason", () => {
  it("should have correct string values for JSON serialization", () => {
    expect(FinishReason.Stop).toBe("stop");
    expect(FinishReason.Length).toBe("length");
    expect(FinishReason.ToolUse).toBe("tool_use");
    expect(FinishReason.ContentFilter).toBe("content_filter");
    expect(FinishReason.Unknown).toBe("unknown");
  });
});

describe("ConversationState", () => {
  it("should have correct string values", () => {
    expect(ConversationState.Idle).toBe("idle");
    expect(ConversationState.Processing).toBe("processing");
    expect(ConversationState.AwaitingApproval).toBe("awaiting_approval");
  });

  it("should have exactly 3 states (not more)", () => {
    const values = Object.values(ConversationState);
    expect(values).toHaveLength(3);
  });
});

describe("RespondResult", () => {
  it("should narrow to 'text' variant with content field", () => {
    const result: RespondResult = { type: "text", content: "Hello" };
    if (result.type === "text") {
      expect(result.content).toBe("Hello");
    } else {
      throw new Error("Should have matched 'text'");
    }
  });

  it("should narrow to 'tool_calls' variant with calls array", () => {
    const calls: ToolCall[] = [
      { id: "tc_1", name: "search", arguments: { query: "test" } },
    ];
    const result: RespondResult = { type: "tool_calls", calls };
    if (result.type === "tool_calls") {
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].name).toBe("search");
    } else {
      throw new Error("Should have matched 'tool_calls'");
    }
  });

  it("should narrow to 'need_approval' variant with PendingApproval", () => {
    const approval: PendingApproval = {
      request_id: "req_1",
      tool_name: "shell_exec",
      parameters: { command: "ls" },
      description: "List files",
      tool_call_id: "tc_1",
      context_snapshot: [],
    };
    const result: RespondResult = { type: "need_approval", approval };
    if (result.type === "need_approval") {
      expect(result.approval.tool_name).toBe("shell_exec");
      expect(result.approval.context_snapshot).toEqual([]);
    } else {
      throw new Error("Should have matched 'need_approval'");
    }
  });

  it("should narrow to 'error' variant with Error instance", () => {
    const result: RespondResult = { type: "error", error: new Error("fail") };
    if (result.type === "error") {
      expect(result.error.message).toBe("fail");
    } else {
      throw new Error("Should have matched 'error'");
    }
  });
});

describe("LoopResult", () => {
  it("should represent a successful response with usage", () => {
    const result: LoopResult = {
      type: "response",
      content: "Done",
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    };
    expect(result.type).toBe("response");
    if (result.type === "response") {
      expect(result.usage.total_tokens).toBe(150);
    }
  });

  it("should represent exhaustion with iteration count", () => {
    const result: LoopResult = {
      type: "exhaustion",
      message: "Max iterations reached",
      iterations: 10,
    };
    if (result.type === "exhaustion") {
      expect(result.iterations).toBe(10);
    }
  });
});

describe("ToolCompletionResponse", () => {
  it("should use null for tool_calls when no tools called (not empty array)", () => {
    const response: ToolCompletionResponse = {
      content: "Hello",
      tool_calls: null,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      finish_reason: FinishReason.Stop,
    };
    expect(response.tool_calls).toBeNull();
    expect(response.tool_calls).not.toBeUndefined();
    expect(response.tool_calls).not.toEqual([]);
  });
});

describe("ChatMessage", () => {
  it("should support 'tool' role with tool_call_id", () => {
    const msg: ChatMessage = {
      role: "tool",
      content: '{"result": "ok"}',
      tool_call_id: "tc_123",
      name: "search",
    };
    expect(msg.role).toBe("tool");
    expect(msg.tool_call_id).toBe("tc_123");
  });

  it("should support assistant role with tool_calls array", () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: "I'll search for that.",
      tool_calls: [
        { id: "tc_1", name: "search", arguments: { query: "test" } },
        { id: "tc_2", name: "read", arguments: { path: "/tmp" } },
      ],
    };
    expect(msg.tool_calls).toHaveLength(2);
    expect(msg.tool_calls![0].id).not.toBe(msg.tool_calls![1].id);
  });

  it("should use null (not undefined) for tool_calls when absent on assistant messages", () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: "Just text",
      tool_calls: null,
    };
    expect(msg.tool_calls).toBeNull();
  });
});
