const NATIVE_TOOL_DISPLAY_NAMES: Record<string, string> = {
  file_read: "File System",
  file_write: "File System",
  shell_exec: "Shell",
  http_request: "HTTP",
  system_info: "System",
  json_transform: "Data Transform",
  memory_read: "Memory",
  memory_write: "Memory",
};

export function getDisplayName(toolName: string): string {
  const separatorIndex = toolName.indexOf("__");
  if (separatorIndex > 0) {
    const serverName = toolName.substring(0, separatorIndex);
    return serverName.charAt(0).toUpperCase() + serverName.slice(1);
  }
  return NATIVE_TOOL_DISPLAY_NAMES[toolName] ?? toolName;
}

const MAX_ERROR_LENGTH = 200;

export function sanitizeError(content: string | null | undefined): string {
  if (!content) return "";

  // Strip XML/HTML tags (e.g. <tool_output ...>...</tool_output>)
  const stripped = content.replace(/<[^>]+>/g, "");

  const lines = stripped.split("\n");
  const cleaned = lines.filter(
    (line) =>
      !line.trimStart().startsWith("at ") &&
      !/\/[\w.-]+\/[\w.-]+/.test(line),
  );

  const message = cleaned.join(" ").replace(/\s+/g, " ").trim();
  if (message.length <= MAX_ERROR_LENGTH) return message;
  return message.substring(0, MAX_ERROR_LENGTH - 3) + "...";
}

export function extractToolIntent(
  llmTextContent: string | null,
  toolName: string,
): string | null {
  if (!llmTextContent?.trim()) return null;

  const separatorIndex = toolName.indexOf("__");
  const keywords: string[] = [];
  if (separatorIndex > 0) {
    keywords.push(toolName.substring(0, separatorIndex));
  } else {
    keywords.push(...toolName.split("_").filter((w) => w.length > 2));
  }
  keywords.push(toolName);

  const sentences = llmTextContent.match(/[^.!?]+[.!?]+/g) ?? [llmTextContent];

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    for (const keyword of keywords) {
      if (lower.includes(keyword.toLowerCase())) {
        return sentence.trim();
      }
    }
  }

  return null;
}
