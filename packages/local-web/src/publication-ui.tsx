import { AgentLabel } from "./agent-label";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, GitCommitHorizontal, ShieldCheck } from "lucide-react";
import { getLanguage, locale, systemMessage } from "./i18n";
import { publicationError } from "./publication-errors";
import { AditMark } from "./adit-mark";
import type { ShareSnapshot } from "../../core/src/local-history/sharing-types";
import "./publications.css";
import "./sessions.css";
import { PlatformIcon } from "./platform-icon";
import { SharedSessionTimeline } from "./shared-session-timeline";
export type PublicationApi = <T = any>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
export const p = (zh: string, en: string) => getLanguage() === "zh" ? zh : en;
export const number = (v: number) => v.toLocaleString(locale());
export const publicationDate = (at: number | null, time = false) => at === null ? "—" : new Date(at).toLocaleString(locale(), { month: "short", day: "numeric", ...(time ? { hour: "2-digit", minute: "2-digit" } as const : {}) });
export const repoName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
export function PublicationMarkdown({ text, disclosure = false }: { text: string; disclosure?: boolean }) {
  return <div className="publication-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>, img: ({ alt }) => <span>{alt || p("附件", "Attachment")}</span>, em: ({ children }) => disclosure && typeof children === "string" && ["AI usage disclosure · by ADIT", "AI 使用声明 · 由 ADIT 生成"].includes(children) ? <span className="pr-adit-badge"><span>{"{><} "}{children.split(" · ")[0]}</span><span>{children.split(" · ")[1]}</span></span> : <em>{children}</em> }}>{text}</Markdown></div>;
}
export async function copyPublication(text: string) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* Local browser fallback. */ }
  const field = document.createElement("textarea");
  field.value = text; field.readOnly = true; field.style.cssText = "position:fixed;left:-10000px";
  document.body.appendChild(field);
  try { field.select(); if (!document.execCommand("copy")) throw new Error("Clipboard unavailable"); }
  finally { field.remove(); }
}
export function PublicationCopy({ text, label }: { text?: string; label: string }) {
  const [state, setState] = useState("idle");
  const revision = useRef(0), timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => { revision.current++; setState("idle"); return () => { revision.current++; clearTimeout(timer.current); }; }, [text]);
  return <button disabled={!text || state === "copying"} onClick={async () => { const current = revision.current; setState("copying"); try { await copyPublication(text!); if (current === revision.current) setState("done"); } catch { if (current === revision.current) setState("failed"); } timer.current = setTimeout(() => { if (current === revision.current) setState("idle"); }, 2500); }}>
    {state === "done" ? <Check size={14} /> : <Copy size={14} />}<span aria-live="polite">{state === "copying" ? p("复制中…", "Copying…") : state === "done" ? p("已复制", "Copied") : state === "failed" ? p("复制失败，请重试", "Copy failed. Try again") : label}</span>
  </button>;
}
export function PublicationError({ error }: { error: string }) {
  return error ? <p className="publication-error" role="alert">{publicationError(systemMessage(error.replace(/^Error:\s*/, "")))}</p> : null;
}
export function PublicationAgent({ provider }: { provider: string }) {
  const compact = ["claude", "codex"].includes(provider);
  return <PlatformIcon platform={provider} size={compact ? 12 : 13} className={compact ? "session-agent-icon" : undefined} />;
}
export function SharedSessionView({ snapshot: s, review = false }: { snapshot: ShareSnapshot; review?: boolean }) {
  return <article className={`shared-session ${review ? "review" : ""}`}>
    {!review && <div className="shared-brand"><AditMark /> <span>{p("ADIT · 分享的 AI 会话", "ADIT · Shared AI session")}</span></div>}
    <h1>{s.title}</h1>
    <div className="publication-meta"><span><AgentLabel provider={s.provider} name={s.agent} /></span>{s.models.map(m => <code key={m}>{m}</code>)}<span>{publicationDate(s.date)}</span><span>{s.promptCount} {p("轮提问", "prompts")}</span><span><GitCommitHorizontal size={13} />{s.commitCount} {p("个提交", "commits")}</span></div>
    {!review && <p className="shared-reviewed"><ShieldCheck size={14} />{p("作者分享前检查过内容，本机路径和会话文件名已遮盖", "The author reviewed this session before sharing. Local paths and session filenames have been redacted.")}</p>}
    <SharedSessionTimeline snapshot={s} />
    {s.costMicrousd !== undefined && <p>{p("花费", "Cost")}: {s.costMicrousd === null ? p("未知", "Unknown") : `$${(s.costMicrousd / 1e6).toFixed(2)}`}{s.costIncomplete && ` · ${p("用量不完整", "Incomplete usage")}`}</p>}
    {!review && <footer><span>{p("这是作者用 ADIT 分享的 AI 会话", "An AI session shared by its author with ADIT")}</span><span>{p("用 ADIT 整理和分享你自己的 AI 会话", "Organize and share your own AI sessions with ADIT")}</span></footer>}
  </article>;
}
