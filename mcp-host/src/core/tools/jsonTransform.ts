import { Tool } from "../interfaces";
import { ToolOutput } from "../types";

export class JsonTransformTool implements Tool {
  name() {
    return "json_transform";
  }
  description() {
    return (
      "Parse, query, and transform JSON data. " +
      "Supports parsing JSON strings, extracting nested values by dot-path, " +
      "and basic transformations (keys, values, filter, map)."
    );
  }
  parametersSchema() {
    return {
      type: "object",
      properties: {
        input: { type: "string", description: "JSON string to process" },
        operation: {
          type: "string",
          enum: ["parse", "get", "keys", "values", "length", "stringify"],
          description: "Operation to perform",
        },
        path: {
          type: "string",
          description:
            "Dot-separated path for 'get' operation (e.g., 'data.items.0.name')",
        },
      },
      required: ["input", "operation"],
    };
  }
  requiresSanitization() {
    return false;
  }
  requiresApproval() {
    return false;
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const startTime = Date.now();
    const input = params.input as string;
    const operation = params.operation as string;
    const dotPath = params.path as string | undefined;

    let parsed: any;
    try {
      parsed = JSON.parse(input);
    } catch (err) {
      return {
        content: `Error parsing JSON: ${(err as Error).message}`,
        duration_ms: Date.now() - startTime,
        is_error: true,
      };
    }

    try {
      let result: any;
      switch (operation) {
        case "parse":
          result = parsed;
          break;
        case "get":
          result = dotPath ? this.getByPath(parsed, dotPath) : parsed;
          break;
        case "keys":
          result = Object.keys(parsed);
          break;
        case "values":
          result = Object.values(parsed);
          break;
        case "length":
          result = Array.isArray(parsed)
            ? parsed.length
            : Object.keys(parsed).length;
          break;
        case "stringify":
          result = JSON.stringify(parsed, null, 2);
          break;
        default:
          return {
            content: `Unknown operation: ${operation}`,
            duration_ms: Date.now() - startTime,
            is_error: true,
          };
      }

      return {
        content:
          typeof result === "string" ? result : JSON.stringify(result, null, 2),
        duration_ms: Date.now() - startTime,
        is_error: false,
      };
    } catch (err) {
      return {
        content: `Transform error: ${(err as Error).message}`,
        duration_ms: Date.now() - startTime,
        is_error: true,
      };
    }
  }

  private getByPath(obj: any, path: string): any {
    return path.split(".").reduce((current, key) => {
      if (current === undefined || current === null) return undefined;
      return current[key];
    }, obj);
  }
}
