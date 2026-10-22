import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import type { SessionTurnEdit } from "../../core/src/local-history/session-browser";
import { sc } from "./sessions-copy";
import { systemMessage } from "./i18n";

export function SessionTurnActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const open = () => {
    const rect = trigger.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(rect.right - 176, window.innerWidth - 184)),
      top: rect.bottom + 92 > window.innerHeight ? Math.max(8, rect.top - 92) : rect.bottom + 6 });
  };
  useEffect(() => {
    if (!position) return;
    const items = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') || []);
    items()[0]?.focus({ preventScroll: true });
    const close = () => setPosition(undefined);
    const outside = (e: Event) => { if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) close(); };
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Tab') {
        if (e.key === 'Escape') e.preventDefault();
        close(); trigger.current?.focus({ preventScroll: true });
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        const buttons = items(), at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', keydown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', keydown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [position]);
  const select = (action: () => void) => { setPosition(undefined); trigger.current?.focus({ preventScroll: true }); action(); };
  return <>
    <button ref={trigger} className="session-turn-more" title={sc("本轮操作")} aria-label={sc("本轮操作")} aria-haspopup="menu" aria-expanded={!!position}
      onClick={() => position ? setPosition(undefined) : open()} onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); open(); } }}>
      <MoreHorizontal size={16} />
    </button>
    {position && createPortal(<div ref={menu} className="session-turn-menu" role="menu" aria-label={sc("本轮操作")} style={position}>
      <button role="menuitem" onClick={() => select(onEdit)}><Pencil size={14} />{sc("修改本轮")}</button>
      <button role="menuitem" className="danger" onClick={() => select(onDelete)}><Trash2 size={14} />{sc("删除本轮")}</button>
    </div>, document.body)}
  </>;
}

export function SessionTurnEditor({ kind, prompt, read, mutate, onClose, onDone }: {
  kind: 'edit' | 'delete'; prompt: string;
  read: () => Promise<SessionTurnEdit>;
  mutate: (method: 'PATCH' | 'DELETE', body: unknown) => Promise<unknown>;
  onClose: () => void; onDone: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<SessionTurnEdit>(), [texts, setTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    let current = true;
    setLoading(true); setError('');
    read().then(value => { if (current) { setDraft(value); setTexts(Object.fromEntries(value.blocks.map(b => [b.id, b.text]))); } })
      .catch(e => { if (current) setError(String(e)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [attempt]);
  const changes = draft?.blocks.filter(b => texts[b.id] !== b.text).map(b => ({ id: b.id, text: texts[b.id] })) || [];
  const currentPrompt = draft ? draft.blocks.filter(b => b.kind === 'prompt').map(b => b.text).join('\n') : prompt;
  const save = async () => {
    if (!draft || busy) return;
    setBusy(true); setError('');
    try { await mutate(kind === 'edit' ? 'PATCH' : 'DELETE', { revision: draft.revision, ...(kind === 'edit' ? { changes } : {}) }); onDone(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  let reply = 0, question = 0;
  return createPortal(<dialog ref={dialog} className={`session-turn-dialog ${kind}`} aria-labelledby="session-turn-editor-title"
    onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id="session-turn-editor-title">{sc(kind === 'edit' ? "修改本轮对话" : "删除本轮对话")}</h2>
      <button type="button" disabled={busy} aria-label={sc("关闭")} onClick={onClose}><X size={17} /></button></header>
    <div className="session-turn-editor-body">
      {kind === 'delete' ? <>
        <p>{sc("仅删除这一轮的提问、回复和工具过程，其他轮次保留。")}</p>
        <blockquote>{currentPrompt.slice(0, 400)}{currentPrompt.length > 400 ? '…' : ''}</blockquote>
        <p className="session-muted">{sc("删除后无法在此恢复，后续采集也不会重新导入这一轮。Agent 原始记录不会被修改。")}</p>
      </> : <>
        <p className="session-muted">{sc("修改保存在 ADIT 本地。Agent 原始记录和工具过程不会被修改。")}</p>
        {draft?.blocks.map(block => <label key={block.id} className="session-turn-field">
          <span>{block.kind === 'prompt' ? (++question === 1 ? sc("提问") : sc("提问 {0}", question)) : sc("回复 {0}", ++reply)}</span>
          <textarea value={texts[block.id] ?? ''} disabled={busy || loading} spellCheck={false}
            rows={Math.min(12, Math.max(block.kind === 'prompt' ? 3 : 5, (texts[block.id] || '').split('\n').length))}
            onChange={e => setTexts(old => ({ ...old, [block.id]: e.target.value }))} />
        </label>)}
        {draft && !draft.blocks.some(b => b.kind === 'reply') && <p className="session-muted">{sc("这一轮还没有可修改的回复。")}</p>}
      </>}
      {loading && <p role="status" className="session-muted">{sc("正在加载…")}</p>}
      {error && <div className="session-turn-editor-error" role="alert">{systemMessage(error.replace(/^Error:\s*/, ''))}
        <button disabled={busy || loading} onClick={() => setAttempt(v => v + 1)}>{sc("重新加载")}</button></div>}
    </div>
    <footer><button disabled={busy} onClick={onClose}>{sc("取消")}</button>
      <button className={kind === 'delete' ? 'danger' : 'primary'} disabled={busy || loading || !draft || (kind === 'edit' && !changes.length)} onClick={() => void save()}>
        {busy ? sc("正在保存…") : sc(kind === 'edit' ? "保存修改" : "删除本轮")}</button></footer>
  </dialog>, document.body);
}
