/**
 * Phase 7 regression test: McpManager cleanup validation.
 *
 * Verifies that provider-specific tool format methods have been removed,
 * while the generic getAllTools() and callTool() survive.
 */

import { describe, it, expect } from "vitest";
import { McpManager } from "../manager";

describe("McpManager cleanup — provider-specific methods removed", () => {
  it("should NOT have getToolsForOpenAI() method", () => {
    const manager = new McpManager();
    expect((manager as any).getToolsForOpenAI).toBeUndefined();
  });

  it("should NOT have getToolsForClaude() method", () => {
    const manager = new McpManager();
    expect((manager as any).getToolsForClaude).toBeUndefined();
  });
});

describe("McpManager cleanup — generic methods survive", () => {
  it("should retain getAllTools() method", () => {
    const manager = new McpManager();
    expect(typeof manager.getAllTools).toBe("function");
    expect(manager.getAllTools()).toEqual([]);
  });

  it("should retain callTool() method", async () => {
    const manager = new McpManager();
    expect(typeof manager.callTool).toBe("function");
    const result = await manager.callTool("missing__tool", {});
    expect(result.isError).toBe(true);
  });
});
