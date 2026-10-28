import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { t } from "./i18n";
import "./overflow-filters.css";

export function OverflowFilters({ items, value, onChange, allValue, allLabel, label, moreLabel, className = "" }: {
  items: { id: string; label: ReactNode; title?: string; count?: number }[];
  allValue: string;
  allLabel: string;
  label: string;
  moreLabel: string;
  className?: string;
  value: string;
  onChange: (provider: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = useRef(new Map<string, HTMLButtonElement>());
  const openAtEnd = useRef(false);
  const menuId = useId();
  // Session counts cover the whole workspace. Without counts, retain source order.
  // Preserve that order among shortcuts so count changes do not swap their positions.
  const commonIds = new Set([...items].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, 3).map(p => p.id));
  const common = items.filter(p => commonIds.has(p.id));
  const more = items.filter(p => !commonIds.has(p.id));
  const selected = more.find(p => p.id === value);

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const buttons = Array.from(options.current.values());
    (openAtEnd.current ? buttons.at(-1) : options.current.get(value) || buttons[0])?.focus();
    const outside = (event: Event) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open, value]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(options.current.values());
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  return (
    <div className={`overflow-filters ${className}`} role="group" aria-label={label} ref={container}>
      <button type="button" className={value === allValue ? "on" : ""} aria-pressed={value === allValue}
        onClick={() => { close(); onChange(allValue); }}>{allLabel}</button>
      {common.map(p => (
        <button key={p.id} title={p.title} type="button" className={value === p.id ? "on" : ""} aria-pressed={value === p.id}
          onClick={() => { close(); onChange(p.id); }}>
          <span className="overflow-filter-label">{p.label}</span>
        </button>
      ))}
      {more.length > 0 && (
        <>
          <button type="button" ref={trigger} title={selected?.title} className={`overflow-filter-more${selected ? " on" : ""}`}
            aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
            onClick={() => { openAtEnd.current = false; setOpen(!open); }}
            onKeyDown={event => {
              if (["ArrowDown", "ArrowUp"].includes(event.key)) {
                event.preventDefault();
                openAtEnd.current = event.key === "ArrowUp";
                setOpen(true);
              } else if (event.key === "Escape") close();
            }}>
            {selected ? <span className="overflow-filter-label">{selected.label}</span> : t("更多 · {0}", more.length)}
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          {open && (
            <div id={menuId} className="overflow-filter-menu" role="menu" aria-label={moreLabel} onKeyDown={onKeyDown}>
              {more.map(p => (
                <button key={p.id} title={p.title} type="button" role="menuitemradio" aria-checked={p.id === value}
                  ref={node => { if (node) options.current.set(p.id, node); else options.current.delete(p.id); }}
                  onClick={() => { close(true); onChange(p.id); }}>
                  <span className="overflow-filter-label">{p.label}</span>
                  {p.id === value && <Check size={14} aria-hidden="true" />}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
