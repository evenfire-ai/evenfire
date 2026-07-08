import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emitLog, initLogger } from "../../src/status-reporter/logger";

describe("logger", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    initLogger("corr-123", "test-wf");
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it("emits structured JSON to stdout", () => {
    emitLog("info", "hello");
    expect(writeSpy).toHaveBeenCalledOnce();
    const output = writeSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("hello");
  });

  it("includes correlationId and workflowName", () => {
    emitLog("debug", "test");
    const parsed = JSON.parse(writeSpy.mock.calls[0][0] as string);
    expect(parsed.correlationId).toBe("corr-123");
    expect(parsed.workflowName).toBe("test-wf");
  });

  it("includes timestamp in ISO format", () => {
    emitLog("warn", "test");
    const parsed = JSON.parse(writeSpy.mock.calls[0][0] as string);
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("includes context when provided", () => {
    emitLog("error", "fail", { stepId: "s1", extra: "data" });
    const parsed = JSON.parse(writeSpy.mock.calls[0][0] as string);
    expect(parsed.context.extra).toBe("data");
    expect(parsed.stepId).toBe("s1");
  });

  it("omits context when not provided", () => {
    emitLog("info", "clean");
    const parsed = JSON.parse(writeSpy.mock.calls[0][0] as string);
    expect(parsed.context).toBeUndefined();
  });

  it("outputs valid JSON with newline", () => {
    emitLog("info", "newline test");
    const output = writeSpy.mock.calls[0][0] as string;
    expect(output.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("handles all log levels", () => {
    const levels = ["debug", "info", "warn", "error"] as const;
    for (const level of levels) {
      emitLog(level, `${level} message`);
    }
    expect(writeSpy).toHaveBeenCalledTimes(4);
  });
});
