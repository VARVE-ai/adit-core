import { string } from "./types.js";

// Match agentsview's zedFirstFolderPath: Zed stores plain paths, separated
// by newline or NUL, rather than a JSON array.
export function zedFirstFolderPath(value: unknown): string {
  const paths = string(value).trim();
  for (const separator of ["\n", "\0"]) {
    const index = paths.indexOf(separator);
    if (index >= 0) return paths.slice(0, index).trim();
  }
  return paths;
}
