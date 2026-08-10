import { describe, it, expect } from "vitest";
import { getDisplayName, sanitizeError, extractToolIntent } from "../intentExtraction.js";

describe("getDisplayName", () => {
  it("extracts and capitalizes MCP server name from double-underscore tool name", () => {
    expect(getDisplayName("mongodb__findDocuments")).toBe("Mongodb");
    expect(getDisplayName("airtable__getRecords")).toBe("Airtable");
  });

  it("maps native tools to human-friendly names", () => {
    expect(getDisplayName("file_read")).toBe("File System");
    expect(getDisplayName("file_write")).toBe("File System");
    expect(getDisplayName("shell_exec")).toBe("Shell");
    expect(getDisplayName("http_request")).toBe("HTTP");
    expect(getDisplayName("system_info")).toBe("System");
    expect(getDisplayName("json_transform")).toBe("Data Transform");
    expect(getDisplayName("memory_read")).toBe("Memory");
    expect(getDisplayName("memory_write")).toBe("Memory");
  });

  it("falls back to raw name for unmapped tools without double-underscore", () => {
    expect(getDisplayName("unknown_tool")).toBe("unknown_tool");
  });
});

describe("sanitizeError", () => {
  it("returns simple error messages as-is", () => {
    expect(sanitizeError("Connection refused")).toBe("Connection refused");
  });

  it("strips stack traces (lines starting with 'at ')", () => {
    const input = "Error: ECONNREFUSED\n    at Socket.connect\n    at TCPConnectWrap.afterConnect";
    expect(sanitizeError(input)).toBe("Error: ECONNREFUSED");
  });

  it("strips lines containing file paths", () => {
    const input = "TypeError: x is not a function\n/usr/src/app/index.js:42:5";
    expect(sanitizeError(input)).toBe("TypeError: x is not a function");
  });

  it("truncates to 200 characters", () => {
    const longMessage = "A".repeat(250);
    const result = sanitizeError(longMessage);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it("strips XML/HTML tags like tool_output wrappers", () => {
    const input = '<tool_output name="http_request" sanitized="false"> HTTP 400 {"code":400,"message":"Unknown parameter"} </tool_output>';
    const result = sanitizeError(input);
    expect(result).not.toContain("<tool_output");
    expect(result).not.toContain("</tool_output>");
    expect(result).toContain("HTTP 400");
    expect(result).toContain("Unknown parameter");
  });

  it("handles empty/null-like content", () => {
    expect(sanitizeError("")).toBe("");
    expect(sanitizeError(null as unknown as string)).toBe("");
  });
});

describe("extractToolIntent", () => {
  it("returns null when no LLM text content is provided", () => {
    expect(extractToolIntent(null, "mongodb__find")).toBeNull();
    expect(extractToolIntent("", "mongodb__find")).toBeNull();
  });

  it("extracts sentence mentioning the tool's server name", () => {
    const text = "Let me search MongoDB for your recent orders. I'll also check Airtable for inventory.";
    expect(extractToolIntent(text, "mongodb__findDocuments")).toBe(
      "Let me search MongoDB for your recent orders."
    );
    expect(extractToolIntent(text, "airtable__getRecords")).toBe(
      "I'll also check Airtable for inventory."
    );
  });

  it("matches case-insensitively", () => {
    const text = "I'll query the mongodb database now.";
    expect(extractToolIntent(text, "mongodb__find")).toBe(
      "I'll query the mongodb database now."
    );
  });

  it("returns null when no sentence matches the tool name", () => {
    const text = "Let me look that up for you.";
    expect(extractToolIntent(text, "mongodb__find")).toBeNull();
  });

  it("handles native tool names by matching individual words from the tool name", () => {
    const text = "I'll read the file to check the contents.";
    expect(extractToolIntent(text, "file_read")).toBe(
      "I'll read the file to check the contents."
    );
  });
});
