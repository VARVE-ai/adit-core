import { execFile } from "node:child_process";
import { LocalStateError } from "@varveai/adit-core";
import type { LocalSecrets } from "./secrets.js";

/** Read only the github.com account saved by gh, not a service environment token. */
export function readGitHubCliToken(): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "GH_DEBUG"]) delete env[key];
  return new Promise((resolve, reject) => {
    execFile("gh", ["auth", "token", "--hostname", "github.com"], {
      env, timeout: 15_000, maxBuffer: 8192, windowsHide: true,
    }, (error, stdout) => {
      // Never propagate command output or execFile errors: either may contain a token.
      if (error) {
        reject(new LocalStateError(error.code === "ENOENT"
          ? "GitHub CLI is not installed. Install it and sign in, or enter a token manually."
          : "Could not read the local GitHub account. Sign in to github.com with GitHub CLI and try again.", 409));
      } else resolve(stdout.trim());
    });
  });
}

export async function importGitHubCredential(
  secrets: Pick<LocalSecrets, "save">,
  workspaceId: string,
  dependencies: { readToken?: () => Promise<string>; request?: typeof fetch } = {},
): Promise<{ configured: true; account: string }> {
  const token = await (dependencies.readToken ?? readGitHubCliToken)();
  if (!token || token.length > 4096 || !/^[A-Za-z0-9_]+$/.test(token)) {
    throw new LocalStateError("The local GitHub credential is unavailable. Sign in again or enter a token manually.", 409);
  }
  let response: Response;
  try {
    response = await (dependencies.request ?? fetch)("https://api.github.com/user", {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    throw new LocalStateError("Unable to verify the GitHub account. Check your connection and try again.", 502);
  }
  if (response.status === 401) throw new LocalStateError("The local GitHub sign-in has expired. Sign in again and retry.", 401);
  if (!response.ok) throw new LocalStateError("GitHub could not verify this account. Try again later or enter a token manually.", 502);
  // Listing public Gists does not prove write access. Require the granted scope,
  // not X-Accepted-OAuth-Scopes, and never create a Gist just to test permissions.
  const scopes = response.headers.get("x-oauth-scopes");
  if (scopes === null) throw new LocalStateError("Could not confirm Gist sharing permission for this credential. Use a GitHub CLI login with the gist scope or enter a token manually.", 403);
  if (!scopes.split(",").map(scope => scope.trim()).includes("gist")) {
    throw new LocalStateError("This GitHub account lacks Gist sharing permission. Run gh auth refresh -h github.com -s gist and try again.", 403);
  }
  let account: unknown;
  try { account = await response.json(); } catch { /* Only return a fixed error below. */ }
  const user = account as { login?: unknown; id?: unknown } | undefined;
  if (!user || typeof user.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(user.login) ||
    typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new LocalStateError("GitHub returned an invalid account. The credential was not saved.", 502);
  }
  try {
    // Snapshot the verified credential in this workspace's secure storage. Later
    // gh account switches cannot silently change the publication account.
    await secrets.save(workspaceId, token);
  } catch {
    throw new LocalStateError("Unable to save the GitHub credential to secure local storage. Please try again.", 503);
  }
  return { configured: true, account: user.login };
}
