import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

const SOUL_BASE_PATH = "/etc/workflow/souls";

export async function loadSoul(storageRef: string): Promise<string> {
  if (storageRef.includes("..") || storageRef.includes("\0")) {
    throw new Error(`Invalid soul reference: ${storageRef}`);
  }
  const resolved = nodePath.resolve(SOUL_BASE_PATH, storageRef);
  if (!resolved.startsWith(SOUL_BASE_PATH + "/")) {
    throw new Error(`Soul path escapes base directory`);
  }
  return fs.readFile(resolved, "utf-8");
}
