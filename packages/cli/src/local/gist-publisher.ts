import { LocalStateError, publicationDigest, type LocalWorkspace, type LocalSharing } from "@varveai/adit-core";
import type { LocalSecrets } from "./secrets.js";
import { renderShareHtml } from "./share-html.js";
type Gist = { id: string; html_url: string; description: string; history?: { version: string }[]; files?: Record<string, { content?: string; truncated?: boolean; raw_url?: string }> };

/** The only network boundary for local session publication. Never used by preview. */
export class GistPublisher {
  constructor(private sharing: LocalSharing, private secrets: Pick<LocalSecrets, "read">, private request: typeof fetch = fetch, private viewerBase = process.env.ADIT_SHARE_VIEWER_URL || "") {}
  async publish(w: LocalWorkspace, id: string, input: { version: string; digest: string; idempotencyKey: string }) {
    let reader: URL | undefined;
    if (this.viewerBase) {
      try { reader = new URL(this.viewerBase); } catch { throw new LocalStateError("The configured share reader must use a public HTTPS address", 503); }
      if (reader.protocol !== "https:" || reader.username || reader.password) throw new LocalStateError("The configured share reader must use a public HTTPS address", 503);
    }
    const token = await this.secrets.read(w.id);
    const draft = this.sharing.beginPublish(w, id, input.version, input.digest, input.idempotencyKey);
    if (draft.alreadyPublished) return draft;
    const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "content-type": "application/json" };
    const marker = `ADIT share ${draft.version}`;
    let postStarted = false, responseConfirmed = false;
    const api = async (path: string, init: RequestInit = {}) => {
      const response = await this.request(`https://api.github.com${path}`, { ...init, headers, signal: AbortSignal.timeout(30000) });
      if (!response.ok) {
        if (response.status === 401) throw new LocalStateError("The GitHub Gist token is invalid or expired", 401);
        if (response.status === 403 || response.status === 429) throw new LocalStateError("GitHub denied publication or its rate limit was reached", 429);
        throw new LocalStateError("GitHub could not complete publication", 502);
      }
      return response;
    };
    try {
      const html = await renderShareHtml(draft.snapshot);
      let gist: Gist | undefined;
      if (draft.reconcile) {
        // A timed-out POST may have succeeded. Never create a second Gist until reconciled.
        for (let page = 1; page <= 10; page++) {
          const recent = await (await api(`/gists?per_page=100&page=${page}`)).json() as Gist[];
          gist = recent.find(g => g.description?.includes(marker));
          if (gist || recent.length < 100) break;
        }
        if (!gist) throw new LocalStateError("The previous publication result is still unknown. Check your GitHub Gists before trying again.", 409);
      } else {
        postStarted = true;
        const response = await this.request("https://api.github.com/gists", { method: "POST", headers, signal: AbortSignal.timeout(30000), body: JSON.stringify({
          public: false, description: `${marker} · ${draft.snapshot.title}`.slice(0, 500), files: {
            "adit-session.html": { content: html },
            "adit-session.json": { content: JSON.stringify(draft.snapshot) },
          },
        }) });
        responseConfirmed = response.status < 500;
        if (!response.ok) {
          if (response.status === 401) throw new LocalStateError("The GitHub Gist token is invalid or expired", 401);
          if (response.status === 403 || response.status === 429) throw new LocalStateError("GitHub denied publication or its rate limit was reached", 429);
          throw new LocalStateError("GitHub could not complete publication", 502);
        }
        responseConfirmed = false; // A successful remote create must remain reconcilable if persistence fails.
        gist = await response.json() as Gist;
      }
      if (!gist || !/^[a-f0-9]+$/i.test(gist.id) || !/^https:\/\/gist\.github\.com\//.test(gist.html_url)) throw new Error("Invalid Gist response");
      const full = gist.history?.[0]?.version ? gist : await (await api(`/gists/${gist.id}`)).json() as Gist;
      const revision = full.history?.[0]?.version;
      if (!revision || !/^[a-f0-9]+$/i.test(revision)) throw new Error("Missing Gist revision");
      let hasHtml = !draft.reconcile;
      if (draft.reconcile) {
        const fixed = await (await api(`/gists/${gist.id}/${revision}`)).json() as Gist;
        const readContent = async (name: string) => {
          const file = fixed.files?.[name];
          if (!file?.truncated) return file?.content;
          if (!file.raw_url) throw new Error("Missing Gist content source");
          const raw = new URL(file.raw_url);
          if (raw.protocol !== "https:" || raw.hostname !== "gist.githubusercontent.com" || raw.username || raw.password || !raw.pathname.endsWith(`/${gist.id}/raw/${revision}/${name}`)) throw new Error("Invalid Gist content source");
          const response = await this.request(raw.href, { signal: AbortSignal.timeout(30000), credentials: "omit", referrerPolicy: "no-referrer" });
          if (!response.ok) throw new Error("Unable to verify Gist content");
          return response.text();
        };
        const content = await readContent("adit-session.json");
        if (!content || content.length > 8 * 1024 * 1024 || publicationDigest(content.trim()) !== draft.digest) throw new LocalStateError("The remote share no longer matches the reviewed preview. Check your GitHub Gist.", 409);
        hasHtml = !!fixed.files?.["adit-session.html"];
        if (hasHtml && await readContent("adit-session.html") !== html) throw new LocalStateError("The remote share no longer matches the reviewed preview. Check your GitHub Gist.", 409);
      }
      let viewer: string | null = null;
      if (reader) {
        reader.hash = new URLSearchParams({ gist: gist.id, revision }).toString(); viewer = reader.href;
      } else if (hasHtml) {
        const url = new URL(gist.html_url);
        const [owner, remoteId] = url.pathname.split("/").filter(Boolean);
        if (url.hostname !== "gist.github.com" || !/^[\w-]+$/.test(owner) || remoteId !== gist.id) throw new Error("Invalid Gist owner");
        viewer = `https://htmlpreview.github.io/?https://gist.githubusercontent.com/${owner}/${gist.id}/raw/${revision}/adit-session.html`;
      }
      return this.sharing.published(w, id, input.idempotencyKey, { id: gist.id, url: gist.html_url, revision, viewer });
    } catch (e) {
      const message = e instanceof LocalStateError ? e.message : "Could not confirm publication. Check the connection and try again.";
      this.sharing.failed(w, id, input.idempotencyKey, message, !!draft.reconcile || (postStarted && !responseConfirmed));
      throw e instanceof LocalStateError ? e : new LocalStateError(message, 502);
    }
  }
}
