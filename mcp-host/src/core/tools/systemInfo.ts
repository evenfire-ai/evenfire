import { Tool } from "../interfaces";
import { ToolOutput } from "../types";
import * as os from "os";
import { currentHostLocale } from "../../locale/hostLocale";
import { zonedTimestamp } from "../../locale/localeFormat";

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
    const now = new Date();
    // The host's time zone (Host spec.locale), never the server's.
    const { timeZone } = currentHostLocale();
    const info = {
      datetime: now.toISOString(),
      localTime: zonedTimestamp(timeZone, now),
      timezone: timeZone,
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
