/**
 * Shared types for the workspace module.
 */

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modifiedAt?: string;
}

export interface SearchResult {
  path: string;
  content: string;   // matched paragraph/chunk
  score: number;     // 0.0–1.0 normalized
  lineNumber?: number;
}

export interface SearchConfig {
  limit: number;     // default: 10
  minScore: number;  // default: 0.0
}
