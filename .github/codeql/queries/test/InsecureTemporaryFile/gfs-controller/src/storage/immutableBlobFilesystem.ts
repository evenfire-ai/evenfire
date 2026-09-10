import { openSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";

export async function syncExistingPath(): Promise<void> {
  await open("/tmp/gfs-data-read-only", "r");
  await open("/tmp/gfs-data-read-synchronous", "rs");
}

export async function createWritablePath(): Promise<void> {
  await open("/tmp/gfs-data-open-w", "w");
}

export async function writeTemporaryPath(): Promise<void> {
  await writeFile("/tmp/gfs-data-write-file", "content");
}

export function createWritablePathSync(): void {
  openSync("/tmp/gfs-data-open-sync-w", "w");
}
