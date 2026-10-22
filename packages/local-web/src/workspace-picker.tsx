import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Folder, Search } from "lucide-react";
import { t } from "./i18n";

type WorkspaceOption = { id: string; name: string; path: string };

export function WorkspacePicker({ workspaces, selectedId, onSelect }: {
  workspaces: WorkspaceOption[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const selected = workspaces.find(w => w.id === selectedId);
  const normalized = query.trim().toLocaleLowerCase();
  const visible = workspaces.filter(w =>
    !normalized || `${w.name}\n${w.path}`.toLocaleLowerCase().includes(normalized),
  );

  const close = (restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: Event) => {
      if (!container.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    const inSearch = event.target === search.current;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
      (inSearch && ["Home", "End"].includes(event.key))) return;
    event.preventDefault();
    const options = Array.from(container.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') || []);
    if (!options.length) return;
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
      : current < 0 ? (event.key === "ArrowUp" ? options.length - 1 : 0)
      : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next].focus();
  };

  return (
    <div className="workspace-picker" ref={container}>
      <button ref={trigger} type="button" className="workspace-picker-trigger"
        aria-label={t("当前工作目录")} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? menuId : undefined} title={selected?.path}
        onClick={() => { setOpen(!open); setQuery(""); }}
        onKeyDown={event => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
          } else if (event.key === "Escape") close();
        }}>
        <Folder size={14} aria-hidden="true" />
        <span>{selected?.name || t("工作目录")}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId} className="workspace-picker-menu" role="menu" aria-label={t("工作目录")} onKeyDown={onKeyDown}>
          <label className="workspace-picker-search">
            <Search size={14} aria-hidden="true" />
            <input ref={search} value={query} placeholder={t("搜索工作目录…")}
              aria-label={t("搜索工作目录…")} onChange={event => setQuery(event.target.value)} />
          </label>
          <div className="workspace-picker-options">
            {visible.map(w => (
              <button key={w.id} type="button" role="menuitemradio" aria-checked={w.id === selectedId}
                title={w.path} onClick={() => { close(true); onSelect(w.id); }}>
                <Folder size={14} aria-hidden="true" />
                <span>{w.name}</span>
                {w.id === selectedId && <Check size={14} aria-hidden="true" />}
              </button>
            ))}
            {!visible.length && <p className="workspace-picker-empty" role="status">
              {t(workspaces.length ? "没有匹配的工作目录" : "暂无工作目录")}
            </p>}
          </div>
        </div>
      )}
    </div>
  );
}
