/** Return the canonical local key used for a cloud server. */
export function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/u, "");
}
