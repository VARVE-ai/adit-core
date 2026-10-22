import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export function HeaderStatusPopover({ label, title, workspaceName, icon, status, children }: {
  label: string; title: string; workspaceName?: string; icon: ReactNode;
  status?: "done" | "working" | "warning"; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const rect = container.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(320, window.innerWidth - 24);
      setLeft(Math.max(12 - rect.left, Math.min(0, window.innerWidth - 12 - rect.left - width)));
    }
    panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: Event) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  return <div className="header-status" ref={container} onKeyDown={event => {
    if (event.key === "Escape" && open) {
      event.preventDefault(); setOpen(false); trigger.current?.focus();
    }
  }}>
    <button ref={trigger} type="button" className="icon header-status-trigger" title={label}
      aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)}>
      {icon}{status && <span className={`header-status-dot ${status}`} aria-hidden="true" />}
    </button>
    {open && <div ref={panel} id={id} className="header-status-panel" role="region" aria-label={title} style={{ left }}>
      <h3>{title}{workspaceName && <span title={workspaceName}>{workspaceName}</span>}</h3>
      {children}
    </div>}
  </div>;
}
