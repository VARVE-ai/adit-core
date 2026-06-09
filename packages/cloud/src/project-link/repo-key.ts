const GITHUB_HOST = "github.com";

/**
 * Normalize a GitHub remote URL into the canonical Team Sharing key.
 *
 * Supported inputs:
 * - https://github.com/OWNER/REPO(.git)
 * - http://github.com/OWNER/REPO(.git)
 * - git@github.com:OWNER/REPO(.git)
 * - ssh://git@github.com/OWNER/REPO(.git)
 */
export function normalizeGitHubRepoKey(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  const input = remoteUrl.trim();
  if (!input) return null;

  const scpLike = input.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu);
  if (scpLike?.[1] && scpLike[2]) {
    return formatGitHubRepoKey(scpLike[1], scpLike[2]);
  }

  try {
    const url = new URL(input);
    if (url.hostname.toLowerCase() !== GITHUB_HOST) return null;
    const pathParts = url.pathname
      .replace(/^\/+|\/+$/gu, "")
      .split("/")
      .filter(Boolean);
    if (pathParts.length < 2) return null;
    return formatGitHubRepoKey(pathParts[0], pathParts[1]);
  } catch {
    return null;
  }
}

function formatGitHubRepoKey(owner: string, repo: string): string | null {
  const cleanOwner = owner.trim().toLowerCase();
  const cleanRepo = repo.trim().replace(/\.git$/iu, "").toLowerCase();
  if (!cleanOwner || !cleanRepo || cleanRepo.includes("/")) return null;
  return `github:${cleanOwner}/${cleanRepo}`;
}
