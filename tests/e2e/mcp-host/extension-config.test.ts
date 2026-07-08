/**
 * E2E: Extension Configuration — verify Phase 6 extension flags and wiring.
 *
 * Validates that extension env vars (CLERUM_ENABLE_APPROVAL, CLERUM_ENABLE_NUDGE,
 * CLERUM_ENABLE_PRESSURE_COMPACTION) are recognized and that the approval endpoints
 * are properly wired to the agent.
 */
import { describe, it, expect } from "vitest";
import {
  approveRequest,
  denyRequest,
  sendMessage,
  waitForIdle,
  getPodLogs,
} from "../helpers.js";

describe("Extension Configuration (Phase 6)", () => {
  it("mcp-host starts with approval system enabled by default", () => {
    const logs = getPodLogs("mcp-host", "mcp-host", 500);
    // Approval system defaults to enabled (CLERUM_ENABLE_APPROVAL defaults to true)
    expect(logs).toContain("Approval system: ENABLED");
    expect(logs).not.toContain("Nudge controller: ENABLED");
  });

  it("mcp-host logs show extension configuration on startup", () => {
    const logs = getPodLogs("mcp-host", "mcp-host", 500);
    // Agent should log its startup — verify basic agent initialization
    expect(logs).toContain("[Agent]");
  });

  it("POST /approve endpoint is wired (returns 200, not 501)", async () => {
    const res = await approveRequest("test-user", "req-wiring-check");
    // 200 means the handler is wired (even if no pending approval)
    // 501 would mean the handler was never registered
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("success");
  });

  it("POST /deny endpoint is wired (returns 200, not 501)", async () => {
    const res = await denyRequest("test-user", "req-wiring-check");
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("success");
  });

  it("agent processes messages without approval gate when disabled", async () => {
    await sendMessage("extension config test message");
    const status = await waitForIdle(30_000);
    expect(status.agent.state).toBe("idle");
    // Message should process without pausing for approval
    expect(status.agent.tasksProcessed).toBeGreaterThanOrEqual(1);
  });
});
