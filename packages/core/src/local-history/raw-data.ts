const envelopes = [[], ["payload"], ["message"], ["data"], ["data", "message"]];
const fields = ["content", "text", "summary", "output", "arguments", "input", "parts"];
const contentPaths = envelopes.flatMap(envelope => fields.map(field => [...envelope, field]));

function parentAt(raw: unknown, path: string[]): Record<string, unknown> | undefined {
  let current = raw;
  for (const key of path.slice(0, -1)) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, key)) return;
    current = (current as Record<string, unknown>)[key];
  }
  if (current && typeof current === "object" && !Array.isArray(current)) return current as Record<string, unknown>;
}

export function compactHistoryRaw(rawJson: string, contentJson: string | null): { rawJson: string; pathsJson: string | null } {
  const unchanged = { rawJson, pathsJson: null };
  if (!contentJson || contentJson.length < 128) return unchanged;
  if (Buffer.byteLength(rawJson) + Buffer.byteLength(contentJson) > 16 * 1024 * 1024) return unchanged;
  let raw: unknown;
  try { raw = JSON.parse(rawJson); } catch { return unchanged; }
  if (JSON.stringify(raw) !== rawJson) return unchanged;
  const paths: string[][] = [];
  for (const path of contentPaths) {
    const parent = parentAt(raw, path), key = path[path.length - 1];
    if (parent && Object.hasOwn(parent, key) && JSON.stringify(parent[key]) === contentJson) {
      parent[key] = null;
      paths.push(path);
    }
  }
  if (!paths.length) return unchanged;
  const compacted = JSON.stringify(raw), pathsJson = JSON.stringify(paths);
  if (Buffer.byteLength(compacted) + Buffer.byteLength(pathsJson) >= Buffer.byteLength(rawJson)) return unchanged;
  return { rawJson: compacted, pathsJson };
}

export function restoreHistoryRaw(rawJson: string, content: unknown, pathsJson?: string | null): Record<string, unknown> {
  const raw = JSON.parse(rawJson);
  if (!pathsJson) return raw;
  const paths: unknown = JSON.parse(pathsJson);
  if (content === undefined || !Array.isArray(paths) || !paths.length) throw new Error("Invalid history raw content reference");
  for (const path of paths) {
    if (!Array.isArray(path) || !contentPaths.some(candidate => JSON.stringify(candidate) === JSON.stringify(path)))
      throw new Error("Invalid history raw content reference");
    const parent = parentAt(raw, path), key = path[path.length - 1];
    if (!parent || !Object.hasOwn(parent, key) || parent[key] !== null) throw new Error("Invalid history raw content reference");
    parent[key] = structuredClone(content);
  }
  return raw;
}
