import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useLanguage } from "./i18n";
import { SharedSessionView, PublicationError, p } from "./publication-ui";
import type { ShareSnapshot } from "../../core/src/local-history/sharing-types";
import { validateShareSnapshot } from "./share-snapshot";
import "./style.css";
import "./sessions.css";

/** Standalone static entry: never talks to the author's local API or requests their credentials. */
function Reader() {
  const [language, setLanguage] = useLanguage(), [snapshot, setSnapshot] = useState<ShareSnapshot>(), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const params = new URLSearchParams(location.hash.slice(1)), gist = params.get("gist"), revision = params.get("revision");
        if (!gist || !revision || !/^[a-f0-9]{5,64}$/i.test(gist) || !/^[a-f0-9]{40,64}$/i.test(revision)) throw new Error("Invalid share link");
        const response = await fetch(`https://api.github.com/gists/${gist}/${revision}`, { signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer" });
        if (!response.ok) throw new Error("This shared session is unavailable or GitHub’s rate limit was reached.");
        const data = await response.json(), file = data.files?.["adit-session.json"];
        if (!file) throw new Error("The shared session file is missing.");
        let text = file.content;
        if (file.truncated) {
          const raw = new URL(file.raw_url);
          if (raw.protocol !== "https:" || raw.hostname !== "gist.githubusercontent.com" || !raw.pathname.includes(`/raw/${revision}/`)) throw new Error("Invalid shared content source");
          const content = await fetch(raw.href, { signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer" });
          if (!content.ok) throw new Error("Unable to load shared content");
          text = await content.text();
        }
        if (typeof text !== "string" || text.length > 8 * 1024 * 1024) throw new Error("Invalid shared session size");
        const parsed = JSON.parse(text);
        if (!validateShareSnapshot(parsed)) throw new Error("Unsupported shared session format");
        setSnapshot(parsed);
      } catch (e) { if (!controller.signal.aborted) setError(String(e)); }
    })();
    return () => controller.abort();
  }, []);
  return <div className="share-reader-shell" style={{ overflow: "auto", padding: "12px 32px", height: "100%" }}><div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}><button onClick={() => setLanguage(language === "en" ? "zh" : "en")}>{language === "en" ? "中文" : "English"}</button></div><PublicationError error={error} />{snapshot ? <SharedSessionView snapshot={snapshot} /> : !error && <p>{p("正在加载…", "Loading…")}</p>}</div>;
}
createRoot(document.getElementById("root")!).render(<Reader />);
