import { describe, it, expect, beforeEach } from "vitest";
import { NudgeController } from "../nudgeController";
import { DefaultLoopController } from "../../orchestration/loopConfig";

describe("NudgeController", () => {
  let delegate: DefaultLoopController;
  let controller: NudgeController;

  beforeEach(() => {
    delegate = new DefaultLoopController();
    controller = new NudgeController(delegate, 3);
  });

  it("should reject first text when no tools have been used (6.2a)", () => {
    // No tools executed, first text response -> reject
    expect(controller.shouldAccept("I think the answer is...", 0)).toBe(false);
    expect(controller.getNudgeCount()).toBe(0);
  });

  it("should inject nudge message when text is rejected (6.2a)", () => {
    // Reject the text
    controller.shouldAccept("I think the answer is...", 0);

    // Get the nudge message
    const nudge = controller.onTextRejected("I think the answer is...", 0);
    expect(nudge).not.toBeNull();
    expect(nudge!.role).toBe("user");
    expect(nudge!.content).toContain("tools available");
    expect(controller.getNudgeCount()).toBe(1);
  });

  it("should accept text after maxNudges reached (Risk 6.2b)", () => {
    // Exhaust all nudges
    for (let i = 0; i < 3; i++) {
      expect(controller.shouldAccept("text", i)).toBe(false);
      controller.onTextRejected("text", i);
    }

    // After 3 nudges, should accept
    expect(controller.getNudgeCount()).toBe(3);
    expect(controller.shouldAccept("final answer", 3)).toBe(true);
  });

  it("should accept text after tools have been executed (6.2c)", () => {
    // Simulate a tool being called (beforeTool sets toolsExecutedInLoop)
    controller.beforeTool("my_tool", {});
    expect(controller.hasToolsExecuted()).toBe(true);

    // Now text should be accepted
    expect(controller.shouldAccept("Result from tool analysis...", 1)).toBe(true);
  });

  it("should start fresh when a new instance is created (replaces reset)", () => {
    // Dirty up the state
    controller.beforeTool("my_tool", {});
    controller.onTextRejected("text", 0);

    expect(controller.hasToolsExecuted()).toBe(true);
    expect(controller.getNudgeCount()).toBe(1);

    // A new instance starts clean (no reset method needed)
    const fresh = new NudgeController(delegate, 3);

    expect(fresh.hasToolsExecuted()).toBe(false);
    expect(fresh.getNudgeCount()).toBe(0);
  });
});
