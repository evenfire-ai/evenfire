import { describe, it, expect, vi } from "vitest";
import { CompositeToolRegistry, McpToolRegistryAdapter } from "../toolRegistryAdapter";
import type { ToolRegistry, Tool } from "../../interfaces";
import type { ToolOutput } from "../../types";

function createMockTool(
  toolName: string,
  opts: { sanitize?: boolean; approval?: boolean; output?: string } = {},
): Tool {
  return {
    name: () => toolName,
    description: () => `Mock ${toolName}`,
    parametersSchema: () => ({ type: "object", properties: {} }),
    execute: vi.fn(async (): Promise<ToolOutput> => ({
      content: opts.output ?? `${toolName} result`,
      duration_ms: 10,
      is_error: false,
    })),
    requiresSanitization: () => opts.sanitize ?? true,
    requiresApproval: () => opts.approval ?? false,
  };
}

function createMockRegistry(tools: Tool[]): ToolRegistry {
  const map = new Map(tools.map((t) => [t.name(), t]));
  return {
    get: (name: string) => map.get(name) ?? null,
    listDefinitions: () =>
      tools.map((t) => ({
        name: t.name(),
        description: t.description(),
        parameters: t.parametersSchema(),
      })),
    register: vi.fn(),
  };
}

describe("CompositeToolRegistry", () => {
  it("should resolve native tools before MCP tools (Risk 3.5.6)", () => {
    const nativeTool = createMockTool("file_read");
    const mcpTool = createMockTool("server__file_read");

    const nativeRegistry = createMockRegistry([nativeTool]);
    const mcpRegistry = createMockRegistry([mcpTool]);
    const composite = new CompositeToolRegistry(nativeRegistry, mcpRegistry);

    // Native tool found by plain name
    expect(composite.get("file_read")).toBe(nativeTool);
    // MCP tool found by prefixed name
    expect(composite.get("server__file_read")).toBe(mcpTool);
  });

  it("should merge definitions from both registries", () => {
    const nativeRegistry = createMockRegistry([createMockTool("file_read")]);
    const mcpRegistry = createMockRegistry([
      createMockTool("mongo__find"),
      createMockTool("mongo__insert"),
    ]);
    const composite = new CompositeToolRegistry(nativeRegistry, mcpRegistry);

    const defs = composite.listDefinitions();
    expect(defs).toHaveLength(3);
    expect(defs.map((d) => d.name)).toContain("file_read");
    expect(defs.map((d) => d.name)).toContain("mongo__find");
  });

  it("should return provider-agnostic ToolDefinition format (Risk 4.7)", () => {
    const tool = createMockTool("search");
    const registry = createMockRegistry([tool]);
    const defs = registry.listDefinitions();

    // Must have name, description, parameters — NOT provider-specific fields
    expect(defs[0]).toHaveProperty("name");
    expect(defs[0]).toHaveProperty("description");
    expect(defs[0]).toHaveProperty("parameters");
    expect(defs[0]).not.toHaveProperty("type"); // Not OpenAI format
    expect(defs[0]).not.toHaveProperty("input_schema"); // Not Claude format
  });
});

describe("McpToolRegistryAdapter", () => {
  it("extracts JPEG attachments from MCP content blocks", async () => {
    const mockManager = {
      getAllTools: () => [
        {
          name: "playwright-server__browser_take_screenshot",
          description: "Take screenshot",
          inputSchema: { type: "object" },
          serverName: "playwright-server",
        },
      ],
      callTool: vi.fn(async () => ({
        toolName: "playwright-server__browser_take_screenshot",
        result: {
          content: [
            { type: "text", text: "Screenshot captured successfully." },
            {
              type: "image",
              mimeType: "image/jpeg",
              data: "Zm9v",
              filename: "page.jpg",
              width: 1440,
              height: 900,
            },
          ],
        },
        isError: false,
      })),
    } as any;

    const registry = new McpToolRegistryAdapter(mockManager);
    const tool = registry.get("playwright-server__browser_take_screenshot");
    expect(tool).not.toBeNull();

    const output = await tool!.execute({});
    expect(output.is_error).toBe(false);
    expect(output.content).toContain("Screenshot captured successfully.");
    expect(output.attachments).toHaveLength(1);
    expect(output.attachments?.[0]).toMatchObject({
      kind: "image",
      mimeType: "image/jpeg",
      encoding: "base64",
      dataBase64: "Zm9v",
      filename: "page.jpg",
      width: 1440,
      height: 900,
      sourceTool: "playwright-server__browser_take_screenshot",
    });
  });

  it("uses a text summary when MCP content contains only images", async () => {
    const mockManager = {
      getAllTools: () => [
        {
          name: "playwright-server__browser_take_screenshot",
          description: "Take screenshot",
          inputSchema: { type: "object" },
          serverName: "playwright-server",
        },
      ],
      callTool: vi.fn(async () => ({
        toolName: "playwright-server__browser_take_screenshot",
        result: {
          content: [
            {
              type: "image",
              mimeType: "image/jpeg",
              data: "c2VjcmV0LWJhc2U2NA==",
            },
          ],
        },
        isError: false,
      })),
    } as any;

    const registry = new McpToolRegistryAdapter(mockManager);
    const tool = registry.get("playwright-server__browser_take_screenshot");
    expect(tool).not.toBeNull();

    const output = await tool!.execute({});
    expect(output.content).toBe("Generated 1 JPEG attachment(s).");
    expect(output.content).not.toContain("c2VjcmV0LWJhc2U2NA==");
    expect(output.attachments).toHaveLength(1);
    expect(output.attachments?.[0].dataBase64).toBe("c2VjcmV0LWJhc2U2NA==");
  });
});
