import { Tool } from "../interfaces";
import { ToolOutput } from "../types";
import * as os from "os";

export class SystemInfoTool implements Tool {
  name() {
    return "system_info";
  }
  description() {
    return (
      "Get current system information: date, time, timezone, " +
      "platform, hostname, and Node.js version."
    );
  }
  parametersSchema() {
    return { type: "object", properties: {} };
  }
  requiresSanitization() {
    return false;
  }
  requiresApproval() {
    return false;
  }

  async execute(): Promise<ToolOutput> {
    const startTime = Date.now();
    const info = {
      datetime: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      nodeVersion: process.version,
      uptime: `${Math.floor(process.uptime())}s`,
    };
    return {
      content: JSON.stringify(info, null, 2),
      duration_ms: Date.now() - startTime,
      is_error: false,
    };
  }
}
